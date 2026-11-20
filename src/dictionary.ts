import type { Page, QueryOptions, Row, ServiceNowClient } from './client.js'
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
  /**
   * Where each verified path takes its values from: the table the path ends on, and the name of the field there.
   * The queried table for a plain field, the referenced table for a dot-walk, the joined table for a field of a view.
   */
  owners: Map<string, { table: string; field: string }>
  /** Tables the paths read from besides the queried one: targets of dot-walks, child tables, tables a view joins. */
  reached: Set<string>
  /** Each reference a path walks through, as written up to that point, and the table it lands on. */
  walks: Map<string, string>
}

export interface Choice {
  value: string
  label: string
  /** Language of the label. A value has one entry per language it is labelled in. */
  language: string
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
  private readonly ruleCounts = new Map<string, Entry<{ count: number; query: string } | null>>()
  private readonly archiveCounts = new Map<string, Entry<{ count: number; query: string } | null>>()
  private readonly rotations = new Map<string, Entry<{ rotations: number; days: number } | null>>()
  private readonly settings = new Map<string, Entry<boolean | null>>()
  private readonly closedSets = new Map<string, Entry<Map<string, string[]>>>()

  /** The client, for the dictionary's own lookups. The gate of closed tables is built from them, so they do not pass through it. */
  private readonly sn: {
    query<T = Row>(opts: QueryOptions): Promise<Page<T>>
    all<T = Row>(opts: Omit<QueryOptions, 'limit' | 'offset'>, maxRows?: number, pageSize?: number): Promise<{ records: T[]; total: number | null; complete: boolean }>
    readonly denied: { names: string[]; prefixes: string[] }
  }
  private readonly childSets = new Map<string, Entry<string[] | null>>()

  constructor(
    client: ServiceNowClient,
    private readonly ttlMs = 10 * 60_000,
    private readonly recheckMs = 30_000,
  ) {
    this.sn = {
      query: <T = Row>(opts: QueryOptions) => client.query<T>({ ...opts, trusted: true }),
      all: <T = Row>(opts: Omit<QueryOptions, 'limit' | 'offset'>, maxRows?: number, pageSize?: number) => client.all<T>({ ...opts, trusted: true }, maxRows, pageSize),
      get denied() {
        return client.denied
      },
    }
  }

  table(name: string): Promise<TableInfo | null> {
    assertTableName(name)
    return this.cached(this.tables, name, () => this.loadTable(name))
  }

  /**
   * Drops what is remembered about a table, so that the next read asks the instance.
   * For a database view, call it for the tables it joins as well.
   */
  forget(name: string): void {
    for (const cache of [this.tables, this.columnSets, this.labelSets]) cache.delete(name)
  }

  /** Own and inherited fields of a table, without dictionary overrides. null if the table is unknown. */
  async columns(name: string): Promise<Map<string, Column> | null> {
    return (await this.columnSet(name))?.columns ?? null
  }

  /** The fields as they behave on this table: inherited fields included, overrides applied. */
  async effectiveColumns(name: string): Promise<{ columns: Column[]; complete: boolean; overridesRead: boolean; labelsRead: boolean } | null> {
    const info = await this.table(name)
    const base = info && (await this.columnSet(name))
    if (!info || !base) return null

    const columns = new Map([...base.columns].map(([key, column]) => [key, { ...column }]))
    if (info.kind === 'database_view') return { columns: [...columns.values()], complete: !base.partial, overridesRead: true, labelsRead: true }

    // A child table can give an inherited field its own label: "Close notes" on task is "Resolution notes" on incident.
    const labels = await this.cached(this.labelSets, name, () => this.loadLabels(info.chain)).catch(() => null)
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
      throw new ServiceNowError('The field labels could not be read completely: rows are hidden from this account, or there are more than 5,000.', 'acl', 'sys_documentation')
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
    const check: FieldCheck = { status: 'checked', unknown: [], resolved: new Map(), owners: new Map(), reached: new Set(), walks: new Map() }
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
            // Measured: the instance also takes "ref_<the table itself>.". That is no way around a check made on the
            // plain name, so it is refused here, whatever else can or cannot be read of the dictionary.
            if (child && child.name === current) {
              check.unknown.push({ field: path, table: current, segment, reason: `"${segment}." names the table itself: write the field without it`, suggestions: [] })
              break
            }
            if (child && child.chain.includes(current)) {
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
            check.owners.set(path, column.sourceField ? { table: column.definedOn, field: column.sourceField } : { table: current, field: segment })
          } else if (column.type !== 'reference' || !column.reference) {
            const why = column.reference ? `a list of references (${column.type})` : `of type ${column.type || 'unknown'}`
            check.unknown.push({ field: path, table: current, segment, reason: `"${segment}" is ${why}, not a single reference, so it cannot be dot-walked`, suggestions: [] })
            break
          } else {
            current = column.reference
            check.reached.add(current)
            check.walks.set(segments.slice(0, index + 1).join('.'), current)
          }
        }
      } catch (error) {
        unavailable(`the dictionary could not be read (${error instanceof ServiceNowError ? error.kind : 'unknown'})`)
      }
    }

    return check
  }

  /**
   * The choices of a field, from the nearest table in the parent chain that defines any. Empty if there are none.
   * In every language: a choice made in a German session has no English label, and an agent may be shown the
   * label of another language. Fails if the list is only partly readable: a missing choice would look like a
   * value that does not exist.
   */
  async choices(table: string, field: string): Promise<Choice[]> {
    const info = await this.table(table)
    if (!info) return []

    return this.cached(this.choiceLists, `${table}.${field}`, async () => {
      const { records, total, complete } = await this.sn.all<Record<string, string>>(
        {
          table: 'sys_choice',
          query: `nameIN${info.chain.join(',')}^element=${field}^inactive=false^ORDERBYsequence`,
          fields: ['name', 'value', 'label', 'language'],
        },
        2_000,
      )
      if (!complete || (total !== null && records.length < total)) {
        throw new ServiceNowError(`The choices of "${field}" could not be read completely: rows are hidden from this account, or there are more than 2,000.`, 'acl', 'sys_choice')
      }
      const owner = info.chain.find((name) => records.some((row) => row.name === name))
      return records
        .filter((row) => row.name === owner && typeof row.value === 'string')
        .map((row) => ({ value: row.value, label: String(row.label ?? ''), language: String(row.language ?? '') }))
    })
  }

  /**
   * Every table the deny list of this machine closes, each with its parents: the tables it names, the tables its
   * patterns match, and the child tables of all of them, whatever they are called. A child table holds rows of its
   * parent, so a query on a grandparent answers with them. Looks eight levels down. Empty without a deny list.
   *
   * Fails if the list cannot be trusted: a table missing from it would not be kept out. The query asks for the row
   * of sys_db_object itself as well. Where that row does not come back, the instance did not apply the query as
   * written, and where a row comes back that matches none of the names, it ignored the conditions.
   */
  closedTables(): Promise<Map<string, string[]>> {
    const { names, prefixes } = this.sn.denied
    const wanted = prefixes.filter(Boolean)
    if (!names.length && !wanted.length) return Promise.resolve(new Map())

    return this.cached(this.closedSets, 'deny', async () => {
      const SENTINEL = 'sys_db_object'
      const untrusted = (why: string) =>
        new ServiceNowError(`Tables are closed on this machine, and the list of their child tables could not be established (${why}). Nothing was sent.`, 'blocked', SENTINEL)
      const terms = ['name', ...PARENT_FIELDS].flatMap((path) => [names.length ? `${path}IN${names.join(',')}` : '', ...wanted.map((prefix) => `${path}STARTSWITH${prefix}`)].filter(Boolean))
      // A long deny list is asked for in several requests, so that no query grows beyond what a URL carries.
      const queries: string[][] = [[]]
      for (const term of terms) {
        if (queries.at(-1)!.join('^OR').length + term.length > 2_500 && queries.at(-1)!.length) queries.push([])
        queries.at(-1)!.push(term)
      }

      const closed = new Map<string, string[]>()
      const isClosed = (name: string) => names.includes(name) || wanted.some((prefix) => name.startsWith(prefix))
      for (const part of queries) {
        const query = `${part.join('^OR')}^ORname=${SENTINEL}`
        const { records, total, complete } = await this.sn.all<Record<string, string>>({ table: SENTINEL, query, fields: ['name', ...PARENT_FIELDS] }, 2_000).catch((error) => {
          throw untrusted(`sys_db_object could not be read: ${error instanceof ServiceNowError ? error.kind : 'unknown'}`)
        })
        if (!complete || (total !== null && records.length < total)) throw untrusted('sys_db_object could not be read completely')
        if (!records.some((row) => row.name === SENTINEL)) throw untrusted('the instance did not answer the query as written')
        for (const row of records) {
          const chain = [row.name, ...PARENT_FIELDS.map((field) => row[field])].filter((name): name is string => typeof name === 'string' && name !== '')
          if (chain.some(isClosed)) closed.set(row.name, chain)
          else if (row.name !== SENTINEL) throw untrusted('the instance ignored the conditions of the query')
        }
      }
      return closed
    })
  }

  /**
   * The names of every table below a table, eight levels down. Used where a list names the only tables that may be
   * read: a table below an open one can be closed. null if the list cannot be trusted, for the reasons given at
   * closedTables: the caller then has to assume that a closed table is among them.
   */
  childTables(table: string): Promise<string[] | null> {
    assertTableName(table)
    return this.cached(this.childSets, table, async () => {
      const query = `${PARENT_FIELDS.map((path) => `${path}=${table}`).join('^OR')}^ORname=${table}`
      const read = await this.sn.all<Record<string, string>>({ table: 'sys_db_object', query, fields: ['name', ...PARENT_FIELDS] }, 3_000).catch(() => null)
      if (!read || !read.complete || (read.total !== null && read.records.length < read.total)) return null
      // The table itself is asked for as proof that the query was applied as written.
      if (!read.records.some((row) => row.name === table)) return null
      const below = read.records.filter((row) => row.name !== table)
      if (below.some((row) => !PARENT_FIELDS.some((path) => row[path] === table))) return null
      return below.map((row) => row.name).filter((name): name is string => typeof name === 'string' && name !== '')
    })
  }

  /**
   * The active business rules that run on every read of a table ("before query"). Such a rule can add conditions
   * that depend on who asks, so the rows and the total an account gets are what the rule lets through. Rules on a
   * parent table run for the table too. Rules on the table "global" run for every table: they are counted once,
   * by sn_instance, and not named with every answer. null for a database view or an unknown table.
   */
  async queryRules(table: string): Promise<{ count: number; query: string } | null> {
    const info = await this.table(table)
    if (!info || info.kind === 'database_view') return null
    return this.cached(this.ruleCounts, table, async () => {
      const query = `collectionIN${info.chain.join(',')}^action_query=true^active=true`
      const page = await this.sn.query<Record<string, string>>({ table: 'sys_script', query, fields: ['sys_id', 'action_query'], limit: 1 })
      // The answer checks its own query: a row without the field means the instance does not know it and ignored the condition.
      if (page.total === null || (page.records[0] && !('action_query' in page.records[0]))) {
        throw new ServiceNowError('The instance did not answer the question about query business rules as it was asked.', 'invalid_response', 'sys_script')
      }
      return { count: page.total, query }
    })
  }

  /**
   * Whether the instance answers a query it cannot use with no rows (glide.invalid_query.returns_no_rows), where it
   * would otherwise drop the condition and answer with every row. A hardened instance has this on. Then an empty
   * answer no longer shows that a condition was understood. null if the property could not be read.
   */
  emptyOnInvalidQuery(): Promise<boolean | null> {
    return this.cached(this.settings, 'emptyOnInvalidQuery', async () => {
      const name = 'glide.invalid_query.returns_no_rows'
      const page = await this.sn.query<Record<string, string>>({ table: 'sys_properties', query: `name=${name}`, fields: ['name', 'value'], limit: 1 }).catch(() => null)
      if (!page || (page.records.length === 0 && (page.total ?? 0) > 0)) return null
      return page.records.find((row) => row.name === name)?.value === 'true'
    })
  }

  /**
   * The active archive rules of a table and its parents. Such a rule moves records out of the table into an archive
   * table ("ar_<table>"), so the table answers only with what is not archived yet. null for a view or an unknown table.
   */
  async archiveRules(table: string): Promise<{ count: number; query: string } | null> {
    const info = await this.table(table)
    if (!info || info.kind === 'database_view') return null
    return this.cached(this.archiveCounts, table, async () => {
      const query = `tableIN${info.chain.join(',')}^active=true`
      const page = await this.sn.query<Record<string, string>>({ table: 'sys_archive', query, fields: ['sys_id', 'table', 'active'], limit: 1 })
      // The answer checks its own query, as everywhere: a row without the fields means the conditions were ignored.
      if (page.total === null || (page.records[0] && !('table' in page.records[0] && 'active' in page.records[0]))) {
        throw new ServiceNowError('The instance did not answer the question about archive rules as it was asked.', 'invalid_response', 'sys_archive')
      }
      return { count: page.total, query }
    })
  }

  /**
   * How long a rotated table keeps its rows. A table such as syslog is spread over a few tables by time, and the
   * oldest is emptied in turn: what is older than all of them is gone. null if the table is not rotated.
   */
  async rotation(table: string): Promise<{ rotations: number; days: number } | null> {
    assertTableName(table)
    return this.cached(this.rotations, table, async () => {
      const page = await this.sn.query<Record<string, string>>({ table: 'sys_table_rotation', query: `name=${table}^type=rotate`, fields: ['name', 'type', 'duration', 'rotations'], limit: 1 })
      const row = page.records.find((item) => item.name === table && item.type === 'rotate')
      // Measured: the duration is stored as a point in time counted from 1970-01-01, seven days as "1970-01-08 00:00:00".
      const length = row ? Date.parse(`${String(row.duration).replace(' ', 'T')}Z`) / 86_400_000 : NaN
      const rotations = Number(row?.rotations)
      return Number.isFinite(length) && length > 0 && Number.isInteger(rotations) && rotations > 0 ? { rotations, days: Math.round(length * 10) / 10 } : null
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
