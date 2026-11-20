import type { Row, ServiceNowClient } from '../client.js'
import type { ClosedTables } from '../closed.js'
import type { Choice, Column, Dictionary, FieldCheck } from '../dictionary.js'
import { quoteInstanceText, ServiceNowError, unlessNoConnection, validation } from '../errors.js'
import { assertFieldPath, isPlainValue, isTableName, parseEncodedQuery, withCondition, type Condition, type ParsedQuery } from '../query.js'

export interface Context {
  sn: ServiceNowClient
  dict: Dictionary
  /** The rules for tables that are closed on this machine. The client asks them for every request. */
  closed: ClosedTables
}

export { NO_CONNECTION } from '../errors.js'

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
  /passw(or)?d|passphrase|passcode|pwd|secret|token|credential|bearer|authorization|keystore|(?:api|private|access|auth|signing|encryption|shared|master|session|client)[_-]?key|(?:^|[_.])otp(?:$|[_.])|[a-z0-9]_key(?:$|[_.])|(?:^|[_.])key_|secure_|sensitive_|encrypt|encoded_value|client_?state|nonce|code_verifier|(?:^|[_.])seed(?:$|[_.])|(?:^|[_.]|soft)pin(?:$|[_.])/i

/**
 * Fields that hold a whole record as text: the payload of a captured change, of a version, of an upgrade entry.
 * Whatever the record holds is in there, secrets included, under names the dictionary of this table does not know.
 */
const PAYLOAD_FIELDS = new Map<string, string[]>([
  ['sys_update_xml', ['payload']],
  ['sys_update_version', ['payload']],
  ['sys_update_preview_xml', ['payload', 'payload_diff']],
  ['sys_upgrade_history_log', ['payload', 'payload_diff']],
  ['sys_update_diff', ['payload_diff']],
  // Measured: a deleted record is kept whole, as XML under the name of its table, and so is a linked application file.
  ['sys_audit_delete', ['payload']],
  ['sys_archive_log', ['payload']],
  ['sys_metadata_link', ['payload']],
])

/** "payload" or "diff" if the field carries a whole record, as itself or as a comparison of two. */
export function recordPayload(table: string, path: string, column?: Column): 'payload' | 'diff' | null {
  const field = column ? (column.sourceField ?? column.name) : (path.split('.').at(-1) ?? path)
  // Reached through a reference or a view without a dictionary entry at hand: the table it belongs to is not known,
  // so the name decides. Every field of that name in the tables above carries a record.
  const carries = column ? PAYLOAD_FIELDS.get(column.definedOn)?.includes(field) : path === field ? PAYLOAD_FIELDS.get(table)?.includes(field) : field === 'payload' || field === 'payload_diff'
  if (!carries) return null
  return field === 'payload_diff' ? 'diff' : 'payload'
}

const WITHHELD = '[withheld]'

/**
 * Looks for the same text again and again while a longer text is read from left to right. A stretch that was
 * searched once is not searched again: a text made of ten thousand beginnings and no end then costs its length,
 * not its length squared. Ask with positions that do not go backwards.
 */
function finder(text: string, needle: string): (from: number) => number {
  let found = -2
  return (from) => {
    if (found !== -1 && found < from) found = text.indexOf(needle, from)
    return found
  }
}

/**
 * The elements of a text that hold nothing but text, <tag …>text</tag>, with the text plain or in one CDATA
 * section. Read in one pass. Only the elements whose name is wanted are looked into.
 */
function* simpleElements(text: string, wanted: (tag: string) => boolean): Generator<{ start: number; end: number; tag: string; plain: string }> {
  const cdataEnd = finder(text, ']]>')
  const OPEN = /<([A-Za-z_][\w.-]*)(?:\s[^<>]*)?>/g
  const CDATA = /\s*<!\[CDATA\[/y
  const BLANKS = /\s*/y
  let done = 0
  for (let match = OPEN.exec(text); match; match = OPEN.exec(text)) {
    const tag = match[1]
    if (match.index < done || !wanted(tag)) continue
    const from = match.index + match[0].length
    let plain: string
    let after: number
    CDATA.lastIndex = from
    if (CDATA.test(text)) {
      const inner = CDATA.lastIndex
      const close = cdataEnd(inner)
      if (close < 0) continue
      BLANKS.lastIndex = close + 3
      BLANKS.test(text)
      after = BLANKS.lastIndex
      plain = text.slice(inner, close)
    } else {
      after = text.indexOf('<', from)
      // No "<" is left, or the element is empty.
      if (after <= from) continue
      plain = text.slice(from, after)
    }
    const closing = `</${tag}>`
    if (!text.startsWith(closing, after)) continue
    done = after + closing.length
    yield { start: match.index, end: done, tag, plain: plain.trim() }
  }
}

/**
 * Takes out of a text that carries a record what looks like a secret: the content of an XML element, or the value
 * of a JSON key, whose name suggests one, and the value of a system property that holds one. Recognised by name
 * only: the types of the record's fields are not at hand here.
 *
 * A system property inside a payload is judged like one read from its table: by its type, without a type by its
 * name, and without both its value is taken out.
 *
 * The text comes from the instance, and whoever can write a record can write this text. It is read in passes that
 * cost its length: see finder().
 */
export function scrubSecrets(text: string): { text: string; withheld: number } {
  if (!/[<"]/.test(text)) return { text, withheld: 0 }
  let withheld = 0
  /** The text with the content of the wanted elements taken out. "always" also where the content is a switch. */
  const without = (source: string, wanted: (tag: string) => boolean, always: boolean): string => {
    let out = ''
    let last = 0
    for (const element of simpleElements(source, wanted)) {
      // "true" and "false" are switches such as "display_password", not secrets.
      if (!always && (!element.plain || /^(true|false)$/.test(element.plain))) continue
      withheld++
      // Without its attributes: a display value there would repeat the content.
      out += `${source.slice(last, element.start)}<${element.tag}>${WITHHELD}</${element.tag}>`
      last = element.end
    }
    return last ? out + source.slice(last) : source
  }
  let out = without(text, (tag) => LOOKS_SECRET.test(tag), false)

  // A system property: its type says whether the value is a secret.
  const RECORD = /<sys_properties(?:\s[^<>]*)?>/g
  const CLOSING = '</sys_properties>'
  const recordEnd = finder(out, CLOSING)
  let cleaned = ''
  let last = 0
  for (let match = RECORD.exec(out); match; match = RECORD.exec(out)) {
    const close = recordEnd(match.index)
    if (close < 0) break
    const end = close + CLOSING.length
    const record = out.slice(match.index, end)
    const fields = [...simpleElements(record, (tag) => tag === 'type' || tag === 'name')]
    const type = fields.find((field) => field.tag === 'type')?.plain ?? ''
    const name = fields.find((field) => field.tag === 'name')?.plain ?? ''
    const secret = type ? /^password2?$/i.test(type) : name ? LOOKS_SECRET.test(name) : true
    if (secret) {
      cleaned += out.slice(last, match.index) + without(record, (tag) => tag === 'value', true)
      last = end
    }
    RECORD.lastIndex = end
  }
  if (last) out = cleaned + out.slice(last)

  // JSON, also where it sits inside a string of another JSON text and its quotes are escaped. There an escape of
  // the inner text is written with two backslashes: \\u003d, \\/ and, for a quote inside the value, \\\".
  for (const quote of ['"', String.raw`\\"`]) {
    const value = quote === '"' ? String.raw`"(?:[^"\\]|\\.)+"` : String.raw`\\"(?:[^"\\]|\\\\(?:\\\\|\\"|[^"\\]))+\\"`
    out = out.replace(new RegExp(String.raw`(${quote}([A-Za-z_][\w.-]*)${quote}\s*:\s*)(?:${value}|-?\d[\d.]*)`, 'g'), (whole, lead: string, key: string) => {
      if (!LOOKS_SECRET.test(key) || /:\s*\\?"(true|false)\\?"$/.test(whole)) return whole
      withheld++
      const mark = quote === '"' ? '"' : String.raw`\"`
      return `${lead}${mark}${WITHHELD}${mark}`
    })
  }
  return { text: out, withheld }
}

export const CLOSED_NAME = '[withheld: the record is in a table closed on this machine]'

/** The longest update name an instance stores. A longer text is none. */
const MAX_UPDATE_NAME = 250

/**
 * Every beginning of an update name that ends before an underscore and can be the name of a table, longest first.
 * The name as a whole is none: something stands behind the table. A table name has at most eighty characters, so
 * a name of any length costs a bounded number of cuts.
 */
function tableCuts(name: string): string[] {
  const cuts: string[] = []
  for (let at = name.lastIndexOf('_', 80); at > 0; at = name.lastIndexOf('_', at - 1)) {
    const cut = name.slice(0, at)
    if (isTableName(cut)) cuts.push(cut)
  }
  return cuts
}

/** What stands before a generated sys_id at the end of an update name: the table, without a doubt. */
const tableBeforeId = (name: string): string | undefined => /^(.+)_[0-9a-f]{32}$/.exec(name)?.[1]

/**
 * Asks in one go which beginnings of these update names are tables. isClosedRecord needs that for each name while
 * a list names the only tables that may be read. A page of two hundred names shares most of its beginnings, so
 * this is a handful of requests where asking name by name would be hundreds. Nothing is asked without such a list.
 */
export async function knowRecordTables(ctx: Context, updateNames: string[]): Promise<void> {
  if (!ctx.sn.restricted || !ctx.sn.openClasses()) return
  const cuts = updateNames.map((name) => name.toLowerCase()).filter((name) => name.length <= MAX_UPDATE_NAME).flatMap(tableCuts)
  // A look-up that fails here fails again where the name is judged, and is dealt with there.
  await ctx.dict.knownTables(cuts).catch(unlessNoConnection(null))
}

/**
 * true if an update name stands for a record of a table that is closed on this machine, or may stand for one. Such
 * a name begins with its table. Mostly the sys_id of the record follows, and then what stands before it is the
 * table. Where something else follows, every way to cut the name is looked at. The readable name of that record is
 * then not passed on.
 *
 * With a deny list, the closed tables are known by name: the record is in one if its table is one of them, or,
 * where the table cannot be told, if any cut gives one. A name the list closes counts whether or not the instance
 * still lists such a table. With a list of the only tables that may be read, the record has to be in a table that
 * is found and open, and where the table cannot be told, every cut that is a table has to be open. Where no table
 * is found, or no name is given, the answer is yes.
 *
 * Measured: the instance compares a name without regard to case, so the name is judged in small letters.
 */
export async function isClosedRecord(ctx: Context, updateName: string): Promise<boolean> {
  if (!ctx.sn.restricted) return false
  const name = updateName.toLowerCase()
  if (!name || name.length > MAX_UPDATE_NAME) return true
  const cuts = tableCuts(name)
  const exact = tableBeforeId(name)
  // "sys_script_include_<sys_id>" is no business rule: with a sys_id at the end only one cut is the table.
  const candidates = exact && cuts.includes(exact) ? [exact] : cuts
  if (candidates.some((table) => ctx.sn.denies(table))) return true
  const denied = await ctx.dict.closedTables().catch(unlessNoConnection(null))
  if (!denied) return true
  if (candidates.some((table) => denied.has(table))) return true
  if (!ctx.sn.openClasses()) return false

  const known = await ctx.dict.knownTables(candidates).catch(unlessNoConnection(null))
  const tables = candidates.filter((table) => known?.has(table))
  if (!tables.length) return true
  for (const table of tables) {
    if ((await ctx.closed.reason(table)) !== null) return true
  }
  return false
}

/**
 * Fields that hold the readable name of a record of another table, each with the field beside it that says which
 * record: its update name, or its table. sn_delta, sn_upgrade_skips and sn_origin keep such a name back where the
 * record is in a closed table. A query has to do the same. The field lists were read from the dictionary of an
 * instance.
 */
const RECORD_NAMES = new Map<string, Record<string, { key: string; holds: 'update_name' | 'table' }>>([
  ['sys_update_xml', { target_name: { key: 'name', holds: 'update_name' } }],
  ['sys_update_version', { record_name: { key: 'name', holds: 'update_name' } }],
  ['sys_upgrade_history_log', { target_name: { key: 'file_name', holds: 'update_name' } }],
  ['sys_audit_delete', { display_value: { key: 'tablename', holds: 'table' } }],
  ['sys_archive_log', { display_value: { key: 'from_table', holds: 'table' } }],
  ['sys_metadata_link', { sys_name: { key: 'tablename', holds: 'table' } }],
])

/** For a field that holds the name of a record of another table: the path of the field that says which record, and what that field holds. */
export function recordNameKey(table: string, path: string, column?: Column): { path: string; holds: 'update_name' | 'table' } | null {
  const field = column ? (column.sourceField ?? column.name) : (path.split('.').at(-1) ?? path)
  const owner = column ? column.definedOn : path === field ? table : null
  // Reached through a reference without a dictionary entry at hand: the names used for an update name decide.
  const known = owner ? RECORD_NAMES.get(owner)?.[field] : [...RECORD_NAMES.values()].map((fields) => fields[field]).find((entry) => entry?.holds === 'update_name')
  if (!known) return null
  // Beside the field, under the same prefix: "upgrade_detail.target_name" has "upgrade_detail.file_name".
  if (column?.sourceField) return { path: path.slice(0, path.length - field.length) + known.key, holds: known.holds }
  return { path: path.includes('.') ? `${path.slice(0, path.lastIndexOf('.'))}.${known.key}` : known.key, holds: known.holds }
}

/** Elements that hold records and are none themselves. */
const PAYLOAD_WRAPPERS = new Set(['record_update', 'unload', 'xml'])
/** What is no element and can hold "<": text that is not markup, a comment, a processing instruction. */
const SECTIONS: Array<[start: string, end: string]> = [
  ['<![CDATA[', ']]>'],
  ['<!--', '-->'],
  ['<?', '?>'],
]

/**
 * The tables of the records a payload carries: the table named on its root, and every element that has an action
 * on it. Measured on 150 captured changes: 127 carried more than one such element, the record itself and what was
 * removed along with it.
 */
export function payloadTables(text: string): string[] {
  const names = new Set<string>()
  const root = /<record_update\s[^<>]*?(?<![\w-])table\s*=\s*["']([a-z0-9_]{1,80})["']/.exec(text)?.[1]
  if (root) names.add(root)
  for (const match of text.matchAll(/<([a-z0-9_]{1,80})\s[^<>]*?(?<![\w-])action\s*=\s*["']/g)) names.add(match[1])
  // Measured: a deleted or an archived record is stored under an element that carries the name of its table and
  // nothing else, and a captured change under a wrapper. So the outermost element counts, and every element that
  // stands directly inside a wrapper, whether it says what was done to it or not.
  // Read in one pass that costs the length of the text: see finder(). An attribute value may hold ">", so
  // attributes are read as such and not skipped up to the next ">".
  const open: string[] = []
  const ends = SECTIONS.map(([, end]) => finder(text, end))
  const TAG = /<(\/?)([A-Za-z_][\w.-]*)(?:\s+[\w:.-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*\s*(\/?)>/y
  scan: for (let at = text.indexOf('<'); at >= 0; at = text.indexOf('<', at)) {
    for (const [index, [start, end]] of SECTIONS.entries()) {
      if (!text.startsWith(start, at)) continue
      const close = ends[index](at + start.length)
      // Not ended: the rest of the text is inside it.
      if (close < 0) break scan
      at = close + end.length
      continue scan
    }
    TAG.lastIndex = at
    const tag = TAG.exec(text)
    if (!tag) {
      at++
      continue
    }
    at = TAG.lastIndex
    const [, closing, name, empty] = tag
    if (closing) {
      open.pop()
      continue
    }
    if (open.every((parent) => PAYLOAD_WRAPPERS.has(parent)) && /^[a-z0-9_]{1,80}$/.test(name)) names.add(name)
    if (!empty) open.push(name)
  }
  for (const wrapper of PAYLOAD_WRAPPERS) names.delete(wrapper)
  return [...names]
}

/**
 * Comments, work notes and the like. Their entries are stored in sys_journal_field, not in the record. Measured: the
 * field comes back empty unless display values are asked for, "is empty" and "is not empty" on it return the same
 * rows, and LIKE on it also finds text of the record's other journal fields.
 */
export const JOURNAL_TYPES = new Set(['journal', 'journal_input', 'journal_list'])

const DATE_TYPES = new Set(['glide_date_time', 'glide_date', 'due_date', 'datetime', 'date', 'calendar_date_time'])
/**
 * Types that are compared as numbers. Measured for each of the second row as for integer: a word matches nothing,
 * also behind "!=", and LIKE matches nothing (currency 123 rows, price 565, order_index 1,868, auto_increment 347,931).
 */
const NUMBER_TYPES = new Set([
  ...['integer', 'longint', 'long', 'decimal', 'float', 'double', 'numeric'],
  ...['currency', 'price', 'percent_complete', 'order_index', 'integer_time', 'auto_increment'],
])
/** A duration is stored as a point in time counted from 1970-01-01 00:00:00: eight hours are "1970-01-01 08:00:00". */
const DURATION_TYPES = new Set(['glide_duration', 'timer'])
/** Operators that compare text. */
const COMPARES_TEXT = new Set(['LIKE', 'NOT LIKE', 'STARTSWITH', 'ENDSWITH', 'CONTAINS'])
/** Operators whose value is compared with what the field stores, so that its form matters. */
const COMPARES_STORED = new Set(['=', '!=', '>', '>=', '<', '<=', 'IN', 'NOT IN', 'BETWEEN', 'ON', 'NOTON'])

export const isDate = (text: string) => {
  const parts = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?Z?)?$/.exec(text.trim())
  if (!parts) return false
  const [year, month, day, hour, minute, second] = parts.slice(1).map((part) => Number(part ?? 0))
  // A day that exists: there is no 31 February.
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day && hour <= 23 && minute <= 59 && second <= 59
}
const isNumber = (text: string) => /^\s*-?\d+(\.\d+)?\s*$/.test(text)
const isBoolean = (text: string) => /^(true|false|1|0)$/i.test(text.trim())

/** Operators that only ask whether a field is filled. They say nothing about what it holds. */
const ASKS_IF_FILLED = new Set(['ISEMPTY', 'ISNOTEMPTY', 'ISEMPTYSTRING', 'ANYTHING'])
/**
 * "Is empty" and "is not empty", however they are written. Measured: "=" and "!=" without a value or with NULL ask
 * the same as ISEMPTY and ISNOTEMPTY. 717 of 771 users had no login time, each of the three ways.
 */
const asksIfFilled = ({ operator, value }: Pick<Condition, 'operator' | 'value'>) =>
  ASKS_IF_FILLED.has(operator) || ((operator === '=' || operator === '!=') && (value === '' || value === 'NULL'))
/**
 * Operators that compare a reference with a sys_id, or ask nothing about its content. Measured: LIKE and STARTSWITH
 * on a reference match the name of the record behind it, and a sort orders by that name. Every operator not listed
 * here is treated like those.
 */
const COMPARES_IDS = new Set(['=', '!=', 'IN', 'NOT IN', 'SAMEAS', 'NSAMEAS', ...ASKS_IF_FILLED])
/**
 * Measured: these leave out the rows where the field is empty. For NSAMEAS: of 82 incidents, 2 had the same person
 * assigned as opened them and 33 had nobody assigned, and "assigned_toNSAMEASopened_by" matched 47.
 */
const SKIPS_EMPTY = new Set(['!=', 'NOT IN', 'NOT LIKE', 'NSAMEAS'])
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
  /** The table and field each verified path takes its values from. */
  owners: FieldCheck['owners']
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

  // A text search names no field and still reads fields: it goes through every check below.
  if (!paths.length && !parsed.textSearch && !ctx.sn.restricted) return { fieldCheck: 'not needed: the call names no fields', query, parsed, resolved: new Map(), owners: new Map(), warnings }

  // A child table of a closed table holds its rows. Refused before its fields are looked at: a hint about a
  // misspelled field would name them.
  const closed = await ctx.closed.reason(table)
  if (closed) throw new ServiceNowError(`${closed[0].toUpperCase()}${closed.slice(1)}. Nothing was sent.`, 'blocked', table)

  const check = await ctx.dict.checkFields(table, paths)

  // A table that is closed on this machine must not be read through the side door either. Checked first: a hint about
  // a misspelled field would name fields of that table.
  for (const name of check.reached) {
    const why = await ctx.closed.reason(name)
    if (why) throw new ServiceNowError(`This query reads from ${name} through a dot-walk or a database view, and ${why}. Nothing was sent.`, 'blocked', name)
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
  // The other way round, a query on a parent answers with the rows of its child tables: those of closed ones are left
  // out by the gate every request passes through, which also says so in the answer.
  const sent = await keepSecretsOutOfReach(ctx, table, query, parsed, check.resolved, warnings)
  refuseJournalConditions(table, parsed, check.resolved)
  warnAboutEmptyFields(parsed, check.resolved, warnings)
  await refuseChoiceLabels(ctx, table, parsed, check, warnings)
  refuseValuesOfTheWrongKind(table, parsed, check.resolved)
  await refuseNamesInPlaceOfIds(ctx, table, parsed, check.resolved, warnings)

  if (check.status === 'checked') {
    const fieldCheck = paths.length ? 'all field names verified against sys_dictionary' : 'not needed: the call names no fields'
    return { fieldCheck, query: sent, parsed, resolved: check.resolved, owners: check.owners, warnings }
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
    return { fieldCheck: `field names verified against a row of the table, because ${why}`, query: sent, parsed, resolved: check.resolved, owners: check.owners, warnings }
  }

  if (probe.total === 0) {
    return { fieldCheck: `not possible: ${why}, and the table has no rows to check against. An empty table answers every query with 0 rows.`, query: sent, parsed, resolved: check.resolved, owners: check.owners, warnings }
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
  return { fieldCheck: `not possible: ${why}, and no row of the table is visible to check against`, query: sent, parsed, resolved: check.resolved, owners: check.owners, warnings }
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
    const byName = [...parsed.conditions.filter(({ operator }) => !COMPARES_IDS.has(operator)).flatMap(({ field, second }) => (second ? [field, second] : [field])), ...parsed.sorts]
    for (const field of new Set(byName)) {
      const hidden = await ctx.closed.hidesNames(table, field)
      if (!hidden) continue
      const where = hidden === 'closed' ? `${resolved.get(field)?.reference ?? 'a table'}, which is closed on this machine or has closed tables below it` : 'a table that cannot be told, and tables are closed on this machine'
      throw new ServiceNowError(
        `"${field}" points into ${where}. Comparing it with text or sorting by it works on the names of the records there, ` +
          'so those names could be found out by trying. Compare it with a sys_id (=, IN) or ask whether it is filled. Nothing was sent.',
        'blocked',
        table,
      )
    }
  }

  const compared = new Set([...parsed.otherFields, ...parsed.conditions.filter((condition) => !asksIfFilled(condition)).map(({ field }) => field)])
  if (ctx.sn.restricted) {
    const named = [...compared].find((field) => recordNameKey(table, field, resolved.get(field)))
    if (named) {
      throw new ServiceNowError(
        `"${named}" holds the readable names of records of other tables, and tables are closed on this machine. It can be read, without the names of records in closed tables, ` +
          'but not compared or sorted by: those names could be found out by trying. Filter on the update name instead. Nothing was sent.',
        'blocked',
        table,
      )
    }
  }
  // A text search looks into fields the query does not name. Where one of them holds a secret, it is a way to probe it.
  if (parsed.textSearch) {
    const columns = await ctx.dict.columnSet(table).catch(unlessNoConnection(null))
    const refuse = (why: string) => validation(`A text search looks into the fields of "${table}" without naming them, and ${why}. Filter on named fields instead. Nothing was sent.`, table)
    // Without the full list of fields there is no telling what the search would look into.
    if (!columns || columns.partial) throw refuse('the fields of this table could not be read completely, so it cannot be told whether one of them holds a secret')
    const all = [...columns.columns.values()]
    const secret = all.filter((column) => holdsSecret(column, column.name)).map((column) => column.name)
    if (secret.length) throw refuse(`this table has fields that hold secrets (${secret.slice(0, 5).join(', ')})`)
    const payload = all.find((column) => recordPayload(table, column.name, column))
    if (payload) throw refuse(`"${payload.name}" holds whole records as text, secrets included`)
    // On sys_properties itself the properties that hold secrets are taken out of the query, below. Through a view
    // their type is not at hand.
    if (table !== 'sys_properties' && (await propertyValueFields(ctx, table)).size) throw refuse('this view reads the values of system properties, and some of them are secrets')
    // Measured: a text search finds a record by the name behind one of its references. A caller whose name stood in
    // no text field of an incident was found on all 8 of his incidents. So it is a way to try out names.
    if (ctx.sn.restricted) {
      for (const column of all) {
        if (!(await ctx.closed.hidesNames(table, column.name))) continue
        throw refuse(`it also finds records by the names behind their references: "${column.name}" points into a table that is closed on this machine, or that cannot be told`)
      }
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

  const untyped = await ctx.sn.query<Row>({ table: 'sys_properties', query: 'typeISEMPTY', fields: ['sys_id'], limit: 1 }).then(
    (page) => page.total,
    () => null,
  )
  warnings.push(
    'The query compares or sorts by the value of system properties. Properties that hold a secret (type password or password2) and properties without a type ' +
      'were left out of it, so that no secret can be found out by trying. The total does not count them. ' +
      (untyped === 0
        ? 'This instance has no property without a type.'
        : `${untyped === null ? 'Properties' : `The ${untyped} propert${untyped === 1 ? 'y' : 'ies'}`} without a type can be read with the query typeISEMPTY: a value comes back there unless the name suggests a secret.`),
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
    // "=NULL" and "!=NULL" ask whether the field is empty. With every other operator NULL is a value like any other,
    // and measured it matches nothing: sys_created_on>NULL, <NULL and BETWEENNULL@NULL gave 0 of 82, "IN NULL" as well.
    const asksEmpty = (operator === '=' || operator === '!=') && (value === '' || value === 'NULL')
    if (asksEmpty) continue
    // ON carries a label first, then the two ends of the range. An empty entry in a list is skipped by the instance.
    const given = (named ? value.split('@').slice(1) : operator === 'BETWEEN' ? value.split('@') : operator.endsWith('IN') ? value.split(',') : [value])
      .map((item) => item.trim())
      .filter((item) => item !== '')
    if (given.includes('NULL')) {
      throw validation(
        `NULL stands for "empty" only behind = and !=. Behind ${operator} it is a value, and measured it matches nothing. To ask for empty fields write ${field}ISEMPTY, also joined with ^OR. Nothing was sent.`,
        table,
      )
    }
    // Measured: activeBETWEENfoo@bar and activeONa@b@c returned the rows where the field is false, and ON on a number field none.
    if ((type === 'boolean' && (named || operator === 'BETWEEN')) || (NUMBER_TYPES.has(type) && named)) {
      throw validation(
        `${operator} is for dates, and "${field}" ${type === 'boolean' ? 'is a true/false field' : 'holds a number'}. Measured: the instance does not reject it and answers with the wrong rows or with none. ` +
          `Compare with ${type === 'boolean' ? '=true or =false' : '=, >, <, IN or BETWEEN'}. Nothing was sent.`,
        table,
      )
    }

    if (type === 'glide_time') {
      // Measured on 1,309 filled rows: a time of day is stored as a point in time on 1970-01-01. "<field>=08:00:00"
      // matched nothing, ">12:00:00" nothing, "<12:00:00" and ">abc" every row; with the date in front it compares.
      const odd = given.find((item) => !isDate(item))
      if (odd !== undefined) {
        throw validation(
          `"${field}" holds a time of day, which is stored as a point in time on 1970-01-01, and "${odd}" is not written that way. Eight in the morning is 1970-01-01 08:00:00. ` +
            'Measured: a bare time is not rejected, and the condition then matches nothing or every row. Nothing was sent.',
          table,
        )
      }
    } else if (DURATION_TYPES.has(type)) {
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
    } else if (type === 'boolean') {
      const odd = given.find((item) => !isBoolean(item))
      if (odd !== undefined) {
        throw validation(
          `"${field}" is a true/false field. Write true or false. Measured: ServiceNow reads every other value as false, so "${odd}" would be compared as false. Nothing was sent.`,
          table,
        )
      }
    } else if (NUMBER_TYPES.has(type)) {
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

/**
 * A reference stores the sys_id of a record. Measured on 82 incidents, 40 with a group and 12 of those in one group:
 * "assignment_group!=<the name of that group>" matched all 40, because no row holds a name, and
 * "assignment_group.name!=<the name>" matched 28. The first is an answer that looks right and leaves nothing out.
 *
 * Not every sys_id is 32 hex digits: "global" is the sys_id of a scope and "Default view" that of a view. So a value
 * of another shape is looked up in the table the reference points to before anything is said. "=" with a name
 * matches nothing, and an empty answer is explained where it is given.
 */
async function refuseNamesInPlaceOfIds(ctx: Context, table: string, parsed: ParsedQuery, resolved: Map<string, Column>, warnings: string[]): Promise<void> {
  for (const { field, operator, value } of parsed.conditions) {
    const column = resolved.get(field)
    if (column?.type !== 'reference' || !column.reference || (operator !== '!=' && operator !== 'NOT IN')) continue
    const target = column.reference
    const given = (operator === 'NOT IN' ? value.split(',') : [value]).map((item) => item.trim())
    const odd = [...new Set(given.filter((item) => item !== '' && item !== 'NULL' && !/^[0-9a-f]{32}$/i.test(item)))]
    if (!odd.length) continue

    const shown = (item: string) => `"${quoteInstanceText(item, 60)}"`
    const how = (item: string) =>
      `To leave out a record by one of its fields write ${field}.<field>${operator}…, for example ${field}.name${operator}${item}. If ${shown(item)} is a sys_id after all, write ${field}.sys_id${operator}${item}.`
    const refuse = (item: string) =>
      validation(
        `"${field}" is a reference to ${target} and stores a sys_id, and no record there has the sys_id ${shown(item)}. With a name, "${operator}" leaves no row out: ` +
          `measured, the answer then counts the rows it was meant to exclude. ${how(item)} Nothing was sent.`,
        table,
      )
    const notLookedUp = (item: string, why: string) =>
      warnings.push(`"${field}" is a reference to ${target} and stores a sys_id. ${shown(item)} does not look like one, and ${why}. If it is a name, "${operator}" leaves no row out. ${how(item)}`)

    // A sys_id has at most 32 characters, and neither a comma nor a caret.
    const impossible = odd.find((item) => item.length > 32 || /[\^,]/.test(item))
    if (impossible !== undefined) throw refuse(impossible)

    // Where rows of the referenced table are closed on this machine, they are left out of every answer about it.
    // A look-up would say "no such record" of a record that is there, and so tell which sys_id belongs to a closed table.
    if (await ctx.closed.mayHoldClosed(target)) {
      notLookedUp(odd[0], 'it was not looked up, because rows of that table are closed on this machine')
      continue
    }

    // Whether a value of another shape is a sys_id, the referenced table says. Each sys_id is one record, so the
    // total says how many of the values exist: one request for all of them.
    for (let from = 0; from < odd.length; from += 40) {
      const group = odd.slice(from, from + 40)
      const query = group.length === 1 ? `sys_id=${group[0]}` : `sys_idIN${group.join(',')}`
      const page = await ctx.sn.query<Row>({ table: target, query, fields: ['sys_id'], limit: group.length }).catch(unlessNoConnection(null))
      if (!page || page.total === null) {
        notLookedUp(group[0], 'it could not be checked whether a record has it')
        continue
      }
      if (page.total >= group.length) continue
      // Fewer records than values. Which one is missing: the rows that came back say it, and where rows are hidden
      // from this account, each value that did not come back is asked for by itself.
      const found = new Set(page.records.map((row) => String(row.sys_id ?? '').toLowerCase()))
      for (const item of group.filter((candidate) => !found.has(candidate.toLowerCase()))) {
        const exists = group.length === 1 ? 0 : await ctx.sn.query<Row>({ table: target, query: `sys_id=${item}`, fields: ['sys_id'], limit: 1 }).then((one) => one.total, unlessNoConnection(null))
        if (exists === 0) throw refuse(item)
        if (exists === null) notLookedUp(item, 'it could not be checked whether a record has it')
      }
    }
  }
}

/** A condition on a journal field is applied, but not as written. The entries themselves can be queried exactly. */
function refuseJournalConditions(table: string, parsed: ParsedQuery, resolved: Map<string, Column>): void {
  const used = [...parsed.conditions.flatMap(({ field, second }) => (second ? [field, second] : [field])), ...parsed.sorts]
  const journal = used.find((field) => JOURNAL_TYPES.has(resolved.get(field)?.type ?? ''))
  if (!journal) return
  const element = resolved.get(journal)?.sourceField ?? journal.split('.').at(-1)
  throw validation(
    `"${journal}" is a journal field. Its entries are stored in the table sys_journal_field, and a condition on the field itself does not do what it says: ` +
      'measured, "is empty" and "is not empty" return the same rows, and LIKE also finds text of the other journal fields of a record. ' +
      `Query sys_journal_field instead, for example element=${element}^valueLIKE<text>: "element_id" is the sys_id of the record, "name" its table. Nothing was sent.`,
    table,
  )
}

/**
 * Measured: "is not" leaves out the rows where the field is empty. An agent counting "everything except X" misses
 * them. Not said where the query asks for the empty rows itself, on the field or on the reference in front of it:
 * measured, "assignment_group.name!=X^ORassignment_group.nameISEMPTY" also takes the rows without a group.
 */
function warnAboutEmptyFields(parsed: ParsedQuery, resolved: Map<string, Column>, warnings: string[]): void {
  const asked = parsed.conditions.filter(({ operator, value }) => operator === 'ISEMPTY' || (operator === '=' && (value === '' || value === 'NULL')))
  // Only where it is joined to the condition with ^OR. In another part of the query it adds nothing to this one.
  const covered = ({ field, group }: Condition) => asked.some((empty) => empty.group === group && (field === empty.field || field.startsWith(`${empty.field}.`)))
  const skipping = parsed.conditions.filter((condition) => SKIPS_EMPTY.has(condition.operator) && !asksIfFilled(condition) && !covered(condition) && resolved.get(condition.field)?.type !== 'boolean')
  if (!skipping.length) return
  const fields = [...new Set(skipping.map(({ field }) => field))]
  const operators = [...new Set(skipping.map(({ operator }) => `"${operator}"`))]
  warnings.push(
    `${operators.join(', ')} ${operators.length === 1 ? 'leaves' : 'leave'} out rows where the field is empty (${fields.join(', ')}). ` +
      `To count those rows too, add ^OR${fields[0]}ISEMPTY behind the condition.`,
  )
}

/** Operators that compare a field with the values given. For these a label in place of a stored value is a mistake. */
const COMPARES_VALUES = new Set(['=', '!=', 'IN', 'NOT IN'])

/**
 * "state=Resolved" matches nothing, because a choice field stores "6", and
 * "state!=Resolved" matches nothing either where the stored value is a number.
 * The answer would be a correct-looking zero. Where the value is plainly a label,
 * in whatever language the instance has one, the query is refused and the stored
 * value is named.
 */
async function refuseChoiceLabels(ctx: Context, table: string, parsed: ParsedQuery, check: FieldCheck, warnings: string[]): Promise<void> {
  for (const { field, operator, value } of parsed.conditions) {
    const column = check.resolved.get(field)
    const owner = check.owners.get(field)
    if (!column?.choice || !owner || !COMPARES_VALUES.has(operator)) continue

    // The list of the table the field belongs to: for a dot-walked field the table the walk ends on, for a field
    // of a database view the table it comes from.
    const choices = await ctx.dict.choices(owner.table, owner.field).catch(() => null)
    if (!choices) {
      warnings.push(`"${field}" is a choice field, and its values could not be checked (the choice list could not be read). A label in place of the stored value would match nothing.`)
      continue
    }
    if (!choices.length) continue
    const stored = new Set(choices.map((choice) => choice.value.toLowerCase()))

    // Measured: a blank after a comma is ignored. "categoryINinquiry, software" matched what it matches without one.
    for (const given of operator.endsWith('IN') ? value.split(',').map((item) => item.trim()) : [value.trim()]) {
      if (given === '' || given === 'NULL' || stored.has(given.toLowerCase())) continue
      const meant = choices.find((choice) => choice.label.toLowerCase() === given.toLowerCase())
      if (meant) {
        throw validation(
          `"${field}" stores the value of a choice, not its label: "${given}" is the label of "${quoteInstanceText(meant.value, 80)}". ` +
            `Write ${quoteInstanceText(meant.value, 80)} instead. With the label ServiceNow does not compare what was meant, and the answer would mislead. Nothing was sent.`,
          table,
        )
      }
      // A word on a choice that stores numbers: no label as it stands, but the list is at hand, so it is shown.
      if (NUMBER_TYPES.has(column.type) && !isNumber(given)) {
        const near = [...new Map(choices.filter((choice) => choice.label.toLowerCase().includes(given.toLowerCase())).map((choice) => [choice.value, choice])).values()]
        const closest = near.length === 1 ? ` The label that contains it belongs to the value ${quoteInstanceText(near[0].value, 80)}.` : ''
        throw validation(
          `"${field}" stores the value of a choice, a number, and "${quoteInstanceText(given, 60)}" is neither one of its values nor one of its labels.${closest} ` +
            `Its values: ${describeChoices(choices)}. Nothing was sent.`,
          table,
        )
      }
    }
  }
}

/** The values of a choice list with their labels, one entry per value: its English label where it has one. */
function describeChoices(choices: Choice[]): string {
  const labels = new Map<string, string>()
  for (const choice of choices) if (!labels.has(choice.value) || choice.language === 'en') labels.set(choice.value, choice.label)
  const list = [...labels].slice(0, 15).map(([stored, label]) => `${quoteInstanceText(stored, 80)} (${quoteInstanceText(label, 80)})`)
  return `${list.join(', ')}${labels.size > 15 ? `, and ${labels.size - 15} more` : ''}`
}

/**
 * Reasons why a query that matched nothing may have matched nothing for the
 * wrong reason. Called only for an empty result.
 */
export async function explainEmpty(ctx: Context, guard: Guard): Promise<string[]> {
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
    } else if (column.choice && given.length) {
      const owner = guard.owners.get(field)
      const choices = owner ? await ctx.dict.choices(owner.table, owner.field).catch(() => []) : []
      const stored = new Set(choices.map((choice) => choice.value.toLowerCase()))
      const odd = given.map((item) => item.trim()).find((item) => !stored.has(item.toLowerCase()))
      if (choices.length && odd) {
        notes.push(`"${odd}" is not among the choice values of "${field}": that can be why nothing matched. Its values: ${describeChoices(choices)}.`)
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
  // Without regard to case, as the instance compares the same names in the filters above.
  const name = user.toLowerCase()
  return name === '' || name === 'system' || name === 'guest' || name.includes('@snc.')
}

export type CapturedBy = 'people' | 'system_accounts' | 'nobody'

/**
 * For each update name: who made its captured changes. "people" if a person is on any of its update rows,
 * "system_accounts" if rows exist and no person is on any of them, "nobody" if no row exists. Asked in batches,
 * the second question only for the names that have rows. A name is missing from the answer where its batch could
 * not be read: that is "not known", and the caller says so.
 */
export async function capturedByName(ctx: Context, names: string[], onFailure: (kind: string) => void = () => {}): Promise<Map<string, CapturedBy>> {
  const known = new Map<string, CapturedBy>()
  // Never a query longer than the address of a request should be.
  const batches = (list: string[], most: number, length: number) => {
    const chunks: string[][] = [[]]
    for (const name of list) {
      const last = chunks[chunks.length - 1]
      if (last.length >= most || last.join(',').length + name.length > length) chunks.push([name])
      else last.push(name)
    }
    return chunks.filter((chunk) => chunk.length)
  }
  const wanted = [...new Set(names)].filter(isPlainValue)
  const captured: string[] = []
  try {
    for (const chunk of batches(wanted, 50, 4_000)) {
      const groups = await ctx.sn.groupCount('sys_update_xml', 'name', `nameIN${chunk.join(',')}`)
      const found = new Set(groups.filter((group) => group.count > 0).map((group) => group.value))
      for (const name of chunk) {
        if (found.has(name)) captured.push(name)
        else known.set(name, 'nobody')
      }
    }
    // The filter stands in the query twice, once for who created a row and once for who changed it last.
    for (const chunk of batches(captured, 25, 1_800)) {
      const groups = await ctx.sn.groupCount('sys_update_xml', 'name', withPeopleOnly(`nameIN${chunk.join(',')}`))
      const byPeople = new Set(groups.filter((group) => group.count > 0).map((group) => group.value))
      for (const name of chunk) known.set(name, byPeople.has(name) ? 'people' : 'system_accounts')
    }
  } catch (error) {
    onFailure(errorKind(error))
  }
  return known
}
