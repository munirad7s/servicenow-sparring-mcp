import type { Gate, ServiceNowClient } from './client.js'
import type { Dictionary } from './dictionary.js'
import { noConnection, ServiceNowError, unlessNoConnection } from './errors.js'
import { isTableName, withCondition } from './query.js'
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
/** Fields that store the sys_id of an attachment. Measured: their display value is the name of its file. */
const ATTACHMENTS = new Set(['file_attachment', 'audio', 'video'])
/**
 * Kinds of fields whose display value names no record of another table. Measured on one instance, for each of
 * its 167 kinds of fields: 35 show something other than they store. For those listed here that is a label, a
 * date in another form, a number with its unit, or the path of an image. A kind that is not listed and has no
 * table it points to is not shown while tables are closed: a condition shows the names behind the sys_ids it
 * holds, and what a kind that was not measured shows is not known.
 */
const SHOWS_ITSELF = new Set(
  (
    'string integer boolean GUID json table_name decimal float double longint long int numeric choice radio sys_class_name sys_class_code sys_class_path field_name short_field_name short_table_name ' +
    'glide_date_time glide_date glide_time glide_duration glide_precise_time glide_utc_time due_date date datetime date_time calendar_date_time schedule_date_time integer_date integer_time timer time ' +
    'day_of_week days_of_week month_of_year week_of_month repeat_type repeat_count counter auto_increment auto_number order_index percent_complete currency currency2 price ' +
    'translated translated_text translated_field translated_html translate_field translatable_text html html_script html_template wiki_text markdown url email ph_number phone_number_e164 ip_addr ip_address ' +
    'script script_plain script_server script_client email_script css XML color color_display bootstrap_color glyphicon Icon nds_icon image user_image workflow internal_type version hash char ' +
    'string_full_utf8 string_full_utf_8 medium_text mediumtext wide_text multi_two_lines multi_small sysevent_name language api_version insert_timestamp json_translations graphql_schema formula'
  ).split(' '),
)
/**
 * Tables whose rows are copies of records of other tables, by the parent they are rows of. Measured: a linked
 * application file (sys_metadata_link) carries the name of the record it links to as its own name, and the record
 * as its payload. Read from its own table, the row says which table that record is of. Read as a row of the
 * parent it does not, so while tables are closed the parent answers without these rows.
 */
const COPIES_BELOW: Record<string, string[]> = { sys_metadata: ['sys_metadata_link'] }

/**
 * As long as a query may be once it is written into the address of a request. Measured: an instance took an
 * address of 8,218 characters and answered HTTP 414 to one of 8,223, and a caret or a comma takes three of them.
 * The rest is left for the fields a request names.
 */
const MAX_SENT_QUERY = 6_000
/** How long a proof that the instance applies a condition holds, and how many are kept. */
const PROOF_TTL_MS = 10 * 60_000
const MAX_PROOFS = 400
/** Values no class has, for a question that has to match nothing. */
const NO_SUCH_CLASS = ['zz__no_such_class_a', 'zz__no_such_class_b']

/**
 * A table that holds rows of another without being its child table. A rotated table is spread over parts named
 * after it with four digits, and an archive rule moves rows into "ar_<table>". Measured on one instance: of 357
 * parts, every one is named that way or is the table itself; "syslog0003" has no parent, is read like any table,
 * and answered with 655,964 rows of syslog and of its child tables.
 */
const holdsRowsOf = (name: string): string | null => /^ar_(.+)$/.exec(name)?.[1] ?? /^(.+)\d{4}$/.exec(name)?.[1] ?? null

export function closedTables(sn: ServiceNowClient, dict: Dictionary): ClosedTables {
  const blocked = (message: string, table: string) => new ServiceNowError(`${message} Nothing was sent.`, 'blocked', table)
  const childOf = (table: string, parent: string) => `"${table}" is a child table of ${parent}, which is closed on this machine: its rows are rows of that table`
  /**
   * What a table is and which fields it has is read from sys_db_object and sys_dictionary, without these rules:
   * they are decided from them. Where a list closes one of the two as a child of another table, nothing can be
   * established without reading a closed table, so nothing is read. A deny list is held against that where its
   * tables are listed. With a list of the only tables that may be read, the tables the two extend have to be on
   * it as well: this says which one is missing.
   */
  async function closedFoundation(): Promise<string | null> {
    if (!sn.openClasses()) return null
    for (const name of ['sys_db_object', 'sys_dictionary']) {
      if (!sn.allows(name)) continue
      const info = await dict.table(name).catch(unlessNoConnection(null))
      const parent = info?.chain.slice(1).find((above) => !sn.allows(above))
      if (parent) return `"${name}", which this server reads for every check, is a child table of ${parent}, which is not on SERVICENOW_TABLE_ALLOW: with that list nothing can be established without reading a closed table`
    }
    return null
  }

  async function reason(table: string, seen = new Set<string>()): Promise<string | null> {
    if (!sn.restricted || seen.has(table)) return null
    seen.add(table)
    if (!sn.allows(table)) return `"${table}" is closed on this machine`
    const foundation = await closedFoundation()
    if (foundation) return foundation

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
      // A view that joins another view, or something the instance does not know as a table: whose rows it holds
      // cannot be established one level down, so it is not read, and not described, while tables are closed.
      const joined = await dict.table(member.table).catch(unlessNoConnection(null))
      if (!joined || joined.kind === 'database_view') {
        return `"${table}" is a database view that joins "${member.table}", which is ${joined ? 'a view itself' : 'not known as a table'}: with tables closed on this machine it cannot be established whose rows it holds`
      }
      const why = await reason(member.table, seen)
      if (why) return `"${table}" is a database view, and ${why}`
    }
    // A part of a rotated table, or the archive of a table, holds the rows of that table and of its child tables.
    for (const name of info.chain) {
      const base = holdsRowsOf(name)
      if (!base || !isTableName(base) || seen.has(base)) continue
      let known
      try {
        known = await dict.table(base)
      } catch (error) {
        if (noConnection(error)) throw error
        return `it could not be established whether "${name}" holds rows of "${base}"`
      }
      // No such table: the name only looks like a part or an archive.
      if (!known || known.kind === 'database_view') continue
      const why = await reason(base, seen)
      if (why) return `"${name}" holds rows of ${base} (a part of a rotated table, or its archive), and ${why}`
      if (await holdsClosedBelow(base)) {
        return `"${name}" holds rows of ${base} (a part of a rotated table, or its archive), which has closed tables below it: ask "${base}" itself, where their rows are left out`
      }
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

  /** Whether a table that is open has a closed table below it, or may have one. */
  async function holdsClosedBelow(table: string): Promise<boolean> {
    if (COPIES_BELOW[table]?.length || (await deniedBelow(table)).length > 0) return true
    const below = await allowedBelow(table)
    return below === null || below.unlisted || below.byParent.length > 0
  }

  async function mayHoldClosed(table: string): Promise<boolean> {
    if (!sn.restricted) return false
    return (await reason(table)) !== null || (await holdsClosedBelow(table))
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
    const closed = [...new Set([...(await deniedBelow(table)), ...listed.byParent, ...(COPIES_BELOW[table] ?? [])])].sort()
    if (closed.length) parts.push(`${field}NOT IN${closed.join(',')}^OR${field}ISEMPTY`)
    if (listed.unlisted) parts.push(sn.openClasses(field)!)
    return parts.length ? parts.join('^') : null
  }

  /**
   * Whether the instance applies a condition on a class field for this account. The rows of closed child tables
   * are left out by such a condition, and an instance that drops it answers with them, without a sign. It can drop
   * one: for a field it does not know, for a view that lists the fields it shows (measured: applied all the same
   * on one instance), or for an account that may not filter by the field.
   *
   * So the instance is asked, per table and field, for rows that are two things at once, which has to match
   * nothing: a class that is empty and filled, and, where the condition uses them, a class that is one of two
   * names and one that starts with two. "Is" and "starts with" are asked apart, because an instance can allow one
   * and not the other (query_match, query_range). Each question stands alone in its query: measured, a part of a
   * query whose conditions are dropped adds no rows, so several in one query would prove nothing.
   *
   * A table without rows answers every question with none, also the one it would have dropped. Such an answer
   * is taken for this request, where it gives nothing away, and not remembered for the next.
   */
  const proofs = new Map<string, { at: number; applied: Promise<boolean> }>()
  async function prove(table: string, field: string, kinds: string[]): Promise<{ applied: boolean; lasting: boolean }> {
    const [a, b] = NO_SUCH_CLASS
    const questions = kinds.map((kind) => (kind === 'ISEMPTY' ? `${field}ISEMPTY^${field}ISNOTEMPTY` : `${field}${kind}${a}^${field}${kind}${b}`))
    const ask = (query: string) => sn.query({ table, query, fields: ['sys_id'], limit: 1, trusted: true }).catch(unlessNoConnection(null))
    const [any, ...answers] = await Promise.all([ask(''), ...questions.map(ask)])
    const applied = answers.every((page) => page !== null && page.total === 0 && page.records.length === 0)
    return { applied, lasting: Boolean(any && (any.records.length > 0 || (any.total ?? 0) > 0)) }
  }
  function appliesCondition(table: string, field: string, condition: string): Promise<boolean> {
    // Names of tables are written in small letters and operators in capitals, so a name cannot pass for one.
    const kinds = ['ISEMPTY', ...(condition.includes('IN') ? ['IN'] : []), ...(condition.includes('STARTSWITH') ? ['STARTSWITH'] : [])]
    const key = `${table}.${field} ${kinds.join(' ')}`
    const hit = proofs.get(key)
    if (hit && Date.now() - hit.at < PROOF_TTL_MS) return hit.applied

    const proof = prove(table, field, kinds)
    const entry = { at: Date.now(), applied: proof.then((result) => result.applied) }
    proofs.delete(key)
    proofs.set(key, entry)
    if (proofs.size > MAX_PROOFS) proofs.delete(proofs.keys().next().value as string)
    const forget = () => {
      if (proofs.get(key) === entry) proofs.delete(key)
    }
    proof.then((result) => {
      if (!result.applied || !result.lasting) forget()
    }, forget)
    return entry.applied
  }
  /** The condition, after the instance has shown that it applies one on that field. */
  async function proven(table: string, field: string, condition: string | null, what: string): Promise<string | null> {
    if (!condition || (await appliesCondition(table, field, condition))) return condition
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

      // What the table is was read a moment ago, to say whether it is closed. Where it cannot be read again, it
      // is not known whether this is a view, and whose rows a condition would have to leave out.
      const info = await dict.table(table).catch(unlessNoConnection(null))
      if (!info) throw blocked(`Tables are closed on this machine, and it could not be established what "${table}" is.`, table)
      if (info.kind === 'database_view') {
        // A view has no class of its own. Each table it joins brings its child tables along, under its prefix.
        for (const member of info.members ?? []) {
          const field = `${member.prefix}_sys_class_name`
          const condition = await proven(table, field, await classCondition(member.table, field), `"${table}" is a database view that joins "${member.table}", which has closed tables below it`)
          if (condition) conditions.push(condition)
        }
      } else {
        const condition = await proven(table, 'sys_class_name', await classCondition(table, 'sys_class_name'), `"${table}" has closed tables below it`)
        if (condition) conditions.push(condition)
      }
      if (!conditions.length) return query

      // All of them at once, and not before it is known that the result stays a request: a query of many parts
      // takes the conditions once per part.
      const added = conditions.join('^')
      const tooLong = () => blocked(`"${table}" has more closed child tables below it than a query can leave out. Query one of its open child tables instead.`, table)
      if (query.length + query.split('^NQ').length * (added.length + 1) > 4 * MAX_SENT_QUERY) throw tooLong()
      const sent = withCondition(query, added)
      if (encodeURIComponent(sent).length > MAX_SENT_QUERY) throw tooLong()
      const call = currentCall()
      if (call) call.closed.rowsLeftOut = true
      return sent
    },

    async hidesNames(table, path, shown = false) {
      if (!sn.restricted) return null
      const check = await dict.checkFields(table, [path])
      const column = check.resolved.get(path)
      // Which table the name comes from is not known: the type could not be read, or the field can point anywhere.
      if (!column?.type || column.type === 'document_id') return 'untold'
      // The display value of a journal field is the text of its entries, which are rows of sys_journal_field.
      const target = column.type === 'domain_id' ? 'domain' : JOURNALS.has(column.type) ? 'sys_journal_field' : ATTACHMENTS.has(column.type) ? 'sys_attachment' : column.reference
      if (target) return (await mayHoldClosed(target)) ? 'closed' : null
      if (column.type === 'reference' || column.type === 'glide_list') return 'untold'
      // A comparison with text works on what such a field stores. What it shows is another matter.
      return shown && !SHOWS_ITSELF.has(column.type) ? 'untold' : null
    },
  }
}
