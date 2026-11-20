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
 * as its payload; the entry for a deleted application file (sys_metadata_delete) keeps the name of the record that
 * was deleted. Read from its own table, the row is judged by what says which table that record is of. Read as a
 * row of the parent it is not, so while tables are closed the parent answers without these rows.
 */
const COPIES_BELOW = new Map([['sys_metadata', ['sys_metadata_delete', 'sys_metadata_link']]])

/**
 * Tables whose rows show, as their own name, the name of a record of another table. Measured: a reference into the
 * table of deleted records shows the name of the record that was deleted (59 of 60 cells), one into the log of
 * archived records the name of the archived record (20 of 20), and one into the entries for deleted application
 * files the name of the deleted file (71 of 100). A linked application file is named after the record it links
 * to, and what one scope may use of another shows the name of that thing. Read from the table itself, each name
 * is judged by the table of its record. Behind a reference nothing says which table that is, so there the name is
 * left out while tables are closed.
 */
const NAMED_AFTER_OTHERS = new Set(['sys_audit_delete', 'sys_archive_log', 'sys_metadata_delete', 'sys_metadata_link', 'sys_scope_privilege'])
/** As many tables as are followed from one reference to see whose name it shows in the end. */
const MAX_NAMES_BEHIND = 6

/**
 * The table whose records a field shows the names of. The display value of a journal field is the text of its
 * entries, which are rows of sys_journal_field; an attachment field shows the name of a file.
 */
const shownFrom = (column: { type: string; reference: string | null } | undefined): string | null =>
  !column ? null : column.type === 'domain_id' ? 'domain' : JOURNALS.has(column.type) ? 'sys_journal_field' : ATTACHMENTS.has(column.type) ? 'sys_attachment' : column.reference

/**
 * As long as a query may be once it is written into the address of a request. Measured: an instance took a path
 * with its parameters of 8,177 characters and answered HTTP 414 to one of 8,178, and a caret or a comma takes
 * three of them. The rest is left for the fields a request names.
 */
const MAX_SENT_QUERY = 6_000
/** How long a proof that the instance applies a condition holds, and how many are kept. */
const PROOF_TTL_MS = 10 * 60_000
const MAX_PROOFS = 400
/** Values no class has, for a question that has to match nothing. */
const NO_SUCH_CLASS = ['zz__no_such_class_a', 'zz__no_such_class_b']

/**
 * A table can hold rows of another without being its child table. An archive rule moves rows into "ar_<table>",
 * and a rotated table is spread over parts. Measured on one instance: "syslog0003" has no parent, is read like any
 * table, and answered with 655,964 rows of syslog and of its child tables. Of 327 parts, 319 are named after the
 * table with four digits and 8 with one digit ("sys_replication_queue2").
 */
const archiveOf = (name: string): string | undefined => /^ar_(.+)$/.exec(name)?.[1]
/** By the name alone, a table that ends in digits can be a part of the table without them, or without the last four. */
const partOfByName = (name: string): Array<string | undefined> => [/^(.*?[^\d])\d+$/.exec(name)?.[1], /^(.+)\d{4}$/.exec(name)?.[1]]
const tableNames = (names: Array<string | undefined>, but: string): string[] => [...new Set(names)].filter((name): name is string => isTableName(name) && name !== but)

/**
 * The tables a table can hold rows of, going by its name alone: for where the instance cannot be asked which
 * tables are parts of a rotated one, and for the name of a record. A name can be read more than one way
 * ("ar_incident0001" as the archive of a part, or as a part of the archive), so every reading is given.
 */
export const holdsRowsOf = (name: string): string[] => tableNames([archiveOf(name), ...partOfByName(name)], name)

export function closedTables(sn: ServiceNowClient, dict: Dictionary): ClosedTables {
  const blocked = (message: string, table: string) => new ServiceNowError(`${message} The request was not sent.`, 'blocked', table)
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
      // What the table extends could not be read: then it is not known whether the list closes it.
      if (!info) return `it could not be established what "${name}" extends, which this server reads for every check, so it cannot be told whether SERVICENOW_TABLE_ALLOW closes it through a parent table`
      const parent = info.chain.slice(1).find((above) => !sn.allows(above))
      if (parent) return `"${name}", which this server reads for every check, is a child table of ${parent}, which is not on SERVICENOW_TABLE_ALLOW: with that list nothing can be established without reading a closed table`
    }
    return null
  }

  async function reason(table: string, seen = new Set<string>()): Promise<string | null> {
    if (!sn.restricted || seen.has(table)) return null
    seen.add(table)
    if (!sn.allows(table)) return `"${table}" is closed on this machine`
    // The lists below are kept for ten minutes. A table created under a closed one in that time is seen by the
    // look that stands in front of each of them, in the dictionary: every answer about tables passes it.
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
    // Which tables are parts of a rotated one, the instance says in a list. Where that list cannot be read, or
    // is closed on this machine, the name of a table has to do.
    const listed = sn.allows('sys_table_rotation_schedule') && sn.allows('sys_table_rotation') ? await dict.rotatedParts() : null
    // The list is remembered for a while, and a part that the instance creates in between is not on it. So a name
    // that is the name of a rotated table with digits behind it counts as a part of it, on the list or not. Read
    // from the names of the rotated tables, not cut off the name: the name of a rotated table can end in a digit.
    const likeAPart = (name: string) => [...(listed?.rotated ?? [])].filter((base) => name.length > base.length && name.startsWith(base) && /^\d+$/.test(name.slice(base.length)))
    // What the list says about a table goes before what its name looks like: "u_log2001" is listed as a part of
    // "u_log", and is no part of a rotated "u_log2" then.
    const basesOf = (name: string) => tableNames([archiveOf(name), ...(listed ? (listed.parts.has(name) ? [listed.parts.get(name)] : likeAPart(name)) : partOfByName(name))], name)
    for (const [name, base] of info.chain.flatMap((name) => basesOf(name).map((base) => [name, base]))) {
      // A table the deny list names counts whether or not the instance still has it: its archive can outlive it.
      if (sn.denies(base)) return `"${name}" holds rows of ${base} (a part of a rotated table, or its archive), and "${base}" is closed on this machine`
      let known
      try {
        known = await dict.table(base)
      } catch (error) {
        if (noConnection(error)) throw error
        return `it could not be established whether "${name}" holds rows of "${base}"`
      }
      // No such table: the name only looks like a part or an archive.
      if (!known || known.kind === 'database_view') continue
      // A table that was looked at before in this question was found open, or the question would have ended there.
      // Whether it has a closed table below it is asked all the same: a view can join a table and its archive.
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
    if (COPIES_BELOW.has(table) || (await deniedBelow(table)).length > 0) return true
    const below = await allowedBelow(table)
    return below === null || below.unlisted || below.byParent.length > 0
  }

  async function mayHoldClosed(table: string): Promise<boolean> {
    if (!sn.restricted) return false
    return (await reason(table)) !== null || (await holdsClosedBelow(table))
  }

  /**
   * Whose names a reference into a table shows. "closed": the table is closed, or has closed tables below it.
   * "copies": the table is open, and a row of it is named after a record of another table that is closed, or that
   * cannot be told. That is so for the tables listed above, and for a table whose display field is itself a
   * reference: measured, a reference into such a table shows the name behind the second reference (48 of 60
   * fields), so with users closed, ten of ten cells of a field two tables away carried the name of a user.
   * "untold": what a row of the table shows as its name could not be read.
   */
  async function namesBehind(target: string, seen = new Set<string>()): Promise<'closed' | 'copies' | 'untold' | null> {
    if (await mayHoldClosed(target)) return 'closed'
    // Read as itself, as a table below it, as its archive or as a part of it.
    const info = await dict.table(target).catch(unlessNoConnection(null))
    const names = new Set(info?.chain ?? [target])
    for (const name of names) for (const base of holdsRowsOf(name)) names.add(base)
    if ([...names].some((name) => NAMED_AFTER_OTHERS.has(name))) return 'copies'

    if (seen.has(target)) return null
    seen.add(target)
    const shown = await dict.displayReferences(target).catch(unlessNoConnection(null))
    if (!shown) return 'untold'
    for (const { reference } of shown) {
      // A document id, or a reference without a table: the record it names can be of any table.
      if (!reference || seen.size > MAX_NAMES_BEHIND) return 'copies'
      const further = await namesBehind(reference, seen)
      if (further === 'untold') return 'untold'
      if (further) return 'copies'
    }
    return null
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
    // A table below a table of copies holds copies as well.
    const copies: string[] = []
    for (const copy of COPIES_BELOW.get(table) ?? []) {
      const below = await dict.childTables(copy)
      if (!below) throw blocked(`Tables are closed on this machine, and the tables below "${copy}" could not be listed, so it cannot be told which rows of "${table}" carry the name of a record of another table.`, table)
      copies.push(copy, ...below.keys())
    }
    const closed = [...new Set([...(await deniedBelow(table)), ...listed.byParent, ...copies])].sort()
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
   * names, one that starts with two, and one that is a class and is not that class. "Is" and "starts with" are
   * asked apart, because an instance can allow one and not the other (query_match, query_range). Each question
   * stands alone in its query: measured, a part of a query whose conditions are dropped adds no rows, so several
   * in one query would prove nothing.
   *
   * A table without rows answers every question with none, also the one it would have dropped. Such an answer
   * is taken for this request, where it gives nothing away, and not remembered for the next. An instance that
   * answers a field it cannot use with no rows looks the same, so where no row shows a class it is asked for a
   * row with or without one: none, of a table that has rows, and the condition is not relied on.
   */
  const proofs = new Map<string, { at: number; applied: Promise<boolean> }>()
  async function prove(table: string, field: string, kinds: string[]): Promise<{ applied: boolean; lasting: boolean }> {
    const [a, b] = NO_SUCH_CLASS
    const ask = (query: string, fields = ['sys_id']) => sn.query<Record<string, unknown>>({ table, query, fields, limit: 1, trusted: true }).catch(unlessNoConnection(null))
    const nothing = (page: Awaited<ReturnType<typeof ask>>) => page !== null && page.total === 0 && page.records.length === 0
    const questions = kinds.filter((kind) => kind !== 'NOT IN').map((kind) => (kind === 'ISEMPTY' ? `${field}ISEMPTY^${field}ISNOTEMPTY` : `${field}${kind}${a}^${field}${kind}${b}`))
    if (!(await Promise.all(questions.map((query) => ask(query)))).every(nothing)) return { applied: false, lasting: false }

    // Only now is a row asked for that the questions above did not have to match nothing: one that has a class.
    // Where a question failed, no such request goes out. Without such a row no row of a closed class is there.
    const row = await ask(`${field}ISNOTEMPTY`, ['sys_id', field])
    // The question failed: that is no answer, and "no row has a class" would be read from it.
    if (row === null) return { applied: false, lasting: false }
    const some = (page: Awaited<ReturnType<typeof ask>>) => Boolean(page && (page.records.length > 0 || (page.total ?? 0) > 0))
    const lasting = some(row)
    if (!lasting) {
      // No row has a class. That is also what an instance answers that cannot use the field and is set to answer
      // such a query with no rows (glide.invalid_query.returns_no_rows): every question above then matches nothing,
      // and so would the request, which would say "no rows" of a table that has some. So the instance has to show
      // a row that has a class or has none, or else that the table has no row at all.
      if (!some(await ask(`${field}ISEMPTY^OR${field}ISNOTEMPTY`)) && !nothing(await ask(''))) return { applied: false, lasting: false }
    }
    // "Is not one of" is what leaves the rows out, and it is asked by itself where a row shows its class: rows of
    // that class that are not of that class. A view that does not show the field cannot be asked this way.
    const shown = row?.records[0]?.[field]
    if (kinds.includes('NOT IN')) {
      if (isTableName(shown)) {
        if (!nothing(await ask(`${field}=${shown}^${field}NOT IN${shown}`))) return { applied: false, lasting: false }
      } else if (lasting) {
        // Rows have a class, and the one asked for did not come back with it: hidden from this account, or a field
        // the instance does not hand out. Then "is not one of" cannot be asked, and it is not taken on trust.
        return { applied: false, lasting: false }
      }
    }
    return { applied: true, lasting }
  }
  function appliesCondition(table: string, field: string, condition: string): Promise<boolean> {
    // Names of tables are written in small letters and operators in capitals, so a name cannot pass for one.
    const kinds = ['ISEMPTY', ...(condition.includes('IN') ? ['IN'] : []), ...(condition.includes('NOT IN') ? ['NOT IN'] : []), ...(condition.includes('STARTSWITH') ? ['STARTSWITH'] : [])]
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
        const check = await dict.checkFields(table, dotted, false)
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

    async prepare(table, paths) {
      if (!sn.restricted) return
      // Best effort: whatever fails here fails again where each field is judged, and is dealt with there.
      const check = await dict.checkFields(table, paths, false).catch(unlessNoConnection(null))
      const targets = [...new Set(paths.map((path) => shownFrom(check?.resolved.get(path))).filter((target): target is string => Boolean(target)))]
      if (targets.length < 2) return
      // What each of these tables extends, in one request for forty of them, and then what each shows as its name.
      // That is read from the dictionary, also for a table that is closed: no row of the table is asked for.
      await dict.knownTables(targets).catch(unlessNoConnection(null))
      await dict.knowDisplayReferences(targets).catch(unlessNoConnection(null))
    },

    async hidesNames(table, path, shown = false) {
      if (!sn.restricted) return null
      const check = await dict.checkFields(table, [path], false)
      const column = check.resolved.get(path)
      // Which table the name comes from is not known: the type could not be read, or the field can point anywhere.
      if (!column?.type || column.type === 'document_id') return 'untold'
      const target = shownFrom(column)
      if (target) return namesBehind(target)
      if (column.type === 'reference' || column.type === 'glide_list') return 'untold'
      // A comparison with text works on what such a field stores. What it shows is another matter.
      return shown && !SHOWS_ITSELF.has(column.type) ? 'untold' : null
    },
  }
}
