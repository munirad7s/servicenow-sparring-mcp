import { validation } from './errors.js'

/**
 * Everything an agent passes in ends up in a URL or in ServiceNow's encoded-query
 * language. This module is the only place that decides what is allowed through.
 *
 * The rule is strict on purpose: what cannot be checked is refused. ServiceNow
 * does not reject a condition it cannot use. It drops it and answers unfiltered,
 * or it matches nothing. Either way the answer looks like evidence and is not.
 * Which forms are applied, dropped or empty was measured against a live instance;
 * docs/encoded-queries.md lists the results.
 */

const SEGMENT = '[a-z_][a-z0-9_]{0,79}'
const TABLE_NAME = /^[a-z0-9_]{1,80}$/
const FIELD_PATH = new RegExp(`^${SEGMENT}(?:\\.${SEGMENT}){0,9}$`)
const FIELD_PREFIX = new RegExp(`^(${SEGMENT}(?:\\.${SEGMENT}){0,9})(.*)$`, 's')
const SYS_ID = /^[0-9A-Za-z_]{1,32}$/
const CONTROL = /[\u0000-\u001f\u007f]/
const MAX_QUERY_LENGTH = 8_000

/** Longest first, so that "IN" does not win over "INSTANCEOF". Each one was seen to work on a live instance, except IN_HIERARCHY, which is taken from the documentation. */
const OPERATORS = [
  'GT_OR_EQUALS_FIELD',
  'LT_OR_EQUALS_FIELD',
  'ISEMPTYSTRING',
  'IN_HIERARCHY',
  'STARTSWITH',
  'ISNOTEMPTY',
  'INSTANCEOF',
  'RELATIVEGT',
  'RELATIVELT',
  'RELATIVEGE',
  'RELATIVELE',
  'RELATIVEEE',
  'ENDSWITH',
  'NOT LIKE',
  'CONTAINS',
  'ANYTHING',
  'GT_FIELD',
  'LT_FIELD',
  'MORETHAN',
  'LESSTHAN',
  'BETWEEN',
  'NSAMEAS',
  'ISEMPTY',
  'NOT IN',
  'SAMEAS',
  'NOTON',
  'LIKE',
  '!=',
  '>=',
  '<=',
  'IN',
  'ON',
  '=',
  '>',
  '<',
] as const

type Operator = (typeof OPERATORS)[number]

/** Operators ServiceNow knows but that cannot give a trustworthy answer here. Checked before OPERATORS. */
const REFUSED: Array<[string, string]> = [
  ['IN_HIERARCHY_DYNAMIC', 'it runs a script stored on the instance'],
  ['DYNAMIC', 'it runs a script stored on the instance; look up the sys_id it stands for and compare with = or IN'],
  ['VALCHANGES', 'it compares with the previous value of a record, which exists only inside a business rule; here it matches nothing'],
  ['CHANGESFROM', 'it compares with the previous value of a record, which exists only inside a business rule; here it matches nothing'],
  ['CHANGESTO', 'it compares with the previous value of a record, which exists only inside a business rule; here it matches nothing'],
  ['DATEPART', 'it needs a "javascript:" value'],
  ['MATCH_RGX', 'regular-expression operators are not checked'],
  ['MATCH_PAT', 'pattern operators are not checked'],
  ['EXCLUDING', 'it matched nothing when measured; use NOT IN'],
  ['DOESNOTHAVE', 'it matched nothing when measured'],
  ['EMPTYSTRING', 'it matched nothing when measured; use ISEMPTYSTRING or ISEMPTY'],
  ['NOTLIKE', 'the operator is written "NOT LIKE", with a space'],
  ['NOTIN', 'the operator is written "NOT IN", with a space'],
  ['<>', 'ServiceNow reads it as "<" followed by ">…"; use !='],
  ['==', 'ServiceNow reads it as "=" followed by "=…"; use a single ='],
]

const NO_VALUE = new Set<Operator>(['ISEMPTY', 'ISNOTEMPTY', 'ISEMPTYSTRING', 'ANYTHING'])
/** With an empty value these two mean "is empty" and "is not empty". Every other operator drops the condition or matches nothing. */
const EMPTY_VALUE_ALLOWED = new Set<Operator>(['=', '!='])
/** Tags and catalog variables are addressed like fields, but they are not in the dictionary and cannot be checked. */
const NOT_IN_DICTIONARY = /(?:^|\.)(sys_tags|variables)(?:\.|$)/
/** Where the same question can be asked in a form that can be checked. Both tables and their fields were looked up on an instance. */
const WHERE_INSTEAD: Record<string, string> = {
  sys_tags: 'A tag on a record is a row of the table label_entry: table=<table>^table_key=<sys_id of the record>^label.name=<tag>',
  variables:
    'The value of a catalog variable is a row of sc_item_option_mtom: request_item=<sys_id of the requested item>, with the question in sc_item_option.item_option_new.name and the answer in sc_item_option.value',
}
/** Query forms that reach into another table. Their field names cannot be checked against the dictionary of the queried one. */
const OTHER_TABLE = /^(RLQUERY|ENDRLQUERY|JOIN|SUBQUERY|ENDSUBQUERY|TRENDBY|HAVING)/
const RELATIVE = new Set<Operator>(['RELATIVEGT', 'RELATIVELT', 'RELATIVEGE', 'RELATIVELE', 'RELATIVEEE'])
const PLAIN_FIELD = new Set<Operator>(['GT_FIELD', 'LT_FIELD', 'GT_OR_EQUALS_FIELD', 'LT_OR_EQUALS_FIELD'])

const RELATIVE_VALUE = /^@(year|quarter|month|dayofweek|hour|minute)@(ago|ahead)@\d{1,6}$/
const SAME_AS_UNIT = /^(year|month|week|day|hour)$/
const OFFSET = /^(year|quarter|month|week|day|hour)@(before|after)@\d{1,6}$/

const GRAMMAR =
  'Supported: <field><OPERATOR><value>, joined by ^ (and), ^OR or ^NQ (new query), plus ORDERBY<field>, ' +
  'ORDERBYDESC<field> and 123TEXTQUERY321=<term>. Operators: = != > >= < <= LIKE, NOT LIKE, CONTAINS, STARTSWITH, ' +
  'ENDSWITH, IN, NOT IN, ISEMPTY, ISNOTEMPTY, BETWEEN<a>@<b>, INSTANCEOF<table>. Field names are lowercase; ' +
  'dot-walking is allowed. A ^ inside a value is written ^^.'

export interface Condition {
  field: string
  operator: string
  value: string
  /**
   * Conditions joined by ^OR carry the same number. Measured in both APIs: ^OR binds to the condition before it,
   * tighter than ^. "active=false^priority=1^ORpriority=2" matched the 10 inactive rows of priority 1, not those
   * and the 4 of priority 2.
   */
  group: number
  /** The field on the other side, where the operator compares two fields. */
  second?: string
}

export interface ParsedQuery {
  /** Every field path the query mentions: in conditions, in comparisons with a second field, and in sorting. */
  fields: string[]
  conditions: Condition[]
  /** The fields the query sorts by, and the second field of a comparison between two fields. */
  otherFields: string[]
  /** The fields the query sorts by. */
  sorts: string[]
  /** true if the query holds a text search (123TEXTQUERY321), which looks into fields it does not name. */
  textSearch: boolean
  /** true if the query contains "^^", a literal ^ inside a value. */
  escapedCaret: boolean
}

export function assertTableName(table: string): void {
  if (!TABLE_NAME.test(table)) {
    throw validation(
      `"${shorten(table)}" is not a valid table name. Table names contain only lowercase letters, digits and underscores.`,
    )
  }
}

export function isTableName(value: unknown): value is string {
  return typeof value === 'string' && TABLE_NAME.test(value)
}

export function assertFieldPath(field: string, table?: string): void {
  if (!FIELD_PATH.test(field)) {
    throw validation(`"${shorten(field)}" is not a valid field name. Use lowercase names; dots for dot-walking.`, table)
  }
}

/** The usual form of a sys_id. Some delivered records carry another one, a word such as "global". */
export function isGeneratedSysId(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value)
}

export function assertSysId(value: string): void {
  if (!SYS_ID.test(value)) {
    throw validation(`"${shorten(value)}" is not a sys_id. A sys_id has at most 32 letters, digits or underscores.`)
  }
}

/** A value read from the instance that is about to be placed into a query. */
export function isPlainValue(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= 250 && !/[\^,\u0000-\u001f\u007f]/.test(value) && !looksLikeScript(value)
}

/**
 * A value that tools place inside a query they build themselves (a name filter,
 * a file pattern). It must stay a value: "^" would start a new condition.
 */
export function assertPlainValue(value: string, label: string): void {
  if (value.length > 250) throw validation(`${label} is too long (at most 250 characters).`)
  if (value.includes('^') || CONTROL.test(value)) {
    throw validation(`${label} must not contain "^" or line breaks: it is a value, not a query.`)
  }
  if (looksLikeScript(value)) throw validation(`${label} must not contain "javascript:".`)
}

/**
 * "javascript:" in a query value makes the instance run that script. The check
 * looks through upper case, spaces, invisible characters and look-alike letters.
 */
function looksLikeScript(text: string): boolean {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/g, '')
    .includes('javascript:')
}

function shorten(text: string): string {
  return text.length > 80 ? `${text.slice(0, 80)}…` : text
}

/** Splits on ^. "^^" is ServiceNow's way to write a literal ^ inside a value. */
function splitTerms(query: string): string[] {
  const terms: string[] = []
  let current = ''
  for (let index = 0; index < query.length; index++) {
    if (query[index] !== '^') current += query[index]
    else if (query[index + 1] === '^') {
      current += '^'
      index++
    } else {
      terms.push(current)
      current = ''
    }
  }
  terms.push(current)
  return terms
}

/**
 * Parses an encoded query. Throws on anything outside the supported grammar, so
 * that every query that is sent consists of conditions whose fields can be
 * checked against the dictionary.
 */
export function parseEncodedQuery(query: string, table?: string): ParsedQuery {
  const parsed: ParsedQuery = { fields: [], conditions: [], otherFields: [], sorts: [], textSearch: false, escapedCaret: false }
  if (!query) return parsed

  if (query.length > MAX_QUERY_LENGTH) throw validation(`The query is longer than ${MAX_QUERY_LENGTH} characters.`, table)
  if (CONTROL.test(query)) throw validation('A query must be a single line without control characters.', table)
  if (looksLikeScript(query)) {
    throw validation(
      'Queries containing "javascript:" are not sent. ServiceNow would run that script on the instance. ' +
        'Use fixed values instead, for dates the form YYYY-MM-DD HH:MM:SS (UTC).',
      table,
    )
  }

  const unsupported = (term: string, why: string) =>
    validation(`Cannot check the query term "${shorten(term)}": ${why}. ${GRAMMAR}`, table)
  parsed.escapedCaret = query.includes('^^')
  const inDictionary = (path: string, raw: string) => {
    const special = NOT_IN_DICTIONARY.exec(path)
    if (special) {
      throw unsupported(
        raw,
        `${special[1]} is not sent, because it is addressed like a field but is not in the dictionary, so its use cannot be checked. ${WHERE_INSTEAD[special[1]]}`,
      )
    }
    return path
  }

  let afterTextSearch = false
  let group = -1
  for (const raw of splitTerms(query)) {
    if (raw === '' || raw === 'EQ') continue

    const sort = /^(ORDERBYDESC|ORDERBY|GROUPBY)(.*)$/s.exec(raw)
    if (sort) {
      if (sort[1] === 'GROUPBY') throw unsupported(raw, 'the Table API ignores GROUPBY in a query; to count rows per value use the groupBy input of sn_query')
      if (!FIELD_PATH.test(sort[2])) throw unsupported(raw, `${sort[1]} needs a field name`)
      parsed.fields.push(inDictionary(sort[2], raw))
      parsed.otherFields.push(sort[2])
      parsed.sorts.push(sort[2])
      continue
    }

    let term = raw
    const joinedWithOr = term.startsWith('OR')
    if (term.startsWith('NQ') || joinedWithOr) term = term.slice(2)
    if (term.startsWith('GOTO')) term = term.slice(4)

    if (afterTextSearch && joinedWithOr) throw unsupported(raw, 'nothing can be joined to a text search with ^OR: measured, the query then matches nothing')
    afterTextSearch = false
    if (term.startsWith('123TEXTQUERY321=')) {
      if (joinedWithOr) throw unsupported(raw, 'a text search cannot be joined with ^OR')
      if (term === '123TEXTQUERY321=') throw unsupported(raw, 'a text search needs a word to look for: without one it matches nothing')
      parsed.textSearch = true
      afterTextSearch = true
      continue
    }

    const match = FIELD_PREFIX.exec(term)
    const other = OTHER_TABLE.exec(term)
    if (other) {
      throw unsupported(raw, `${other[1]} asks about the records of another table, whose field names cannot be checked here. Query that table itself: its rows that point to a record with <reference field>=<sys_id>, or counted per record with the groupBy input`)
    }
    if (!match) throw unsupported(raw, 'it does not start with a lowercase field name')
    const [, field, rest] = match
    inDictionary(field, raw)

    const refused = REFUSED.find(([name]) => rest.startsWith(name))
    if (refused) throw unsupported(raw, `${refused[0]} is not sent, because ${refused[1]}`)

    const operator = OPERATORS.find((candidate) => rest.startsWith(candidate))
    if (!operator) throw unsupported(raw, `no supported operator follows the field "${field}"`)
    const value = rest.slice(operator.length)

    parsed.fields.push(field)
    const second = checkValue(operator, value, (why) => unsupported(raw, why))
    if (!joinedWithOr) group++
    parsed.conditions.push({ field, operator, value, group, ...(second ? { second } : {}) })
    if (second) {
      parsed.fields.push(inDictionary(second, raw))
      parsed.otherFields.push(second)
    }
  }

  parsed.fields = [...new Set(parsed.fields)]
  parsed.otherFields = [...new Set(parsed.otherFields)]
  parsed.sorts = [...new Set(parsed.sorts)]
  return parsed
}

/**
 * Adds a condition to every part of a query that is joined by ^NQ, so that it
 * holds for all of them.
 *
 * Measured on 82 incidents, 27 of them with priority 1: a part that holds no
 * condition is not a part. "EQ^NQpriority=1", "ORDERBYnumber^NQpriority=1" and
 * "priority=1^NQ" all match the 27. A condition added to such a part would make
 * it one: "EQ^active=false^NQpriority=1^active=false" matched all 29 inactive
 * incidents, where 10 was the answer. So the condition goes only to the parts
 * that have one already, and where no part has one, once to the end. A condition
 * behind an ORDERBY is applied: measured as well.
 */
export function withCondition(query: string, condition: string): string {
  const parts: string[][] = [[]]
  for (const term of splitTerms(query)) {
    if (term === '') continue
    if (term.startsWith('NQ')) {
      parts.push([])
      if (term.length > 2) parts.at(-1)!.push(term.slice(2))
    } else {
      parts.at(-1)!.push(term)
    }
  }
  const filters = (term: string) => term !== 'EQ' && !/^(ORDERBYDESC|ORDERBY|GROUPBY)/.test(term)
  const filled = parts.filter((part) => part.length)
  const filtering = filled.filter((part) => part.some(filters))
  for (const part of filtering.length ? filtering : filled.slice(-1)) part.push(condition)
  if (!filled.length) return condition
  // A literal caret inside a value is written twice. The condition is written by this server and carries none.
  return filled.map((part) => part.map((term) => (term === condition ? term : term.replaceAll('^', '^^'))).join('^')).join('^NQ')
}

/**
 * Checks the shape of a value where ServiceNow would otherwise drop the condition
 * or match nothing. Returns the second field of a field comparison.
 */
function checkValue(operator: Operator, value: string, unsupported: (why: string) => Error): string | undefined {
  const parts = value.split('@')

  if (NO_VALUE.has(operator)) {
    if (value !== '') throw unsupported(`${operator} takes no value; ServiceNow would ignore "${shorten(value)}"`)
  } else if (operator === 'ON' || operator === 'NOTON') {
    if (parts.length !== 3 || parts.some((part) => part === '')) {
      throw unsupported(`${operator} needs <label>@<start>@<end>, for example 2026-01-15@2026-01-15 00:00:00@2026-01-15 23:59:59; ServiceNow drops any other form`)
    }
  } else if (operator === 'BETWEEN') {
    if (parts.length !== 2 || parts.some((part) => part === '')) {
      throw unsupported('BETWEEN needs <from>@<to>; ServiceNow drops any other form')
    }
  } else if (RELATIVE.has(operator)) {
    if (!RELATIVE_VALUE.test(value)) {
      throw unsupported(`${operator} needs @<unit>@<ago|ahead>@<number>, with the unit year, quarter, month, dayofweek (days), hour or minute; other forms match nothing`)
    }
  } else if (operator === 'INSTANCEOF') {
    if (!TABLE_NAME.test(value)) throw unsupported('INSTANCEOF needs a table name')
  } else if (operator === 'IN_HIERARCHY') {
    if (!SYS_ID.test(value)) throw unsupported('IN_HIERARCHY needs a sys_id')
  } else if (PLAIN_FIELD.has(operator)) {
    if (!FIELD_PATH.test(value)) throw unsupported(`${operator} needs a field name as its value`)
    return value
  } else if (operator === 'SAMEAS' || operator === 'NSAMEAS') {
    if (!FIELD_PATH.test(parts[0]) || parts.length > 2 || (parts.length === 2 && !SAME_AS_UNIT.test(parts[1]))) {
      throw unsupported(`${operator} needs <field>, or <field>@<unit> with the unit year, month, week, day or hour`)
    }
    return parts[0]
  } else if (operator === 'MORETHAN' || operator === 'LESSTHAN') {
    if (!FIELD_PATH.test(parts[0]) || !OFFSET.test(parts.slice(1).join('@'))) {
      throw unsupported(
        `${operator} needs <field>@<unit>@<before|after>@<number>, with the unit year, quarter, month, week, day or hour. ` +
          'To compare two fields directly use GT_FIELD or LT_FIELD',
      )
    }
    return parts[0]
  } else if (value === '' && !EMPTY_VALUE_ALLOWED.has(operator)) {
    throw unsupported(`${operator} needs a value. Without one ServiceNow drops the condition or matches nothing; to ask for empty fields use ISEMPTY or ISNOTEMPTY`)
  } else if ((operator === 'IN' || operator === 'NOT IN') && value.split(',').every((item) => item.trim() === '')) {
    // Measured: "IN," matches nothing. An empty item among others is skipped: "IN1," matched what "IN1" did.
    throw unsupported(`${operator} needs at least one value in its list; a list of nothing but commas matches nothing`)
  }
  return undefined
}

/** Every field path an encoded query mentions. Throws on anything outside the supported grammar. */
export function fieldsInEncodedQuery(query: string, table?: string): string[] {
  return parseEncodedQuery(query, table).fields
}
