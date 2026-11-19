import type { ServiceNowClient } from './client.js'
import { assertTableName } from './query.js'

export interface Column {
  name: string
  label: string
  type: string
  reference: string | null
  mandatory: boolean
  readOnly: boolean
  maxLength: number | null
  /** The table in the parent chain that defines this field. */
  definedOn: string
  /** Set when a dictionary override changes the field for the inspected table. */
  overriddenOn?: string
  overrides?: string[]
}

export interface TableInfo {
  name: string
  label: string
  /** The table itself first, then its parents up to the root. */
  chain: string[]
}

export interface UnknownField {
  field: string
  table: string
  segment: string
  reason: string
  suggestions: string[]
}

export interface FieldCheck {
  /** "unavailable" means the dictionary could not be read, so nothing was verified. */
  status: 'checked' | 'unavailable'
  reason?: string
  unknown: UnknownField[]
}

const PARENT_DEPTH = 8
const PARENT_FIELDS = Array.from({ length: PARENT_DEPTH }, (_, i) => `${'super_class.'.repeat(i + 1)}name`)

const OVERRIDABLE = ['mandatory', 'read_only', 'default_value', 'reference_qual', 'attributes', 'dependent', 'calculation', 'display']

/**
 * What the instance says about its own tables and fields, cached for the life of
 * the process. Used to answer schema questions and to refuse queries on fields
 * that do not exist.
 */
export class Dictionary {
  private readonly tables = new Map<string, Promise<TableInfo | null>>()
  private readonly columnMaps = new Map<string, Promise<Map<string, Column> | null>>()

  constructor(private readonly sn: ServiceNowClient) {}

  table(name: string): Promise<TableInfo | null> {
    assertTableName(name)
    return this.cached(this.tables, name, () => this.loadTable(name))
  }

  /** Own and inherited fields of a table, without dictionary overrides. null if the table is unknown. */
  columns(name: string): Promise<Map<string, Column> | null> {
    return this.cached(this.columnMaps, name, () => this.loadColumns(name))
  }

  /** The fields as they behave on this table: inherited fields included, overrides applied. */
  async effectiveColumns(name: string): Promise<{ columns: Column[]; overridesRead: boolean } | null> {
    const [info, base] = await Promise.all([this.table(name), this.columns(name)])
    if (!info || !base) return null

    const columns = new Map([...base].map(([key, column]) => [key, { ...column }]))
    let overridesRead = true
    try {
      const { records } = await this.sn.all<Record<string, string>>({
        table: 'sys_dictionary_override',
        query: `nameIN${info.chain.join(',')}`,
        fields: ['name', 'element', ...OVERRIDABLE.map((key) => `${key}_override`), 'mandatory', 'read_only'],
      })
      // Parents first, so an override closer to the inspected table wins.
      for (const table of [...info.chain].reverse()) {
        for (const row of records.filter((record) => record.name === table)) {
          const column = columns.get(row.element)
          if (!column) continue
          const changed = OVERRIDABLE.filter((key) => row[`${key}_override`] === 'true')
          if (!changed.length) continue
          if (changed.includes('mandatory')) column.mandatory = row.mandatory === 'true'
          if (changed.includes('read_only')) column.readOnly = row.read_only === 'true'
          column.overriddenOn = table
          column.overrides = changed
        }
      }
    } catch {
      overridesRead = false
    }

    return { columns: [...columns.values()], overridesRead }
  }

  /** Checks field paths (with dot-walks) against the dictionary. */
  async checkFields(table: string, paths: string[]): Promise<FieldCheck> {
    const unknown: UnknownField[] = []

    try {
      for (const path of new Set(paths)) {
        let current = table
        const segments = path.split('.')

        for (const [index, segment] of segments.entries()) {
          const columns = await this.columns(current)
          if (!columns) {
            if (index === 0) return { status: 'unavailable', reason: `table "${current}" has no dictionary entry`, unknown: [] }
            unknown.push({ field: path, table: current, segment, reason: `the referenced table "${current}" has no dictionary entry`, suggestions: [] })
            break
          }

          const column = columns.get(segment)
          if (!column) {
            unknown.push({ field: path, table: current, segment, reason: `"${segment}" is not a field of "${current}"`, suggestions: suggest(segment, columns) })
            break
          }

          if (index < segments.length - 1) {
            if (!column.reference) {
              unknown.push({ field: path, table: current, segment, reason: `"${segment}" is not a reference field, so it cannot be dot-walked`, suggestions: [] })
              break
            }
            current = column.reference
          }
        }
      }
    } catch (error) {
      return { status: 'unavailable', reason: `the dictionary could not be read (${error instanceof Error ? error.message : String(error)})`, unknown: [] }
    }

    return { status: 'checked', unknown }
  }

  private async loadTable(name: string): Promise<TableInfo | null> {
    const page = await this.sn.query<Record<string, string>>({
      table: 'sys_db_object',
      query: `name=${name}`,
      fields: ['name', 'label', ...PARENT_FIELDS],
      limit: 1,
    })
    const row = page.records[0]
    if (!row) return null

    const chain = [name]
    for (const field of PARENT_FIELDS) {
      const parent = row[field]
      if (!parent) return { name, label: row.label ?? '', chain }
      chain.push(parent)
    }

    // Deeper than one request can see: continue from the last parent found.
    const rest = await this.table(chain[chain.length - 1])
    return { name, label: row.label ?? '', chain: rest ? [...chain, ...rest.chain.slice(1)] : chain }
  }

  private async loadColumns(name: string): Promise<Map<string, Column> | null> {
    const info = await this.table(name)
    if (!info) return null

    const { records } = await this.sn.all<Record<string, string>>({
      table: 'sys_dictionary',
      query: `nameIN${info.chain.join(',')}^elementISNOTEMPTY`,
      fields: ['name', 'element', 'column_label', 'internal_type', 'reference', 'mandatory', 'read_only', 'max_length'],
    })

    const columns = new Map<string, Column>()
    // Root first, so a definition closer to the inspected table wins.
    for (const table of [...info.chain].reverse()) {
      for (const row of records.filter((record) => record.name === table)) {
        columns.set(row.element, {
          name: row.element,
          label: row.column_label ?? '',
          type: row.internal_type ?? '',
          reference: row.reference || null,
          mandatory: row.mandatory === 'true',
          readOnly: row.read_only === 'true',
          maxLength: row.max_length ? Number(row.max_length) : null,
          definedOn: table,
        })
      }
    }
    return columns
  }

  /** Caches the promise, and forgets it again if it fails, so a later call can retry. */
  private cached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
    let pending = cache.get(key)
    if (!pending) {
      pending = load()
      cache.set(key, pending)
      pending.catch(() => cache.delete(key))
    }
    return pending
  }
}

/** Field names that look like the unknown one: contained in it, containing it, or a typo away. */
function suggest(segment: string, columns: Map<string, Column>): string[] {
  const wanted = segment.replace(/^u_/, '')
  const tolerance = Math.max(2, Math.floor(wanted.length / 4))

  return [...columns.keys()]
    .map((name) => {
      const candidate = name.replace(/^u_/, '')
      const contained = candidate.length > 3 && (candidate.includes(wanted) || wanted.includes(candidate))
      return { name, score: contained ? 1 : editDistance(wanted, candidate) }
    })
    .filter((item) => item.score <= tolerance)
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, 5)
    .map((item) => item.name)
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]
      row[j] = Math.min(above + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1))
      diagonal = above
    }
  }
  return row[b.length]
}
