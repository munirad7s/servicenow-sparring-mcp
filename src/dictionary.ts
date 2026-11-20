import type { ServiceNowClient } from './client.js'
import { ServiceNowError } from './errors.js'
import { assertTableName, isTableName } from './query.js'

export interface Column {
  name: string
  label: string
  type: string
  reference: string | null
  mandatory: boolean
  readOnly: boolean
  maxLength: number | null
  /** false if the dictionary entry is deactivated. */
  active: boolean
  /** true if the field takes its values from a choice list. */
  choice: boolean
  /** The table in the parent chain that defines this field. */
  definedOn: string
  /** The nearest table whose dictionary override changes the field for the inspected table. */
  overriddenOn?: string
  overrides?: string[]
  /** For a field of a database view: its name on the table it comes from. */
  sourceField?: string
}

export interface TableInfo {
  name: string
  label: string
  /** The table itself first, then its parents up to the root. */
  chain: string[]
  /** A remote table runs a script on the instance whenever it is read. */
  kind: 'table' | 'remote_table' | 'database_view'
  /** For a database view: the tables it joins, and the prefix its fields carry. */
  members?: Array<{ table: string; prefix: string }>
}

export interface UnknownField {
  field: string
  table: string
  segment: string
  reason: string
  suggestions: string[]
}

export interface FieldCheck {
  /** "unavailable" means the dictionary could not be read completely, so not every name was verified. */
  status: 'checked' | 'unavailable'
  reason?: string
  /** Names the dictionary proves wrong. Valid even when the status is "unavailable". */
  unknown: UnknownField[]
  /** The dictionary entry of each path that was verified, keyed by the path as written. */
  resolved: Map<string, Column>
  /** Tables the paths read from besides the queried one: targets of dot-walks, child tables, tables a view joins. */
  reached: Set<string>
}

export interface Choice {
  value: string
  label: string
}

export interface ColumnSet {
  columns: Map<string, Column>
  /** true if rows of the dictionary were withheld or cut off: a missing name proves nothing. */
  partial: boolean
}

interface Entry<T> {
  value: Promise<T>
  at: number
}

const PARENT_DEPTH = 8
const PARENT_FIELDS = Array.from({ length: PARENT_DEPTH }, (_, i) => `${'super_class.'.repeat(i + 1)}name`)
const MAX_CHAIN = 32
const MAX_ENTRIES = 400

const OVERRIDABLE = ['mandatory', 'read_only', 'default_value', 'reference_qual', 'attributes', 'dependent', 'calculation', 'display']

/**
 * What the instance says about its own tables and fields. Used to answer schema
 * questions and to refuse queries on fields that do not exist.
 *
 * Entries are kept for a few minutes. A name that is missing from an entry older
 * than half a minute is looked up once more, so a field created during a session
 * is found.
 */
export class Dictionary {
  private readonly tables = new Map<string, Entry<TableInfo | null>>()
  private readonly columnSets = new Map<string, Entry<ColumnSet | null>>()
  private readonly choiceLists = new Map<string, Entry<Choice[]>>()
  private readonly labelSets = new Map<string, Entry<Map<string, string>>>()

  constructor(
    private readonly sn: ServiceNowClient,
    private readonly ttlMs = 10 * 60_000,
    private readonly recheckMs = 30_000,
  ) {}

  table(name: string, maxAgeMs = this.ttlMs): Promise<TableInfo | null> {
    assertTableName(name)
    return this.cached(this.tables, name, () => this.loadTable(name), maxAgeMs)
  }

  /** Own and inherited fields of a table, without dictionary overrides. null if the table is unknown. */
  async columns(name: string): Promise<Map<string, Column> | null> {
    return (await this.columnSet(name))?.columns ?? null
  }

  /** The fields as they behave on this table: inherited fields included, overrides applied. */
  async effectiveColumns(name: string, maxAgeMs = this.ttlMs): Promise<{ columns: Column[]; complete: boolean; overridesRead: boolean; labelsRead: boolean } | null> {
    const info = await this.table(name, maxAgeMs)
    const base = info && (await this.columnSet(name, maxAgeMs))
    if (!info || !base) return null

    const columns = new Map([...base.columns].map(([key, column]) => [key, { ...column }]))
    if (info.kind === 'database_view') return { columns: [...columns.values()], complete: !base.partial, overridesRead: true, labelsRead: true }

    // A child table can give an inherited field its own label: "Close notes" on task is "Resolution notes" on incident.
    const labels = await this.cached(this.labelSets, name, () => this.loadLabels(info.chain), maxAgeMs).catch(() => null)
    for (const [element, label] of labels ?? []) {
      const column = columns.get(element)
      if (column && label) column.label = label
    }

    let overridesRead = true
    try {
      const { records, total, complete } = await this.sn.all<Record<string, string>>({
        table: 'sys_dictionary_override',
        query: `nameIN${info.chain.join(',')}`,
        fields: ['name', 'element', ...OVERRIDABLE.map((key) => `${key}_override`), 'mandatory', 'read_only'],
      })
      if (!complete || (total !== null && records.length < total)) overridesRead = false

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
          column.overrides = [...new Set([...(column.overrides ?? []), ...changed])]
        }
      }
    } catch {
      overridesRead = false
    }

    return { columns: [...columns.values()], complete: !base.partial, overridesRead, labelsRead: labels !== null }
  }

  /** The English label of each field, from the nearest table in the chain that has one. */
  private async loadLabels(chain: string[]): Promise<Map<string, string>> {
    const { records, total, complete } = await this.sn.all<Record<string, string>>({
      table: 'sys_documentation',
      query: `nameIN${chain.join(',')}^language=en^elementISNOTEMPTY`,
      fields: ['name', 'element', 'label'],
    })
    if (!complete || (total !== null && records.length < total)) {
      throw new ServiceNowError('The field labels are only partly readable.', 'acl', 'sys_documentation')
    }

    const labels = new Map<string, string>()
    // Root first, so a label closer to the inspected table wins.
    for (const table of [...chain].reverse()) {
      for (const row of records) {
        if (row.name === table && typeof row.element === 'string' && row.label) labels.set(row.element, String(row.label))
      }
    }
    return labels
  }

  /**
   * Checks field paths against the dictionary. A dot-walk is followed only through
   * a reference field: ServiceNow drops a condition that walks through a list
   * field. "ref_<child>.<field>" reaches a field of a child table.
   */
  async checkFields(table: string, paths: string[]): Promise<FieldCheck> {
    const check: FieldCheck = { status: 'checked', unknown: [], resolved: new Map(), reached: new Set() }
    const unavailable = (reason: string) => {
      check.status = 'unavailable'
      check.reason ??= reason
    }

    try {
      for (const member of (await this.table(table))?.members ?? []) check.reached.add(member.table)
    } catch (error) {
      unavailable(`the dictionary could not be read (${error instanceof ServiceNowError ? error.kind : 'unknown'})`)
    }

    for (const path of new Set(paths)) {
      try {
        let current = table
        const segments = path.split('.')

        for (const [index, segment] of segments.entries()) {
          const last = index === segments.length - 1

          if (!last && segment.startsWith('ref_') && isTableName(segment.slice(4))) {
            const child = await this.table(segment.slice(4))
            if (child?.chain.includes(current)) {
              current = child.name
              check.reached.add(current)
              continue
            }
          }

          let set = await this.columnSet(current)
          if (set && !set.partial && !set.columns.has(segment)) set = await this.columnSet(current, this.recheckMs)
          if (!set) {
            if (index === 0) unavailable(`table "${current}" has no dictionary entry`)
            else check.unknown.push({ field: path, table: current, segment, reason: `the referenced table "${current}" has no dictionary entry`, suggestions: [] })
            break
          }

          const column = set.columns.get(segment)
          if (!column) {
            if (set.partial) unavailable(`the dictionary of "${current}" is only partly readable for this account`)
            else check.unknown.push({ field: path, table: current, segment, reason: `"${segment}" is not a field of "${current}"`, suggestions: suggest(segment, set.columns) })
            break
          }

          if (last) {
            check.resolved.set(path, column)
          } else if (column.type !== 'reference' || !column.reference) {
            const why = column.reference ? `a list of references (${column.type})` : `of type ${column.type || 'unknown'}`
            check.unknown.push({ field: path, table: current, segment, reason: `"${segment}" is ${why}, not a single reference, so it cannot be dot-walked`, suggestions: [] })
            break
          } else {
            current = column.reference
            check.reached.add(current)
          }
        }
      } catch (error) {
        unavailable(`the dictionary could not be read (${error instanceof ServiceNowError ? error.kind : 'unknown'})`)
      }
    }

    return check
  }

  /** The choices of a field, from the nearest table in the parent chain that defines any. Empty if there are none. */
  async choices(table: string, field: string): Promise<Choice[]> {
    const info = await this.table(table)
    if (!info) return []

    return this.cached(this.choiceLists, `${table}.${field}`, async () => {
      const { records } = await this.sn.query<Record<string, string>>({
        table: 'sys_choice',
        query: `nameIN${info.chain.join(',')}^element=${field}^inactive=false^language=en^ORDERBYsequence`,
        fields: ['name', 'value', 'label'],
        limit: 200,
      })
      const owner = info.chain.find((name) => records.some((row) => row.name === name))
      return records
        .filter((row) => row.name === owner && typeof row.value === 'string')
        .map((row) => ({ value: row.value, label: String(row.label ?? '') }))
    })
  }

  private async loadTable(name: string): Promise<TableInfo | null> {
    const chain: string[] = []
    let label = ''
    let remote = false
    let current = name

    for (;;) {
      const page = await this.sn.query<Record<string, string>>({
        table: 'sys_db_object',
        query: `name=${current}`,
        fields: ['name', 'label', 'scriptable_table', ...PARENT_FIELDS],
        limit: 1,
      })
      const row = page.records[0]
      if (!row) {
        if ((page.total ?? 0) > 0) {
          throw new ServiceNowError(`"${current}" has an entry in sys_db_object, but this account may not read it.`, 'acl', 'sys_db_object')
        }
        if (chain.length === 0) return this.loadView(name)
        break
      }

      if (chain.length === 0) {
        chain.push(name)
        label = String(row.label ?? '')
        remote = row.scriptable_table === 'true'
      }

      let filled = 0
      for (const field of PARENT_FIELDS) {
        const parent = row[field]
        if (!parent) break
        if (!isTableName(parent) || chain.includes(parent) || chain.length >= MAX_CHAIN) {
          throw new ServiceNowError(`sys_db_object returned a parent chain for "${name}" that cannot be used.`, 'invalid_response', 'sys_db_object')
        }
        chain.push(parent)
        filled++
      }

      // Deeper than one request can see: continue from the last parent found.
      if (filled < PARENT_FIELDS.length) break
      current = chain[chain.length - 1]
    }

    return { name, label, chain, kind: remote ? 'remote_table' : 'table' }
  }

  /** Database views have no entry in sys_db_object. Their fields are the fields of the joined tables, with a prefix. */
  private async loadView(name: string): Promise<TableInfo | null> {
    const page = await this.sn.query<Record<string, string>>({ table: 'sys_db_view', query: `name=${name}`, fields: ['sys_id', 'name', 'label'], limit: 1 })
    const view = page.records[0]
    if (!view) {
      if ((page.total ?? 0) > 0) {
        throw new ServiceNowError(`"${name}" is a database view, but this account may not read its definition.`, 'acl', 'sys_db_view')
      }
      return null
    }
    if (!/^[0-9a-f]{32}$/.test(String(view.sys_id))) return null

    const joined = await this.sn.query<Record<string, string>>({
      table: 'sys_db_view_table',
      query: `view=${view.sys_id}^active=true^ORDERBYorder`,
      fields: ['table', 'variable_prefix'],
      limit: 50,
    })
    if (joined.total !== null && joined.records.length < joined.total) {
      throw new ServiceNowError(`The tables of the database view "${name}" are only partly readable.`, 'acl', 'sys_db_view_table')
    }

    const members = joined.records
      .filter((row) => isTableName(row.table) && row.table !== name && /^[a-z0-9_]{1,40}$/.test(String(row.variable_prefix)))
      .map((row) => ({ table: row.table, prefix: row.variable_prefix }))
    // A row that cannot be used means the list of joined tables is not complete.
    if (members.length < joined.records.length || (joined.total === null && joined.records.length === 50)) {
      throw new ServiceNowError(`The tables of the database view "${name}" could not be read completely.`, 'invalid_response', 'sys_db_view_table')
    }
    return { name, label: String(view.label ?? ''), chain: [name], kind: 'database_view', members }
  }

  /** The fields of a table, and whether the list is complete. null if the table is unknown. */
  columnSet(name: string, maxAgeMs = this.ttlMs): Promise<ColumnSet | null> {
    return this.cached(this.columnSets, name, () => this.loadColumns(name, maxAgeMs), maxAgeMs)
  }

  private async loadColumns(name: string, maxAgeMs: number): Promise<ColumnSet | null> {
    const info = await this.table(name)
    if (!info) return null

    const columns = new Map<string, Column>()
    if (info.kind === 'database_view') {
      let partial = false
      for (const member of info.members ?? []) {
        // A view joins tables. A view named as its own part, or another view, is not followed: that could go in a circle.
        const joined = await this.table(member.table)
        const set = joined && joined.kind !== 'database_view' ? await this.columnSet(member.table, maxAgeMs) : null
        if (!set || set.partial) partial = true
        for (const column of set?.columns.values() ?? []) {
          columns.set(`${member.prefix}_${column.name}`, { ...column, name: `${member.prefix}_${column.name}`, definedOn: member.table, sourceField: column.name })
        }
      }
      return { columns, partial }
    }

    const { records, total, complete } = await this.sn.all<Record<string, string>>({
      table: 'sys_dictionary',
      query: `nameIN${info.chain.join(',')}^elementISNOTEMPTY`,
      fields: ['name', 'element', 'column_label', 'internal_type', 'reference', 'mandatory', 'read_only', 'max_length', 'active', 'choice'],
    })

    // Root first, so a definition closer to the inspected table wins.
    for (const table of [...info.chain].reverse()) {
      for (const row of records) {
        if (row.name !== table || typeof row.element !== 'string' || !row.element) continue
        columns.set(row.element, {
          name: row.element,
          label: String(row.column_label ?? ''),
          type: String(row.internal_type ?? ''),
          reference: isTableName(row.reference) ? row.reference : null,
          mandatory: row.mandatory === 'true',
          readOnly: row.read_only === 'true',
          maxLength: /^\d+$/.test(String(row.max_length)) ? Number(row.max_length) : null,
          active: row.active !== 'false',
          choice: row.choice === '1' || row.choice === '3',
          definedOn: table,
        })
      }
    }
    return { columns, partial: !complete || (total !== null && records.length < total) }
  }

  /** Caches the promise, and forgets it again if it fails, so a later call can retry. */
  private cached<T>(cache: Map<string, Entry<T>>, key: string, load: () => Promise<T>, maxAgeMs = this.ttlMs): Promise<T> {
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < maxAgeMs) return hit.value

    const entry: Entry<T> = { value: load(), at: Date.now() }
    cache.delete(key)
    cache.set(key, entry)
    entry.value.catch(() => {
      if (cache.get(key) === entry) cache.delete(key)
    })
    if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string)
    return entry.value
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
      const comparable = Math.abs(candidate.length - wanted.length) <= tolerance
      return { name, score: contained ? 1 : comparable ? editDistance(wanted, candidate) : Infinity }
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
