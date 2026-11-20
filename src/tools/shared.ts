import type { Row, ServiceNowClient } from '../client.js'
import type { Column, Dictionary } from '../dictionary.js'
import { quoteInstanceText, ServiceNowError, validation } from '../errors.js'
import { assertFieldPath, isTableName, parseEncodedQuery, withCondition, type ParsedQuery } from '../query.js'

export interface Context {
  sn: ServiceNowClient
  dict: Dictionary
}

/** Failures that say the instance could not be used at all, as opposed to one table being closed. */
export const NO_CONNECTION = new Set(['auth', 'network', 'timeout', 'redirect', 'invalid_response', 'rate_limited'])

export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const

/** Field types whose values are secrets, stored hashed or encrypted. The Table API hands them out as they are stored. */
export const SECRET_TYPES = new Set(['password', 'password2', 'glide_encrypted'])
export const SECRET_NOTE = '[withheld: this field holds a secret]'
/**
 * Where the type of a field cannot be read, its name is the only sign left. Measured against the 1,090 fields of a
 * secret type on one instance: this pattern recognises all but a handful (a field called "key", "answer", "customer_uri").
 */
export const LOOKS_SECRET =
  /passw(or)?d|passphrase|passcode|pwd|secret|token|credential|api_?key|private_?key|(?:^|[_.])otp(?:$|[_.])|[a-z0-9]_key(?:$|[_.])|(?:^|[_.])key_|secure_|sensitive_|encrypt|encoded_value|client_?state|nonce|code_verifier|(?:^|[_.])seed(?:$|[_.])|(?:^|[_.]|soft)pin(?:$|[_.])/i

/**
 * Fields that hold a whole record as text: the payload of a captured change, of a version, of an upgrade entry.
 * Whatever the record holds is in there, secrets included, under names the dictionary of this table does not know.
 */
const RECORD_PAYLOADS: Record<string, string[]> = {
  sys_update_xml: ['payload'],
  sys_update_version: ['payload'],
  sys_update_preview_xml: ['payload', 'payload_diff'],
  sys_upgrade_history_log: ['payload', 'payload_diff'],
  sys_update_diff: ['payload_diff'],
}

/** "payload" or "diff" if the field carries a whole record, as itself or as a comparison of two. */
export function recordPayload(table: string, path: string, column?: Column): 'payload' | 'diff' | null {
  const owner = column?.definedOn && RECORD_PAYLOADS[column.definedOn] ? column.definedOn : table
  const field = column ? (column.sourceField ?? column.name) : (path.split('.').at(-1) ?? path)
  if (!RECORD_PAYLOADS[owner]?.includes(field)) return null
  return field === 'payload_diff' ? 'diff' : 'payload'
}

const WITHHELD = '[withheld]'

/**
 * Takes out of a text that carries a record what looks like a secret: the content of an XML element, or the value
 * of a JSON key, whose name suggests one, and the value of a system property of a password type. Recognised by
 * name only: the types of the record's fields are not at hand here.
 */
export function scrubSecrets(text: string): { text: string; withheld: number } {
  if (text.length < 20 || !/[<"]/.test(text)) return { text, withheld: 0 }
  let withheld = 0
  let out = text.replace(/<([A-Za-z_][\w.-]*)((?:\s[^<>]*)?)>(<!\[CDATA\[[\s\S]*?\]\]>|[^<]+)<\/\1>/g, (whole, tag: string, attributes: string, content: string) => {
    // "true" and "false" are switches such as "display_password", not secrets.
    if (!LOOKS_SECRET.test(tag) || !content.trim() || /^(true|false)$/.test(content.trim())) return whole
    withheld++
    return `<${tag}${attributes}>${WITHHELD}</${tag}>`
  })
  if (/<sys_properties[\s>]/.test(out) && /<type>password2?<\/type>/.test(out)) {
    out = out.replace(/<value>(?:<!\[CDATA\[[\s\S]*?\]\]>|[^<]+)<\/value>/g, () => {
      withheld++
      return `<value>${WITHHELD}</value>`
    })
  }
  out = out.replace(/("([A-Za-z_][\w.-]*)"\s*:\s*)"(?:[^"\\]|\\.)+"/g, (whole, lead: string, key: string) => {
    if (!LOOKS_SECRET.test(key)) return whole
    withheld++
    return `${lead}"${WITHHELD}"`
  })
  return { text: out, withheld }
}

export const CLOSED_NAME = '[withheld: the record is in a table closed on this machine]'

/**
 * true if an update name stands for a record of a table that is closed on this machine. Such a name ends in the
 * sys_id of the record and begins with its table. The readable name of that record is then not passed on.
 */
export function isClosedRecord(sn: ServiceNowClient, updateName: string): boolean {
  const table = /^(.+)_[0-9a-f]{32}$/.exec(updateName)?.[1] ?? ''
  return sn.restricted && isTableName(table) && !sn.allows(table)
}

/** The table of the record a payload carries: the element that has the action on it. */
export function payloadTable(text: string): string {
  return /<([a-z0-9_]{1,80})\s[^<>]*\baction="/.exec(text)?.[1] ?? ''
}

/**
 * Comments, work notes and the like. Their entries are stored in sys_journal_field, not in the record. Measured: the
 * field comes back empty unless display values are asked for, "is empty" and "is not empty" on it return the same
 * rows, and LIKE on it also finds text of the record's other journal fields.
 */
export const JOURNAL_TYPES = new Set(['journal', 'journal_input', 'journal_list'])

const DATE_TYPES = new Set(['glide_date_time', 'glide_date', 'due_date', 'datetime', 'date', 'calendar_date_time'])
const NUMBER_TYPES = new Set(['integer', 'longint', 'long', 'decimal', 'float', 'double', 'numeric'])
/** A duration is stored as a point in time counted from 1970-01-01 00:00:00: eight hours are "1970-01-01 08:00:00". */
const DURATION_TYPES = new Set(['glide_duration', 'timer'])
/** Operators that compare text. */
const COMPARES_TEXT = new Set(['LIKE', 'NOT LIKE', 'STARTSWITH', 'ENDSWITH', 'CONTAINS'])
/** Operators whose value is compared with what the field stores, so that its form matters. */
const COMPARES_STORED = new Set(['=', '!=', '>', '>=', '<', '<=', 'IN', 'NOT IN', 'BETWEEN', 'ON', 'NOTON'])

const isDate = (text: string) => {
  const parts = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?Z?)?$/.exec(text.trim())
  if (!parts) return false
  const [month, day, hour, minute, second] = parts.slice(2).map((part) => Number(part ?? 0))
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 && hour <= 23 && minute <= 59 && second <= 59
}
const isNumber = (text: string) => /^\s*-?\d+(\.\d+)?\s*$/.test(text)
const isBoolean = (text: string) => /^(true|false|1|0)$/i.test(text.trim())

/** Operators that only ask whether a field is filled. They say nothing about what it holds. */
const ASKS_IF_FILLED = new Set(['ISEMPTY', 'ISNOTEMPTY', 'ISEMPTYSTRING', 'ANYTHING'])
/**
 * Operators that compare a reference with a sys_id, or ask nothing about its content. Measured: LIKE and STARTSWITH
 * on a reference match the name of the record behind it, and a sort orders by that name. Every operator not listed
 * here is treated like those.
 */
const COMPARES_IDS = new Set(['=', '!=', 'IN', 'NOT IN', 'SAMEAS', 'NSAMEAS', ...ASKS_IF_FILLED])
/** Measured: these leave out the rows where the field is empty. */
const SKIPS_EMPTY = new Set(['!=', 'NOT IN', 'NOT LIKE'])
/**
 * A system property says by its type whether its value is a secret. Measured: "NOT IN" leaves out the rows where the
 * field is empty, so properties without a type go as well. That is wanted: without a type, the name of a property
 * decides whether its value is withheld, and a name cannot be put into this condition.
 */
const NO_SECRET_PROPERTIES = 'typeNOT INpassword,password2'

const isPropertyValue = (column: Column | undefined) => column?.definedOn === 'sys_properties' && (column.sourceField ?? column.name) === 'value'

/**
 * Whether a field holds a secret. The dictionary says so by its type. Where the entry is missing, or came back
 * without a type, the name is the only sign left.
 */
export function holdsSecret(column: Column | undefined, path: string): boolean {
  return column?.type ? SECRET_TYPES.has(column.type) : LOOKS_SECRET.test(path)
}

/**
 * Whether a path can be the value of a system property although the dictionary does not say so: reached through
 * a reference or a child table ("property.value", "ref_sys_properties.value") with a type that could not be read.
 */
export function mayBePropertyValue(column: Column | undefined, path: string): boolean {
  return isPropertyValue(column) || (!column?.type && /\.value$/.test(path))
}

/**
 * The names under which a table hands out the value of a system property: its
 * own "value", or "<prefix>_value" where a database view joins sys_properties.
 * Known from the definition of the view, also where the dictionary is not readable.
 */
export async function propertyValueFields(ctx: Context, table: string): Promise<Set<string>> {
  if (table === 'sys_properties') return new Set(['value'])
  const info = await ctx.dict.table(table).catch(() => null)
  return new Set((info?.members ?? []).filter((member) => member.table === 'sys_properties').map((member) => `${member.prefix}_value`))
}

export interface Guard {
  /** A sentence for the answer: how the field names were verified. */
  fieldCheck: string
  /** The query to send. It differs from the one given where secrets had to be kept out of reach. */
  query: string
  parsed: ParsedQuery
  /** Dictionary entries of the verified paths. Empty if the dictionary could not be used. */
  resolved: Map<string, Column>
  warnings: string[]
}

/**
 * Refuses a query or field list that cannot be trusted, before it is sent.
 *
 * 1. The grammar: only conditions that can be checked.
 * 2. The field names, against the dictionary. ServiceNow drops a condition on an
 *    unknown field and answers unfiltered.
 * 3. If the dictionary cannot be used (not readable, or a virtual table), the
 *    names are checked against a row of the table itself: the Table API leaves a
 *    field it does not know out of the row.
 * 4. Choice fields: a label where the stored value belongs matches nothing.
 * 5. Secrets: a field that holds one can be neither compared nor sorted by.
 *
 * "groupBy" is the field an Aggregate call counts by. Like a field in a condition,
 * it changes the answer if the instance ignores it.
 */
export async function guardFields(ctx: Context, table: string, query: string, fields: string[] = [], groupBy?: string): Promise<Guard> {
  if (!ctx.sn.allows(table)) {
    throw new ServiceNowError(`Table "${table}" is closed on this machine (SERVICENOW_TABLE_ALLOW, SERVICENOW_TABLE_DENY). Nothing was sent.`, 'blocked', table)
  }
  const named = groupBy ? [...fields, groupBy] : fields
  named.forEach((field) => assertFieldPath(field, table))
  const parsed = parseEncodedQuery(query, table)
  const paths = [...new Set([...parsed.fields, ...named])]
  const warnings: string[] = []
  if (parsed.escapedCaret) {
    warnings.push('The query contains "^^". ServiceNow reads that as a literal ^ inside a value, not as a separator between conditions.')
  }

  if (!paths.length && !ctx.sn.restricted) return { fieldCheck: 'not needed: the call names no fields', query, parsed, resolved: new Map(), warnings }

  const check = await ctx.dict.checkFields(table, paths)

  // A table that is closed on this machine must not be read through the side door either. Checked first: a hint about
  // a misspelled field would name fields of that table.
  const closed = [...check.reached].filter((name) => !ctx.sn.allows(name))
  if (closed.length) {
    throw new ServiceNowError(
      `This query reads from ${closed.join(', ')} through a dot-walk or a database view, and ${closed.length === 1 ? 'that table is' : 'those tables are'} closed on this machine. Nothing was sent.`,
      'blocked',
      closed[0],
    )
  }
  if (check.unknown.length) {
    const details = check.unknown
      .map((item) => `${item.field}: ${item.reason}${item.suggestions.length ? ` (similar: ${item.suggestions.join(', ')})` : ''}`)
      .join('; ')
    throw validation(
      `Unknown field. ${details}. ServiceNow ignores a condition on an unknown field and answers unfiltered, so nothing was sent.`,
      table,
    )
  }

  if (ctx.sn.restricted && check.status !== 'checked') {
    throw new ServiceNowError(
      `Tables are closed on this machine, and it could not be established which tables this query reads from (${check.reason ?? 'the dictionary could not be used'}). Nothing was sent.`,
      'blocked',
      table,
    )
  }
  if (ctx.sn.restricted) {
    // The rows of a child table are rows of its parents: "customer_contact" holds users.
    for (const name of [table, ...check.reached]) {
      const parent = (await ctx.dict.table(name).catch(() => null))?.chain.slice(1).find((ancestor) => !ctx.sn.allows(ancestor))
      if (parent) {
        throw new ServiceNowError(`"${name}" is a child table of ${parent}, which is closed on this machine: its rows are rows of that table. Nothing was sent.`, 'blocked', parent)
      }
    }
  }

  let sent = await keepSecretsOutOfReach(ctx, table, query, parsed, check.resolved, warnings)
  // And the other way round: a query on a parent answers with the rows of its child tables, closed ones included.
  const classes = ctx.sn.restricted ? ctx.sn.classFilter() : null
  if (classes && (await ctx.dict.columnSet(table).catch(() => null))?.columns.has('sys_class_name')) {
    sent = withCondition(sent, classes)
    warnings.push('Tables are closed on this machine. Rows that belong to a closed child table of this one were left out by a condition on sys_class_name, and the total does not count them.')
  }
  refuseJournalConditions(table, parsed, check.resolved)
  warnAboutEmptyFields(parsed, check.resolved, warnings)
  await refuseChoiceLabels(ctx, table, parsed, check.resolved, warnings)
  refuseValuesOfTheWrongKind(table, parsed, check.resolved)

  if (check.status === 'checked') {
    const fieldCheck = paths.length ? 'all field names verified against sys_dictionary' : 'not needed: the call names no fields'
    return { fieldCheck, query: sent, parsed, resolved: check.resolved, warnings }
  }

  // Not every name could be checked against the dictionary. What it did resolve was still checked for choice labels.
  const unchecked = parsed.conditions.filter(({ field, operator }) => COMPARES_VALUES.has(operator) && !check.resolved.has(field)).map(({ field }) => field)
  if (unchecked.length) {
    warnings.push(
      `It could not be checked whether ${[...new Set(unchecked)].join(', ')} ${unchecked.length === 1 ? 'is a choice field' : 'are choice fields'}, because the dictionary could not be used. ` +
        'A choice field stores a value, not its label: a label would match nothing.',
    )
  }
  const why = check.reason ?? 'the dictionary could not be used'
  const probe = await ctx.sn.query<Row>({ table, fields: paths, limit: 1 })
  const row = probe.records[0]
  if (row) {
    const missing = paths.filter((path) => !(path in row))
    if (missing.length) {
      throw validation(
        `Unknown field: ${missing.join(', ')}. A row of "${table}" does not carry ${missing.length === 1 ? 'it' : 'them'} ` +
          `(checked this way because ${why}). ServiceNow ignores a condition on an unknown field and answers unfiltered, so the query was not sent.`,
        table,
      )
    }
    return { fieldCheck: `field names verified against a row of the table, because ${why}`, query: sent, parsed, resolved: check.resolved, warnings }
  }

  if (probe.total === 0) {
    return { fieldCheck: `not possible: ${why}, and the table has no rows to check against. An empty table answers every query with 0 rows.`, query: sent, parsed, resolved: check.resolved, warnings }
  }
  // An ignored condition answers unfiltered, and an ignored field to count by answers with one group of all rows.
  if (parsed.fields.length || groupBy) {
    throw new ServiceNowError(
      `The field names in this ${groupBy && !parsed.fields.length ? 'call' : 'query'} could not be verified: ${why}, and no row of "${table}" is visible to check against. ` +
        'A misspelled field would be ignored and the answer would be unfiltered, so nothing was sent.',
      'acl',
      table,
    )
  }
  return { fieldCheck: `not possible: ${why}, and no row of the table is visible to check against`, query: sent, parsed, resolved: check.resolved, warnings }
}

/**
 * A condition on a secret is a way to read it: "starts with a", "starts with b",
 * and the number of matches gives the value away piece by piece. The same goes
 * for the order of rows sorted by it. So a field that holds a secret can only be
 * asked whether it is filled.
 *
 * The value of a system property is a secret where the property is of type
 * password. On sys_properties itself those rows are taken out of the query. Where
 * the value is reached through a database view or a reference, the type of the
 * property is not at hand, and the query is refused.
 *
 * Returns the query to send.
 */
async function keepSecretsOutOfReach(ctx: Context, table: string, query: string, parsed: ParsedQuery, resolved: Map<string, Column>, warnings: string[]): Promise<string> {
  // The names of the records in a closed table are kept back from the answer. "Starts with A" on a reference into
  // that table compares with those names, and sorting by the reference orders the rows by them.
  if (ctx.sn.restricted) {
    const closedBehind = (field: string) => {
      const column = resolved.get(field)
      if (column?.reference) return ctx.sn.allows(column.reference) ? null : column.reference
      // A field that can point to any table, or whose type did not come back: it may point into a closed one.
      return !column?.type || column.type === 'document_id' ? 'a table that cannot be told' : null
    }
    const byName = [...parsed.conditions.filter(({ operator }) => !COMPARES_IDS.has(operator)).flatMap(({ field, second }) => (second ? [field, second] : [field])), ...parsed.sorts].find(closedBehind)
    if (byName) {
      throw new ServiceNowError(
        `"${byName}" points into ${closedBehind(byName)}, and tables are closed on this machine. Comparing it with text or sorting by it works on the names of the records there, ` +
          'so those names could be found out by trying. Compare it with a sys_id (=, IN) or ask whether it is filled. Nothing was sent.',
        'blocked',
        table,
      )
    }
  }

  const compared = new Set([...parsed.otherFields, ...parsed.conditions.filter(({ operator }) => !ASKS_IF_FILLED.has(operator)).map(({ field }) => field)])
  // A text search looks into fields the query does not name. Where one of them holds a secret, it is a way to probe it.
  if (parsed.textSearch) {
    const columns = table === 'sys_properties' ? null : await ctx.dict.columnSet(table).catch(() => null)
    const secret = [...(columns?.columns.values() ?? [])].filter((column) => SECRET_TYPES.has(column.type)).map((column) => column.name)
    if (secret.length || (await propertyValueFields(ctx, table)).size > (table === 'sys_properties' ? 1 : 0)) {
      throw validation(
        `A text search looks into the fields of "${table}" without naming them, and this table has fields that hold secrets` +
          `${secret.length ? ` (${secret.slice(0, 5).join(', ')})` : ''}. Filter on named fields instead. Nothing was sent.`,
        table,
      )
    }
    if (table === 'sys_properties') compared.add('value')
  }
  if (!compared.size) return query

  const whole = [...compared].find((field) => recordPayload(table, field, resolved.get(field)))
  if (whole) {
    throw validation(
      `"${whole}" holds whole records as text, with everything in them, secrets included. It can be read, with secrets taken out, but not searched or sorted by: ` +
        'the number of matches would give a value away piece by piece. Filter on the name, the type or the date of the row instead. Nothing was sent.',
      table,
    )
  }

  const valueFields = await propertyValueFields(ctx, table)
  let propertyValues = false
  for (const field of compared) {
    const column = resolved.get(field)
    if (holdsSecret(column, field)) {
      throw validation(
        `"${field}" holds a secret${column?.type ? '' : ' (judged by its name, because its type could not be read)'}. It can be neither compared nor sorted by: ` +
          'the number of matches would give its value away piece by piece. Asking whether it is filled works: ISEMPTY, ISNOTEMPTY. Nothing was sent.',
        table,
      )
    }
    if (table === 'sys_properties' && field === 'value') propertyValues = true
    else if (valueFields.has(field) || mayBePropertyValue(column, field)) {
      throw validation(
        `"${field}" is the value of a system property, and some properties hold secrets. Through a database view or a reference it cannot be compared or sorted by, ` +
          'because the properties that hold secrets cannot be left out there. Query sys_properties itself. Nothing was sent.',
        table,
      )
    }
  }
  if (!propertyValues) return query

  warnings.push(
    'The query compares or sorts by the value of system properties. Properties that hold a secret (type password or password2) and properties without a type ' +
      'were left out of it, so that no secret can be found out by trying. The total does not count them.',
  )
  return withCondition(query, NO_SECRET_PROPERTIES)
}

/**
 * A value of the wrong kind is not rejected by the instance. Measured on a table of 82 rows:
 * - a date it cannot read ("01.01.2026", "yesterday", "2026") makes ">" match every row and "<" none;
 * - on a true/false field, every value but "true" and "1" is read as false: "active=yes" returns the inactive rows;
 * - on a number field, a value that is not a number matches nothing, also with "!=";
 * - LIKE and its relatives match nothing on a number field ("priorityLIKE1" gave 0 where "priority=1" gave 27),
 *   and on a true/false field they return the rows where it is false;
 * - a duration is compared as a date counted from 1970: "business_duration>3600" matched every filled row.
 */
function refuseValuesOfTheWrongKind(table: string, parsed: ParsedQuery, resolved: Map<string, Column>): void {
  for (const { field, operator, value } of parsed.conditions) {
    const type = resolved.get(field)?.type ?? ''
    if (COMPARES_TEXT.has(operator) && (NUMBER_TYPES.has(type) || type === 'boolean')) {
      throw validation(
        type === 'boolean'
          ? `"${field}" is a true/false field, and ${operator} does not compare text on it. Measured: ${field}LIKEtrue returns the rows where it is false. Write ${field}=true or ${field}=false. Nothing was sent.`
          : `"${field}" holds a number, and ${operator} matches nothing on a number field. Measured: priorityLIKE1 gave no row where priority=1 gave 27. Compare with =, >, <, IN or BETWEEN. Nothing was sent.`,
        table,
      )
    }
    if (!COMPARES_STORED.has(operator)) continue
    const named = operator === 'ON' || operator === 'NOTON'
    // ON carries a label first, then the two ends of the range.
    const given = (named ? value.split('@').slice(1) : operator === 'BETWEEN' ? value.split('@') : operator.endsWith('IN') ? value.split(',') : [value]).filter(
      (item) => item !== '' && item !== 'NULL',
    )

    if (DURATION_TYPES.has(type)) {
      const odd = given.find((item) => !isDate(item))
      if (odd !== undefined) {
        throw validation(
          `"${field}" holds a duration, which is stored as a point in time counted from 1970-01-01 00:00:00, and "${odd}" is not written that way. ` +
            'One hour is 1970-01-01 01:00:00, two days are 1970-01-03 00:00:00. Measured: a number of seconds is not rejected, and ">" then matches every filled row. Nothing was sent.',
          table,
        )
      }
    } else if (DATE_TYPES.has(type)) {
      const odd = given.find((item) => !isDate(item))
      if (odd !== undefined) {
        throw validation(
          `"${field}" holds a date, and "${odd}" is not written in a form ServiceNow reads here. Write YYYY-MM-DD or YYYY-MM-DD HH:MM:SS, in UTC. ` +
            'Measured: with a date it cannot read, the instance does not reject the condition: ">" then matches every row and "<" none. Nothing was sent.',
          table,
        )
      }
    } else if (type === 'boolean' && !named && operator !== 'BETWEEN') {
      const odd = given.find((item) => !isBoolean(item))
      if (odd !== undefined) {
        throw validation(
          `"${field}" is a true/false field. Write true or false. Measured: ServiceNow reads every other value as false, so ${field}=${odd} would return the rows where it is false. Nothing was sent.`,
          table,
        )
      }
    } else if (NUMBER_TYPES.has(type) && !named) {
      const odd = given.find((item) => !isNumber(item))
      if (odd !== undefined) {
        throw validation(
          `"${field}" holds a number, and "${odd}" is not one. Measured: ServiceNow then matches nothing, also with "!=", so the answer would be a zero that says nothing. Nothing was sent.`,
          table,
        )
      }
    }
  }
}

/** A condition on a journal field is applied, but not as written. The entries themselves can be queried exactly. */
function refuseJournalConditions(table: string, parsed: ParsedQuery, resolved: Map<string, Column>): void {
  const used = [...parsed.conditions.flatMap(({ field, second }) => (second ? [field, second] : [field])), ...parsed.sorts]
  const journal = used.find((field) => JOURNAL_TYPES.has(resolved.get(field)?.type ?? ''))
  if (!journal) return
  const element = journal.split('.').at(-1)
  throw validation(
    `"${journal}" is a journal field. Its entries are stored in the table sys_journal_field, and a condition on the field itself does not do what it says: ` +
      'measured, "is empty" and "is not empty" return the same rows, and LIKE also finds text of the other journal fields of a record. ' +
      `Query sys_journal_field instead, for example element=${element}^valueLIKE<text>: "element_id" is the sys_id of the record, "name" its table. Nothing was sent.`,
    table,
  )
}

/** Measured: "is not" leaves out the rows where the field is empty. An agent counting "everything except X" misses them. */
function warnAboutEmptyFields(parsed: ParsedQuery, resolved: Map<string, Column>, warnings: string[]): void {
  const fields = parsed.conditions
    .filter(({ field, operator, value }) => SKIPS_EMPTY.has(operator) && value !== '' && resolved.get(field)?.type !== 'boolean')
    .map(({ field }) => field)
  if (!fields.length) return
  const list = [...new Set(fields)]
  warnings.push(
    `"!=", "NOT IN" and "NOT LIKE" leave out rows where the field is empty (${list.join(', ')}). ` +
      `To count those rows too, add ^OR${list[0]}ISEMPTY behind the condition.`,
  )
}

/** Operators that compare a field with the values given. For these a label in place of a stored value is a mistake. */
const COMPARES_VALUES = new Set(['=', '!=', 'IN', 'NOT IN'])

/**
 * "state=Resolved" matches nothing, because a choice field stores "6", and
 * "state!=Resolved" matches nothing either where the stored value is a number.
 * The answer would be a correct-looking zero. Where the value is plainly a label,
 * the query is refused and the stored value is named.
 */
async function refuseChoiceLabels(ctx: Context, table: string, parsed: ParsedQuery, resolved: Map<string, Column>, warnings: string[]): Promise<void> {
  for (const { field, operator, value } of parsed.conditions) {
    const column = resolved.get(field)
    if (!column?.choice || !COMPARES_VALUES.has(operator)) continue

    // A field of a database view takes its choices from the table it comes from. A dot-walked field belongs to a
    // table that is not known here, and its choices can differ per child table: those are not looked up.
    const walked = field.includes('.')
    const choices = walked
      ? null
      : await (column.sourceField ? ctx.dict.choices(column.definedOn, column.sourceField) : ctx.dict.choices(table, field)).catch(() => null)
    if (!choices) {
      warnings.push(`"${field}" is a choice field, and its values could not be checked${walked ? '' : ' (sys_choice is not readable)'}. A label in place of the stored value would match nothing.`)
      continue
    }
    if (!choices.length) continue
    const stored = new Set(choices.map((choice) => choice.value.toLowerCase()))

    for (const given of operator.endsWith('IN') ? value.split(',') : [value]) {
      if (given === '' || given === 'NULL' || stored.has(given.toLowerCase())) continue
      const meant = choices.find((choice) => choice.label.toLowerCase() === given.toLowerCase())
      if (meant) {
        throw validation(
          `"${field}" stores the value of a choice, not its label: "${given}" is the label of "${quoteInstanceText(meant.value, 80)}". ` +
            `Write ${quoteInstanceText(meant.value, 80)} instead. With the label ServiceNow does not compare what was meant, and the answer would mislead. Nothing was sent.`,
          table,
        )
      }
    }
  }
}

/**
 * Reasons why a query that matched nothing may have matched nothing for the
 * wrong reason. Called only for an empty result.
 */
export async function explainEmpty(ctx: Context, table: string, guard: Guard): Promise<string[]> {
  const notes: string[] = []
  for (const { field, operator, value } of guard.parsed.conditions) {
    const column = guard.resolved.get(field)
    if (!column || (operator !== '=' && operator !== 'IN')) continue
    const given = (operator === 'IN' ? value.split(',') : [value]).filter((item) => item !== '' && item !== 'NULL')

    if (column.type === 'reference') {
      const odd = given.find((item) => !/^[0-9a-f]{32}$/i.test(item))
      if (odd) {
        notes.push(
          `"${field}" is a reference to ${column.reference}. "${operator}" compares with a sys_id, and "${odd}" does not look like one: ` +
            `that can be why nothing matched. To match by name use ${field}.<field>=… or ${field}LIKE….`,
        )
      }
    } else if (column.choice && !field.includes('.') && given.length) {
      // A field of a database view takes its choices from the table it comes from.
      const choices = await (column.sourceField ? ctx.dict.choices(column.definedOn, column.sourceField) : ctx.dict.choices(table, field)).catch(() => [])
      const stored = new Set(choices.map((choice) => choice.value.toLowerCase()))
      const odd = given.find((item) => !stored.has(item.toLowerCase()))
      if (choices.length && odd) {
        const list = choices.slice(0, 15).map((choice) => `${quoteInstanceText(choice.value, 80)} (${quoteInstanceText(choice.label, 80)})`).join(', ')
        notes.push(`"${odd}" is not among the choice values of "${field}": that can be why nothing matched. Its values: ${list}.`)
      }
    }
  }
  return notes
}

/** Runs tasks with a small number in flight, to stay polite to the instance. */
export async function mapLimit<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await task(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

export function errorKind(error: unknown): string {
  return error instanceof ServiceNowError ? error.kind : 'unknown'
}

/**
 * Accounts that are not a person: the platform itself, the guest session, and
 * ServiceNow's own maintenance logins (user names of the form name@snc.maint).
 * Changes captured under them come from installations, upgrades and jobs.
 *
 * A captured change counts as made by a system account only if no person is on
 * it: neither as the one who first captured it nor as the one who changed it last.
 * A row without an author has no person on it either. Measured: "NOT IN" and
 * "NOT LIKE" leave out rows where the field is empty, so the two filters below
 * split the rows without a gap.
 */
const BY_SYSTEM = (field: string) => `${field}INsystem,guest^OR${field}LIKE@snc.^OR${field}ISEMPTY`
const NOT_BY_SYSTEM = (field: string) => `${field}NOT INsystem,guest^${field}NOT LIKE@snc.`

export const BY_SYSTEM_ACCOUNT = `${BY_SYSTEM('sys_created_by')}^${BY_SYSTEM('sys_updated_by')}`

/**
 * The same filter, restricted to rows a person is on. "Created by a person, or
 * last changed by a person" is a union, written as two queries joined by ^NQ.
 */
export function withPeopleOnly(filter: string): string {
  return ['sys_created_by', 'sys_updated_by'].map((field) => [filter, NOT_BY_SYSTEM(field)].filter(Boolean).join('^')).join('^NQ')
}

export function isSystemAccount(user: string): boolean {
  return user === '' || user === 'system' || user === 'guest' || user.includes('@snc.')
}
