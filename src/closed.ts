import type { Gate, ServiceNowClient } from './client.js'
import type { Dictionary } from './dictionary.js'
import { noConnection, ServiceNowError } from './errors.js'
import { withCondition } from './query.js'
import { currentCall } from './trace.js'

/**
 * The rules for tables that are closed on this machine (SERVICENOW_TABLE_ALLOW,
 * SERVICENOW_TABLE_DENY), in one place.
 *
 * A table is closed if a list says so, if it is a child table of a closed one
 * (its rows are rows of that table), or if it is a database view that joins a
 * closed one. A request must not read a closed table in any of the ways there
 * are: as the table it asks, through a reference it walks, as rows of a parent
 * table, or as the name behind a reference.
 *
 * The client asks this for every request, whichever tool sends it. A tool does
 * not have to remember the rules, and a new tool cannot forget them.
 */
export interface ClosedTables extends Gate {
  /** Why a table is closed, as a part of a sentence, or null if it is open. */
  reason(table: string): Promise<string | null>
  /** Whether a record of this table can be a row of a closed one: the table is closed, or a table below it is. */
  mayHoldClosed(table: string): Promise<boolean>
}

/** Comments, work notes and the like: their entries are rows of another table. */
const JOURNALS = new Set(['journal', 'journal_input', 'journal_list'])

/** A query this long does not fit into a URL any more. */
const MAX_SENT_QUERY = 7_000

export function closedTables(sn: ServiceNowClient, dict: Dictionary): ClosedTables {
  const blocked = (message: string, table: string) => new ServiceNowError(`${message} Nothing was sent.`, 'blocked', table)
  const childOf = (table: string, parent: string) => `"${table}" is a child table of ${parent}, which is closed on this machine: its rows are rows of that table`
  /** For a look-up that failed: a lost connection is passed on as it is, anything else is the value given. */
  const unless =
    <T>(fallback: T) =>
    (error: unknown): T => {
      if (noConnection(error)) throw error
      return fallback
    }

  async function reason(table: string, seen = new Set<string>()): Promise<string | null> {
    if (!sn.restricted || seen.has(table)) return null
    seen.add(table)
    if (!sn.allows(table)) return `"${table}" is closed on this machine`

    // With a deny list: the tables it closes and everything below them, asked for once.
    const chain = (await dict.closedTables()).get(table)
    if (chain) return childOf(table, chain.find((name) => !sn.allows(name)) ?? 'a closed table')

    let info
    try {
      info = await dict.table(table)
    } catch (error) {
      // Not being able to log in is not a closed table.
      if (noConnection(error)) throw error
      return `it could not be established whether "${table}" is a child table of a closed one`
    }
    // Neither a table nor a database view the instance lists: then nothing says what it is a child of or what it
    // joins. That can also mean that the entry is hidden from this account.
    if (!info) return `it could not be established what "${table}" is: the instance lists it neither as a table nor as a database view`
    const parent = info.chain.slice(1).find((name) => !sn.allows(name))
    if (parent) return childOf(table, parent)
    for (const member of info.members ?? []) {
      const why = await reason(member.table, seen)
      if (why) return `"${table}" is a database view, and ${why}`
    }
    return null
  }

  /** The closed tables below a table that a deny list names, matches or closes as children of those. */
  async function deniedBelow(table: string): Promise<string[]> {
    return [...(await dict.closedTables())]
      .filter(([name, chain]) => name !== table && chain.includes(table))
      .map(([name]) => name)
      .sort()
  }

  /**
   * With a list of the only tables that may be read: the tables below this one that are closed. A table is closed
   * if it is not on the list, and also if it is on it and a table between it and this one is not: its rows are
   * rows of that table. "unlisted" says whether any is not on the list, which a condition on the class can leave
   * out by itself; "byParent" names those that are on the list and closed all the same. null where the tables
   * below cannot be listed.
   */
  async function allowedBelow(table: string): Promise<{ unlisted: boolean; byParent: string[] } | null> {
    if (!sn.openClasses()) return { unlisted: false, byParent: [] }
    const children = await dict.childTables(table)
    if (!children) return null
    const byParent = [...children].filter(([name, chain]) => sn.allows(name) && chain.slice(1, -1).some((parent) => !sn.allows(parent))).map(([name]) => name)
    return { unlisted: [...children.keys()].some((name) => !sn.allows(name)), byParent: byParent.sort() }
  }

  async function mayHoldClosed(table: string): Promise<boolean> {
    if (!sn.restricted) return false
    if ((await reason(table)) !== null || (await deniedBelow(table)).length > 0) return true
    const below = await allowedBelow(table)
    return below === null || below.unlisted || below.byParent.length > 0
  }

  /**
   * The condition on a class field that keeps the rows of closed child tables out of what a table answers. Rows
   * without a class stay in: measured, "NOT IN" alone would drop them. null if no closed table is below this one,
   * so that an answer about incidents carries no note about users.
   */
  async function classCondition(table: string, field: string): Promise<string | null> {
    const parts: string[] = []
    const listed = await allowedBelow(table)
    // Where the tables below cannot be listed, only the classes on the list are let through: that is all that can
    // be said, and a class on the list with a closed parent in between cannot be told. So nothing is sent.
    if (!listed) throw blocked(`Tables are closed on this machine, and the tables below "${table}" could not be listed, so it cannot be told which of its rows belong to a closed one.`, table)
    const closed = [...new Set([...(await deniedBelow(table)), ...listed.byParent])].sort()
    if (closed.length) parts.push(`${field}NOT IN${closed.join(',')}^OR${field}ISEMPTY`)
    if (listed.unlisted) parts.push(sn.openClasses(field)!)
    return parts.length ? parts.join('^') : null
  }

  /**
   * Whether the instance applies a condition on a class field for this account. The rows of closed child tables
   * are left out by such a condition, and an instance that drops it answers with them, without a sign. It can drop
   * one: for a field it does not know, for a view that lists the fields it shows (measured: applied all the same
   * on one instance), or for an account that may not filter by the field. So the instance is asked once per table
   * and field for rows whose class is empty and filled at once, which has to match nothing.
   */
  const applied = new Set<string>()
  async function appliesCondition(table: string, field: string): Promise<boolean> {
    if (applied.has(`${table}.${field}`)) return true
    const page = await sn.query({ table, query: `${field}ISEMPTY^${field}ISNOTEMPTY`, fields: ['sys_id'], limit: 1, trusted: true }).catch(unless(null))
    if (!page || page.total !== 0 || page.records.length) return false
    applied.add(`${table}.${field}`)
    return true
  }
  /** The condition, after the instance has shown that it applies one on that field. */
  async function proven(table: string, field: string, condition: string | null, what: string): Promise<string | null> {
    if (!condition || (await appliesCondition(table, field))) return condition
    throw blocked(`${what}, and it could not be established that the instance applies a condition on "${field}" for this account: the rows of those tables could not be left out.`, table)
  }

  return {
    reason: (table) => reason(table),
    mayHoldClosed,

    async enter(table, query, paths) {
      const why = await reason(table)
      if (why) throw blocked(`${why[0].toUpperCase()}${why.slice(1)}.`, table)

      const conditions: string[] = []
      const dotted = [...new Set(paths.filter((path) => path.includes('.')))]
      if (dotted.length) {
        const check = await dict.checkFields(table, dotted)
        for (const name of check.reached) {
          const closed = await reason(name)
          if (closed) throw blocked(`This request reads from ${name} through a dot-walk or a database view, and ${closed}.`, name)
        }
        if (check.status !== 'checked' || check.unknown.length) {
          const what = check.reason ?? check.unknown.map((item) => `${item.field}: ${item.reason}`).join('; ')
          throw blocked(`Tables are closed on this machine, and it could not be established which tables this request reads from (${what}).`, table)
        }
        // A reference into a parent table reaches the rows of its closed child tables as well.
        for (const [prefix, target] of check.walks) {
          const field = `${prefix}.sys_class_name`
          const condition = await proven(table, field, await classCondition(target, field), `"${prefix}" points into "${target}", which has closed tables below it`)
          if (condition) conditions.push(condition)
        }
      }

      const info = await dict.table(table).catch(unless(null))
      if (info?.kind === 'database_view') {
        // A view has no class of its own. Each table it joins brings its child tables along, under its prefix.
        for (const member of info.members ?? []) {
          // A view that joins another view, or something the instance does not know as a table: whose rows it
          // holds cannot be established one level down, so it is not read while tables are closed.
          const joined = await dict.table(member.table).catch(unless(null))
          if (!joined || joined.kind === 'database_view') {
            throw blocked(`"${table}" is a database view that joins "${member.table}", which is ${joined ? 'a view itself' : 'not known as a table'}: with tables closed on this machine it cannot be established whose rows it holds.`, table)
          }
          const field = `${member.prefix}_sys_class_name`
          const condition = await proven(table, field, await classCondition(member.table, field), `"${table}" is a database view that joins "${member.table}", which has closed tables below it`)
          if (condition) conditions.push(condition)
        }
      } else {
        const condition = await proven(table, 'sys_class_name', await classCondition(table, 'sys_class_name'), `"${table}" has closed tables below it`)
        if (condition) conditions.push(condition)
      }
      if (!conditions.length) return query

      const sent = conditions.reduce((whole, condition) => withCondition(whole, condition), query)
      if (sent.length > MAX_SENT_QUERY) {
        throw blocked(`"${table}" has more closed child tables below it than a query can leave out. Query one of its open child tables instead.`, table)
      }
      const call = currentCall()
      if (call) call.closed.rowsLeftOut = true
      return sent
    },

    async hidesNames(table, path) {
      if (!sn.restricted) return null
      const check = await dict.checkFields(table, [path])
      const column = check.resolved.get(path)
      // Which table the name comes from is not known: the type could not be read, or the field can point anywhere.
      if (!column?.type || column.type === 'document_id') return 'untold'
      // The display value of a journal field is the text of its entries, which are rows of sys_journal_field.
      const target = column.type === 'domain_id' ? 'domain' : JOURNALS.has(column.type) ? 'sys_journal_field' : column.reference
      if (column.type !== 'reference' && column.type !== 'glide_list' && !target) return null
      if (!target) return 'untold'
      return (await mayHoldClosed(target)) ? 'closed' : null
    },
  }
}
