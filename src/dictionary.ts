import type { Page, QueryOptions, Row, ServiceNowClient } from './client.js'
import { noConnection, ServiceNowError, unlessNoConnection, unusableAnswer } from './errors.js'
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
  /** Everything the overrides along the chain change, taken together. */
  overrides?: string[]
  /** Each dictionary override that applies, nearest table first: a record of its own, with what it changes. */
  overrideRecords?: Array<{ table: string; sysId: string; changes: string[] }>
  /** The table whose label record gives the field its label, where that is not the table that defines the field. */
  labelFrom?: string
  /** For a field of a database view: its name on the table it comes from. */
  sourceField?: string
  /**
   * For a field of a database view: the table in the parent chain of the joined table that defines it. There
   * "definedOn" is the table the view joins, which is what decides what the field holds.
   */
  sourceDefinedOn?: string
  /**
   * For a field of a database view: true where the view lists the fields it takes from the joined table and this
   * is not one of them, or where that list could not be read. Measured: the instance drops a condition on such a
   * field and answers unfiltered, unless a row of the view carries the field all the same (a few system fields do).
   */
  outsideList?: boolean
  /** With "outsideList": true where the list could not be read, so that it is not known whether the field is on it. */
  listUnread?: boolean
}

export interface TableInfo {
  name: string
  label: string
  /** The table itself first, then its parents up to the root. */
  chain: string[]
  /** A remote table runs a script on the instance whenever it is read. */
  kind: 'table' | 'remote_table' | 'database_view'
  /**
   * For a database view: the tables it joins, and the prefix its fields carry. "fields" where the view lists the
   * fields it takes from that table; null where it could not be read whether it does.
   */
  members?: Array<{ table: string; prefix: string; fields?: string[] | null }>
}

export interface UnknownField {
  field: string
  table: string
  segment: string
  reason: string
  suggestions: string[]
  /** true where the instance was asked about the field before it was called unknown. */
  asked?: boolean
}

/**
 * Asks an instance whether it applies a condition on a field, without knowing what the field holds.
 *
 * An instance that cannot use a condition drops it and answers with every row. So the rows where the field is empty
 * and filled at once are asked for first: an instance that applies the condition answers with none ("dropped"
 * otherwise). That question is cheap, because nothing matches.
 *
 * An instance can also be set to answer a query it cannot use with no rows at all
 * (glide.invalid_query.returns_no_rows); the first question then proves nothing. Where it is known that the
 * instance is not set that way ("dropsUnusable"), it is enough to know that the table has a row: without one
 * nothing can be proven, and nothing can come back either ("no_rows"). Where it is not known, the rows where the
 * field is empty or filled are asked for, which is every row: an answer with rows says "applied", and one with
 * none from a table that has rows says that the instance answered the question with nothing ("answers_nothing").
 * That second question counts the whole table, which took nine seconds on a view of 12,000 rows.
 *
 * A question that fails, or an empty answer without a total, is "unanswered".
 */
export async function proveCondition(
  ask: (query: string) => Promise<{ total: number | null; records: unknown[] } | null>,
  path: string,
  dropsUnusable = false,
): Promise<'applied' | 'dropped' | 'answers_nothing' | 'no_rows' | 'unanswered'> {
  const some = (answer: { total: number | null; records: unknown[] }) => answer.records.length > 0 || (answer.total ?? 0) > 0
  const both = await ask(`${path}ISEMPTY^${path}ISNOTEMPTY`)
  if (!both) return 'unanswered'
  if (some(both)) return 'dropped'
  if (both.total === null) return 'unanswered'
  if (!dropsUnusable) {
    const either = await ask(`${path}ISEMPTY^OR${path}ISNOTEMPTY`)
    if (!either) return 'unanswered'
    if (some(either)) return 'applied'
  }
  const any = await ask('')
  if (!any || (any.total === null && !any.records.length)) return 'unanswered'
  if (!some(any)) return 'no_rows'
  return dropsUnusable ? 'applied' : 'answers_nothing'
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
/** Names that are no table, for a question that has to match nothing. */
const NO_SUCH_TABLE = ['zz__no_such_table_a', 'zz__no_such_table_b']
/** As many names as are remembered to be a table or none. An entry is a name and a flag. */
const MAX_KNOWN_NAMES = 5_000

/**
 * The parents of a row of sys_db_object as they were asked for, nearest first. null if the row cannot be used: it
 * came without its name, or with a gap among its parents, so that the place of a parent in the list says nothing.
 */
function parentsOf(row: Record<string, unknown>): string[] | null {
  // A name read here goes into the next query, and into the condition that leaves the rows of a closed table
  // out: one that is no table name would write that condition anew.
  if (!isTableName(row.name)) return null
  const parents: string[] = []
  let ended = false
  for (const field of PARENT_FIELDS) {
    const parent = row[field]
    const filled = typeof parent === 'string' && parent !== ''
    if (filled && (ended || !isTableName(parent))) return null
    if (filled) parents.push(parent)
    else ended = true
  }
  return parents
}

/** Names in groups of at most forty, none longer in a query than a request should carry. */
function inGroups(names: string[], length = 1_500): string[][] {
  const groups: string[][] = []
  for (const name of names) {
    const last = groups.at(-1)
    if (!last || last.length >= 40 || last.join(',').length + name.length + 1 > length) groups.push([name])
    else last.push(name)
  }
  return groups
}

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
  private readonly labelSets = new Map<string, Entry<Map<string, { label: string; table: string }>>>()
  private readonly ruleCounts = new Map<string, Entry<{ count: number; query: string } | null>>()
  private readonly archiveCounts = new Map<string, Entry<{ count: number; query: string } | null>>()
  private readonly rotations = new Map<string, Entry<{ rotations: number; days: number } | null>>()
  private readonly settings = new Map<string, Entry<boolean | null>>()
  private readonly closedSets = new Map<string, Entry<Map<string, string[]>>>()
  private readonly parentChecks = new Map<string, Entry<boolean>>()
  private readonly knownNames = new Map<string, { table: boolean; at: number }>()
  private readonly partLists = new Map<string, Entry<Map<string, string> | null>>()

  /**
   * The client, for the lookups the gate of closed tables is built from: what a table is, what it extends, which
   * fields it has, and which tables are closed. Those cannot pass through the gate they make. Every other lookup
   * of this class goes through "gated", like the request of any tool.
   */
  private readonly sn: {
    query<T = Row>(opts: QueryOptions): Promise<Page<T>>
    all<T = Row>(opts: Omit<QueryOptions, 'limit' | 'offset'>, maxRows?: number, pageSize?: number): Promise<{ records: T[]; total: number | null; complete: boolean }>
    readonly denied: { names: string[]; prefixes: string[] }
  }
  private readonly childSets = new Map<string, Entry<Map<string, string[]> | null>>()
  private readonly gated: ServiceNowClient

  constructor(
    client: ServiceNowClient,
    private readonly ttlMs = 10 * 60_000,
    private readonly recheckMs = 30_000,
  ) {
    this.gated = client
    this.sn = {
      query: <T = Row>(opts: QueryOptions) => client.query<T>({ ...opts, trusted: true }),
      all: <T = Row>(opts: Omit<QueryOptions, 'limit' | 'offset'>, maxRows?: number, pageSize?: number) => client.all<T>({ ...opts, trusted: true }, maxRows, pageSize),
      get denied() {
        return client.denied
      },
    }
  }

  /** What a name is on the instance: a table with its parents, a database view with the tables it joins, or null. */
  async table(name: string): Promise<TableInfo | null> {
    // In an async function, so that a name that cannot be a table is a failed look-up like any other, which the
    // caller's catch sees, and not an exception thrown past it.
    assertTableName(name)
    return this.cached(this.tables, name, () => this.loadTable(name))
  }

  /**
   * Which of these names are tables of the instance. One request per forty names, and the answer is remembered,
   * also for a name that is none: an update name is cut in many places to find the table it begins with, and a
   * page of them shares most of the cuts.
   */
  async knownTables(names: string[]): Promise<Set<string>> {
    const wanted = [...new Set(names)].filter(isTableName)
    const now = Date.now()
    const fresh = (name: string) => {
      const hit = this.knownNames.get(name)
      return hit !== undefined && now - hit.at < this.ttlMs
    }
    for (const group of inGroups(wanted.filter((name) => !fresh(name)))) {
      const { records, total, complete } = await this.sn.all<Record<string, string>>({ table: 'sys_db_object', query: `nameIN${group.join(',')}`, fields: ['name'] }, 1_000)
      if (!complete || (total !== null && records.length < total)) {
        throw new ServiceNowError('It could not be read completely which of these names are tables: rows of sys_db_object are hidden from this account.', 'acl', 'sys_db_object')
      }
      const found = new Set(records.map((row) => row.name))
      for (const name of group) {
        this.knownNames.delete(name)
        this.knownNames.set(name, { table: found.has(name), at: now })
      }
      while (this.knownNames.size > MAX_KNOWN_NAMES) this.knownNames.delete(this.knownNames.keys().next().value as string)
    }
    return new Set(wanted.filter((name) => this.knownNames.get(name)?.table))
  }

  /**
   * Drops what is remembered about a table, so that the next read asks the instance.
   * For a database view, call it for the tables it joins as well.
   */
  forget(name: string): void {
    for (const cache of [this.tables, this.columnSets, this.labelSets, this.ruleCounts, this.archiveCounts, this.rotations, this.childSets]) cache.delete(name)
    for (const key of [...this.choiceLists.keys()]) if (key.startsWith(`${name}.`)) this.choiceLists.delete(key)
    // What a view was seen to carry belongs to its definition: a field taken off its list is asked about again.
    for (const key of [...this.carried.keys()]) if (key.startsWith(`${name}.`)) this.carried.delete(key)
    this.someRow.delete(name)
    this.knownNames.delete(name)
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
    for (const [element, { label, table }] of labels ?? []) {
      const column = columns.get(element)
      if (!column || !label) continue
      column.label = label
      if (table !== column.definedOn) column.labelFrom = table
    }

    let overridesRead = true
    try {
      const { records, total, complete } = await this.gated.all<Record<string, string>>({
        table: 'sys_dictionary_override',
        query: `nameIN${info.chain.join(',')}`,
        fields: ['sys_id', 'name', 'element', ...OVERRIDABLE.map((key) => `${key}_override`), 'mandatory', 'read_only'],
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
          column.overrideRecords = [{ table, sysId: String(row.sys_id ?? ''), changes: changed }, ...(column.overrideRecords ?? [])]
        }
      }
    } catch {
      overridesRead = false
    }

    return { columns: [...columns.values()], complete: !base.partial, overridesRead, labelsRead: labels !== null }
  }

  /** The English label of each field, from the nearest table in the chain that has one. */
  private async loadLabels(chain: string[]): Promise<Map<string, { label: string; table: string }>> {
    const { records, total, complete } = await this.gated.all<Record<string, string>>({
      table: 'sys_documentation',
      query: `nameIN${chain.join(',')}^language=en^elementISNOTEMPTY`,
      fields: ['name', 'element', 'label'],
    })
    if (!complete || (total !== null && records.length < total)) {
      throw new ServiceNowError('The field labels could not be read completely: rows are hidden from this account, or there are more than 5,000.', 'acl', 'sys_documentation')
    }

    const labels = new Map<string, { label: string; table: string }>()
    // Root first, so a label closer to the inspected table wins.
    for (const table of [...chain].reverse()) {
      for (const row of records) {
        if (row.name === table && typeof row.element === 'string' && row.label) labels.set(row.element, { label: String(row.label), table })
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
      if (noConnection(error)) throw error
      unavailable(`the dictionary could not be read (${error instanceof ServiceNowError ? error.kind : 'unknown'})`)
    }

    for (const path of new Set(paths)) {
      try {
        let current = table
        const segments = path.split('.')

        for (const [index, segment] of segments.entries()) {
          const last = index === segments.length - 1

          if (!last && segment.startsWith('ref_') && isTableName(segment.slice(4))) {
            // Measured: the instance also takes "ref_<the table itself>.". That is no way around a check made on the
            // plain name, so it is refused by the name alone, before anything is read of the dictionary.
            if (segment.slice(4) === current) {
              check.unknown.push({ field: path, table: current, segment, reason: `"${segment}." names the table itself: write the field without it`, suggestions: [] })
              break
            }
            const child = await this.table(segment.slice(4))
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
          if (column?.outsideList && !(await this.viewCarries(current, segment))) {
            check.unknown.push({
              field: path,
              table: current,
              segment,
              reason: column.listUnread
                ? `"${segment}" is a field of "${column.definedOn}", which the view "${current}" joins, but it could not be read which fields the view takes from that table, and the instance did not prove that it applies a condition on this one`
                : `"${segment}" is a field of "${column.definedOn}", which the view "${current}" joins, but the view lists the fields it takes from that table and this is not one of them`,
              suggestions: [],
              asked: true,
            })
            break
          }
          if (!column) {
            if (set.partial) unavailable(`the dictionary of "${current}" is only partly readable for this account`)
            // Names that look like the unknown one are searched for the first few only: each search compares
            // with every field of the table.
            else check.unknown.push({ field: path, table: current, segment, reason: `"${segment}" is not a field of "${current}"`, suggestions: check.unknown.length < 5 ? suggest(segment, set.columns) : [] })
            break
          }

          if (last) {
            check.resolved.set(path, column)
            check.owners.set(path, column.sourceField ? { table: column.definedOn, field: column.sourceField } : { table: current, field: segment })
          } else if (column.type !== 'reference' || !column.reference) {
            const why = column.reference ? `a list of references (${column.type})` : `of type ${column.type || 'unknown'}`
            // Measured on lists with one entry: =, IN, LIKE and CONTAINS with the sys_id all find the row. LIKE also finds it among others.
            const instead = column.reference ? `; to find the rows that list a record, compare the list with its sys_id: ${segment}LIKE<sys_id>` : ''
            check.unknown.push({ field: path, table: current, segment, reason: `"${segment}" is ${why}, not a single reference, so it cannot be dot-walked${instead}`, suggestions: [] })
            break
          } else {
            current = column.reference
            check.reached.add(current)
            check.walks.set(segments.slice(0, index + 1).join('.'), current)
          }
        }
      } catch (error) {
        if (noConnection(error)) throw error
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
    if (!/^[a-z_][a-z0-9_]*$/.test(field)) throw new ServiceNowError(`"${field}" is not the name of a field.`, 'validation', table)
    const info = await this.table(table)
    if (!info) return []

    return this.cached(this.choiceLists, `${table}.${field}`, async () => {
      const { records, total, complete } = await this.gated.all<Record<string, string>>(
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
      // A row without its value is one whose value this account may not read: the list is then not complete.
      if (records.some((row) => typeof row.value !== 'string')) {
        throw new ServiceNowError(`The choices of "${field}" came back without their values: this account may not read them.`, 'acl', 'sys_choice')
      }
      const owner = info.chain.find((name) => records.some((row) => row.name === name))
      return records
        .filter((row) => row.name === owner)
        .map((row) => ({ value: row.value, label: String(row.label ?? ''), language: String(row.language ?? '') }))
    })
  }

  /**
   * Whether this account can be told which table a table extends, and whether the instance filters by it. The lists
   * of child tables are built from conditions on the parents of a table, eight levels up.
   *
   * An account that may not read the parent of a table could be answered as if those conditions were not there. So
   * the instance has to hand out one table together with its parent first.
   *
   * Reading is not filtering. Measured: a condition the instance cannot use is dropped, and where it stands behind
   * another in a chain of ^OR it then matches nothing. The table named on a list would come back, none of its child
   * tables, and nothing in the answer would show it. Several such questions in one query, joined by ^NQ, prove
   * nothing either: a part whose conditions are dropped adds no rows. So each of the eight paths is asked alone for
   * a table that is two things at once. Where the condition is applied no row matches, and where it is dropped
   * every table comes back. "patterns" asks the same with STARTSWITH, which a list with patterns needs and which
   * an instance can allow or refuse apart from "is".
   */
  private parentsUsable(patterns: boolean): Promise<boolean> {
    return this.cached(this.parentChecks, patterns ? 'patterns' : 'names', async () => {
      const page = await this.sn.query<Record<string, string>>({ table: 'sys_db_object', query: 'super_class.nameISNOTEMPTY', fields: ['name', 'super_class.name'], limit: 1 })
      const shown = page.records[0]
      const filled = (value: unknown) => typeof value === 'string' && value !== ''
      if (!shown || !filled(shown.name) || !filled(shown['super_class.name'])) return false

      // The name of a table is asked the same way: the lists name tables by "is one of" and "starts with" behind
      // other conditions, where a dropped one would go unseen as well.
      const [a, b] = NO_SUCH_TABLE
      const questions = ['name', ...PARENT_FIELDS].flatMap((path) => [`${path}IN${a}^${path}IN${b}`, ...(patterns ? [`${path}STARTSWITH${a}^${path}STARTSWITH${b}`] : [])])
      const answers = await Promise.all(questions.map((query) => this.sn.query<Record<string, string>>({ table: 'sys_db_object', query, fields: ['sys_id'], limit: 1 })))
      return answers.every((answer) => answer.total === 0 && answer.records.length === 0)
    })
  }

  /**
   * Every table the deny list of this machine closes, each with its parents: the tables it names, the tables its
   * patterns match, and the child tables of all of them, whatever they are called. A child table holds rows of its
   * parent, so a query on a grandparent answers with them. Empty without a deny list.
   *
   * One request sees eight levels down. Measured on one instance of 10,806 tables: 5 have a parent eight levels up,
   * none nine. Where a table is found at the eighth level, the tables below it are asked for in turn.
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
      const closed = new Map<string, string[]>()
      const usable = await this.parentsUsable(wanted.length > 0).catch(unlessNoConnection(false))
      if (!usable) throw untrusted('the instance did not show this account which table a table extends, or did not filter by it (sys_db_object.super_class)')

      /**
       * The tables that carry one of these names, or match one of these patterns, at their own name or at one of
       * eight parents. Returns those found with the name at the eighth parent: what is below them was out of sight.
       */
      const read = async (given: string[], patterns: string[], counts: (name: string) => boolean): Promise<string[]> => {
        // A long list is asked for in several requests, so that no query grows beyond what a URL carries: the
        // names in groups, and the conditions in as many queries as it takes.
        const groups: string[][] = []
        for (let at = 0; at < given.length; at += 40) groups.push(given.slice(at, at + 40))
        const terms = ['name', ...PARENT_FIELDS].flatMap((path) => [...groups.map((group) => `${path}IN${group.join(',')}`), ...patterns.map((prefix) => `${path}STARTSWITH${prefix}`)])
        const queries: string[][] = [[]]
        for (const term of terms) {
          if (queries.at(-1)!.join('^OR').length + term.length > 2_500 && queries.at(-1)!.length) queries.push([])
          queries.at(-1)!.push(term)
        }

        const deepest = new Set<string>()
        for (const part of queries) {
          const query = `${part.join('^OR')}^ORname=${SENTINEL}`
          const { records, total, complete } = await this.sn.all<Record<string, string>>({ table: SENTINEL, query, fields: ['name', ...PARENT_FIELDS] }, 2_000).catch((error) => {
            if (noConnection(error)) throw error
            throw untrusted(`sys_db_object could not be read: ${error instanceof ServiceNowError ? error.kind : 'unknown'}`)
          })
          if (!complete || (total !== null && records.length < total)) throw untrusted('sys_db_object could not be read completely')
          if (!records.some((row) => row.name === SENTINEL)) throw untrusted('the instance did not answer the query as written')
          for (const row of records) {
            const parents = parentsOf(row)
            if (!parents) throw untrusted('sys_db_object answered with a row that has no name, or a gap among its parents')
            const chain = [row.name, ...parents]
            const at = chain.findIndex(counts)
            if (at >= 0) {
              if (!closed.has(row.name)) closed.set(row.name, chain)
              if (at === PARENT_DEPTH) deepest.add(row.name)
            } else if (row.name !== SENTINEL) throw untrusted('the instance ignored the conditions of the query')
          }
        }
        return [...deepest]
      }

      const isClosed = (name: string) => names.includes(name) || wanted.some((prefix) => name.startsWith(prefix))
      let deepest = await read(names, wanted, isClosed)
      for (let round = 1; deepest.length; round++) {
        if (round * PARENT_DEPTH >= MAX_CHAIN) throw untrusted('the tables below the closed ones go deeper than this server follows')
        const above = new Set(deepest)
        deepest = await read(deepest, [], (name) => above.has(name))
      }

      // A chain as read ends at the eighth parent. Where it is that long, the table at its end may have parents too,
      // and a query on one of those answers with the rows of this table as well.
      for (const chain of closed.values()) {
        if (chain.length <= PARENT_DEPTH) continue
        const top = await this.table(chain.at(-1)!).catch((error) => {
          if (noConnection(error)) throw error
          return null
        })
        if (!top) throw untrusted(`the parents of "${chain.at(-1)}" could not be read`)
        chain.push(...top.chain.slice(1))
      }

      // What a table is and which fields it has is read from these two. Where a list closes them as children of
      // another table, nothing can be established without reading a closed table.
      const needed = [SENTINEL, 'sys_dictionary'].find((name) => closed.has(name))
      if (needed) throw untrusted(`"${needed}", which this server reads for every check, is a child table of ${closed.get(needed)!.find(isClosed)}, which is closed`)
      return closed
    })
  }

  /**
   * The parts a rotated table is stored in, each with the table whose rows it holds. A part extends nothing, so
   * nothing but this list says what it is. Measured on one instance: 357 entries for 49 tables, of which 319 are
   * named after the table with four digits, 8 with one digit, and 30 name the table itself. null where the list
   * cannot be read completely: the caller then has to go by the name of a table.
   */
  rotatedParts(): Promise<Map<string, string> | null> {
    return this.cached(this.partLists, 'parts', async () => {
      const read = await this.sn.all<Record<string, string>>({ table: 'sys_table_rotation_schedule', fields: ['table_name', 'name.name'] }, 5_000).catch(unlessNoConnection(null))
      if (!read || !read.complete || (read.total !== null && read.records.length < read.total)) return null
      const parts = new Map<string, string>()
      for (const row of read.records) {
        // An entry without one of the two names is one this account is not shown in full: then the list says
        // nothing about the part it stands for.
        if (!isTableName(row.table_name) || !isTableName(row['name.name'])) return null
        if (row.table_name !== row['name.name']) parts.set(row.table_name, row['name.name'])
      }
      return parts
    })
  }

  /**
   * Every table below a table, however deep, each with its parents up to the table. Used where a list names the
   * only tables that may be read: a table below an open one can be closed, by itself or by a parent in between.
   * null if the list cannot be trusted, for the reasons given at closedTables: the caller then has to assume that
   * a closed table is among them.
   */
  async childTables(table: string): Promise<Map<string, string[]> | null> {
    assertTableName(table)
    return this.cached(this.childSets, table, async () => {
      const usable = await this.parentsUsable(false).catch(unlessNoConnection(false))
      if (!usable) return null
      const below = new Map<string, string[]>()
      let above = [table]
      for (let round = 0; above.length; round++) {
        if (round * PARENT_DEPTH >= MAX_CHAIN) return null
        const deepest = new Set<string>()
        // The names stand in the query once per level: few enough of them at a time that it stays a request.
        for (const group of inGroups(above, 400)) {
          // With "is one of" also for a single name: that is the condition the instance was shown to apply.
          const under = (path: string) => `${path}IN${group.join(',')}`
          const query = `${PARENT_FIELDS.map(under).join('^OR')}^ORname=${table}`
          const read = await this.sn.all<Record<string, string>>({ table: 'sys_db_object', query, fields: ['name', ...PARENT_FIELDS] }, 3_000).catch((error) => {
            if (noConnection(error)) throw error
            return null
          })
          if (!read || !read.complete || (read.total !== null && read.records.length < read.total)) return null
          // The table itself is asked for as proof that the query was applied as written.
          if (!read.records.some((row) => row.name === table)) return null
          for (const row of read.records) {
            if (row.name === table) continue
            const parents = parentsOf(row)
            // A row without a name, or with a gap among its parents, cannot be placed.
            if (!parents) return null
            const at = parents.findIndex((name) => group.includes(name))
            // A row that has none of the tables asked for among its parents matches none of the conditions.
            if (at < 0) return null
            // Up to the table it was found under, and from there the way that table was found.
            below.set(row.name, [row.name, ...parents.slice(0, at + 1), ...(below.get(parents[at])?.slice(1) ?? [])])
            // Found at the eighth parent: what is below this one was out of sight.
            if (at === PARENT_DEPTH - 1) deepest.add(row.name)
          }
        }
        above = [...deepest]
      }
      return below
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
      const page = await this.gated.query<Record<string, string>>({ table: 'sys_script', query, fields: ['sys_id', 'action_query'], limit: 1 })
      // The answer checks its own query: a row without the field means the instance does not know it and ignored the condition.
      if (page.total === null || (page.records[0] && !('action_query' in page.records[0]))) {
        throw unusableAnswer('The instance did not answer the question about query business rules as it was asked.', 'sys_script')
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
      const page = await this.gated.query<Record<string, string>>({ table: 'sys_properties', query: `name=${name}`, fields: ['name', 'value'], limit: 1 }).catch(unlessNoConnection(null))
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
      const page = await this.gated.query<Record<string, string>>({ table: 'sys_archive', query, fields: ['sys_id', 'table', 'active'], limit: 1 })
      // The answer checks its own query, as everywhere: a row without the fields means the conditions were ignored.
      if (page.total === null || (page.records[0] && !('table' in page.records[0] && 'active' in page.records[0]))) {
        throw unusableAnswer('The instance did not answer the question about archive rules as it was asked.', 'sys_archive')
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
      const page = await this.gated.query<Record<string, string>>({ table: 'sys_table_rotation', query: `name=${table}^type=rotate`, fields: ['name', 'type', 'duration', 'rotations'], limit: 1 })
      const row = page.records.find((item) => item.name === table && item.type === 'rotate')
      if (!row) {
        // An entry that matches and did not come back is hidden from this account. That is not "not rotated".
        if (page.total === null) throw unusableAnswer('The instance did not say how many rotation entries match, so it cannot be told whether one is hidden.', 'sys_table_rotation')
        if (page.total > 0) throw new ServiceNowError(`"${table}" has a rotation entry, but this account may not read it.`, 'acl', 'sys_table_rotation')
        return null
      }
      // Measured: the duration is stored as a point in time counted from 1970-01-01, seven days as "1970-01-08 00:00:00".
      const length = Date.parse(`${String(row.duration).replace(' ', 'T')}Z`) / 86_400_000
      const rotations = Number(row.rotations)
      if (!Number.isFinite(length) || length <= 0 || !Number.isInteger(rotations) || rotations <= 0) {
        throw unusableAnswer(`"${table}" is rotated, but how long it keeps its rows could not be read from its entry.`, 'sys_table_rotation')
      }
      // Two decimals: a rotation of six hours is a quarter of a day, not "0.3" and not "0".
      return { rotations, days: Math.round(length * 100) / 100 }
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
        // The chain so far ended on this table because one request sees no further. What it extends is not known,
        // and a chain cut short would pass for a complete one.
        throw unusableAnswer(`"${current}", a parent of "${name}", did not come back from sys_db_object, so the parents above it could not be read.`, 'sys_db_object')
      }

      if (chain.length === 0) {
        chain.push(name)
        label = String(row.label ?? '')
        remote = row.scriptable_table === 'true'
      }

      // Read like every row of this table: a gap among the parents, or a name that is none, is not the end of the chain.
      const parents = row.name === current ? parentsOf(row) : null
      if (!parents || parents.some((parent) => chain.includes(parent)) || chain.length + parents.length > MAX_CHAIN) {
        throw unusableAnswer(`sys_db_object returned a parent chain for "${name}" that cannot be used.`, 'sys_db_object')
      }
      chain.push(...parents)

      // Deeper than one request can see: continue from the last parent found.
      if (parents.length < PARENT_FIELDS.length) break
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
    // Not every sys_id is 32 hex digits. One that cannot go into a query leaves the tables of the view unknown,
    // which is not the same as "no such view".
    if (!/^[0-9A-Za-z_]{1,32}$/.test(String(view.sys_id))) {
      throw unusableAnswer(`The definition of the database view "${name}" came back without a usable sys_id, so the tables it joins could not be read.`, 'sys_db_view')
    }

    const joined = await this.sn.query<Record<string, string>>({
      table: 'sys_db_view_table',
      query: `view=${view.sys_id}^active=true^ORDERBYorder`,
      fields: ['sys_id', 'table', 'variable_prefix'],
      limit: 50,
    })
    // Without a total a short list proves nothing: access rules take rows off a page after it was cut.
    if (joined.total === null || joined.records.length < joined.total) {
      throw new ServiceNowError(`The tables of the database view "${name}" are only partly readable, or it could not be told whether they are complete.`, 'acl', 'sys_db_view_table')
    }

    // A view can list the fields it takes from a table it joins. Measured: 103 of 558 views of an instance do, and
    // a condition on a field outside such a list is dropped. Where the lists cannot be read, no field is taken on trust.
    const ids = joined.records.map((row) => String(row.sys_id ?? '')).filter((id) => /^[0-9A-Za-z_]{1,32}$/.test(id))
    // Read like the request of any tool: the lists are no part of what the gate of closed tables is built from.
    const lists = ids.length
      ? await this.gated
          .all<Record<string, string>>({ table: 'sys_db_view_table_field', query: `view_tableIN${ids.join(',')}`, fields: ['view_table', 'field'] })
          .then((read) => (read.complete && read.total !== null && read.records.length === read.total ? read.records : null))
          .catch(unlessNoConnection(null))
      : []
    const listOf = (id: string): string[] | null | undefined => {
      // Not read, or a table of the view whose own id cannot be used: then it is not known whether it has a list.
      if (!lists || !ids.includes(id)) return null
      const own = lists.filter((row) => row.view_table === id).map((row) => String(row.field ?? ''))
      return own.length ? own : undefined
    }
    const members = joined.records
      .filter((row) => isTableName(row.table) && row.table !== name && /^[a-z0-9_]{1,40}$/.test(String(row.variable_prefix)))
      .map((row) => {
        const fields = listOf(String(row.sys_id ?? ''))
        return { table: row.table, prefix: String(row.variable_prefix), ...(fields === undefined ? {} : { fields }) }
      })
    // A row that cannot be used means the list of joined tables is not complete.
    if (members.length < joined.records.length || (joined.total === null && joined.records.length === 50)) {
      throw unusableAnswer(`The tables of the database view "${name}" could not be read completely.`, 'sys_db_view_table')
    }
    // A view answers with the rows of the tables it joins. With none listed, whose rows it holds is not known.
    if (!members.length) {
      throw unusableAnswer(`The database view "${name}" came back without a table it joins, so it could not be told whose rows it holds.`, 'sys_db_view_table')
    }
    return { name, label: String(view.label ?? ''), chain: [name], kind: 'database_view', members }
  }

  private readonly carried = new Map<string, Entry<boolean>>()
  /** The views that were seen to have a row, and when. */
  private readonly someRow = new Map<string, number>()

  /**
   * true if the instance applies a condition on this field of a view, or on this path from one of its fields.
   *
   * Measured on 40 views with a field list: a field outside the list is applied where a row of the view carries it
   * all the same (sys_id, sys_class_name and the two domain fields, not always the same ones) and dropped where no
   * row does, or refused with 403. A field on the list is applied, but not every one: of eight listed fields of one
   * joined table, the instance dropped the condition on one. So the definition of a view does not say which of its
   * fields can be filtered by, and the instance is asked: see proveCondition. Without a row in the view the
   * questions prove nothing, and the answer is not remembered.
   */
  async viewCarries(view: string, path: string): Promise<boolean> {
    const key = `${view}.${path}`
    const known = this.carried.get(key)
    if (known && Date.now() - known.at < this.ttlMs) return known.value
    // A view that is closed on this machine is refused as that, not as a field that could not be proven.
    const read = (query: string) =>
      this.gated.query({ table: view, query, fields: ['sys_id'], limit: 1 }).catch((error) => {
        if (noConnection(error) || (error instanceof ServiceNowError && error.kind === 'blocked')) throw error
        return null
      })
    // Whether the view has a row is asked once for all of its fields: on a large view that question is the slow
    // one. Only "it has one" is remembered: a view that was empty can have rows by the next question.
    const ask = async (query: string) => {
      if (query !== '') return read(query)
      const seen = this.someRow.get(view)
      if (seen !== undefined && Date.now() - seen < this.ttlMs) return { total: 1, records: [{}] }
      const answer = await read('')
      if (answer && (answer.records.length > 0 || (answer.total ?? 0) > 0)) {
        if (this.someRow.size >= MAX_ENTRIES) this.someRow.clear()
        this.someRow.set(view, Date.now())
      }
      return answer
    }
    const proof = await proveCondition(ask, path, (await this.emptyOnInvalidQuery()) === false)
    if (proof === 'applied') {
      if (this.carried.size >= MAX_ENTRIES) this.carried.clear()
      this.carried.set(key, { value: Promise.resolve(true), at: Date.now() })
    }
    return proof === 'applied' || proof === 'no_rows'
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
          const outside = member.fields === null || (member.fields !== undefined && !member.fields.includes(column.name))
          const mark = outside ? { outsideList: true, ...(member.fields === null ? { listUnread: true } : {}) } : {}
          columns.set(`${member.prefix}_${column.name}`, { ...column, name: `${member.prefix}_${column.name}`, definedOn: member.table, sourceField: column.name, sourceDefinedOn: column.definedOn, ...mark })
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
