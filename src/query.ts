import { validation } from './errors.js'

/**
 * Everything an agent passes in ends up in a URL or in ServiceNow's encoded-query
 * language. This module is the only place that decides what is allowed through.
 *
 * The rule is strict on purpose: what cannot be checked is refused. ServiceNow
 * drops a condition on an unknown field and answers unfiltered, so a query that
 * slips through unchecked can turn into wrong evidence without any error.
 */

const TABLE_NAME = /^[a-z0-9_]{1,80}$/
const FIELD_PATH = /^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*$/
const SYS_ID = /^[0-9a-f]{32}$/
const SCRIPT = /javascript\s*:/i

/** Source: ServiceNow docs, "Operators available for filters and queries". Longest first. */
const OPERATORS = [
  'IN_HIERARCHY_DYNAMIC',
  'GT_OR_EQUALS_FIELD',
  'LT_OR_EQUALS_FIELD',
  'IN_HIERARCHY',
  'DOESNOTHAVE',
  'EMPTYSTRING',
  'CHANGESFROM',
  'STARTSWITH',
  'ISNOTEMPTY',
  'INSTANCEOF',
  'VALCHANGES',
  'RELATIVEGT',
  'RELATIVELT',
  'RELATIVEGE',
  'RELATIVELE',
  'RELATIVEEE',
  'CHANGESTO',
  'EXCLUDING',
  'ENDSWITH',
  'NOT LIKE',
  'ANYTHING',
  'GT_FIELD',
  'LT_FIELD',
  'DATEPART',
  'MORETHAN',
  'LESSTHAN',
  'BETWEEN',
  'NSAMEAS',
  'ISEMPTY',
  'DYNAMIC',
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

/** Operators whose value starts with the name of a second field. */
const FIELD_COMPARISONS = new Set([
  'SAMEAS',
  'NSAMEAS',
  'GT_FIELD',
  'LT_FIELD',
  'GT_OR_EQUALS_FIELD',
  'LT_OR_EQUALS_FIELD',
  'MORETHAN',
  'LESSTHAN',
])

const GRAMMAR =
  'Supported: conditions of the form <field><OPERATOR><value> joined by ^, ^OR or ^NQ, plus ' +
  'ORDERBY<field>, ORDERBYDESC<field> and 123TEXTQUERY321=<term>. Field names are lowercase; dot-walking is allowed.'

export function assertTableName(table: string): void {
  if (!TABLE_NAME.test(table)) {
    throw validation(
      `"${table}" is not a valid table name. Table names contain only lowercase letters, digits and underscores.`,
      table,
    )
  }
}

export function assertFieldPath(field: string, table?: string): void {
  if (!FIELD_PATH.test(field)) {
    throw validation(`"${field}" is not a valid field name. Use lowercase names; dots for dot-walking.`, table)
  }
}

export function assertSysId(value: string): void {
  if (!SYS_ID.test(value)) throw validation(`"${value}" is not a sys_id (32 lowercase hex characters).`)
}

/**
 * A value that tools place inside a query they build themselves (a name filter,
 * a file pattern). It must stay a value: "^" would start a new condition.
 */
export function assertPlainValue(value: string, label: string): void {
  if (/[\^\n\r]/.test(value)) {
    throw validation(`${label} must not contain "^" or line breaks: it is a value, not a query.`)
  }
  if (SCRIPT.test(value)) throw validation(`${label} must not contain "javascript:".`)
}

function assertNoScript(query: string, table?: string): void {
  if (SCRIPT.test(query)) {
    throw validation(
      'Queries containing "javascript:" are not sent. ServiceNow would run that script on the instance. ' +
        'Use fixed values instead, for dates the form YYYY-MM-DD HH:MM:SS (UTC).',
      table,
    )
  }
}

/**
 * Parses an encoded query and returns every field path it mentions, so they can
 * be checked against the dictionary. Throws on anything outside the supported grammar.
 */
export function fieldsInEncodedQuery(query: string, table?: string): string[] {
  if (!query) return []
  assertNoScript(query, table)
  if (/[\n\r]/.test(query)) throw validation('A query must be a single line.', table)

  const fields: string[] = []
  const unsupported = (term: string, why: string) =>
    validation(`Cannot check the query term "${term}": ${why}. ${GRAMMAR}`, table)

  for (const raw of query.split('^')) {
    if (raw === '' || raw === 'EQ') continue

    let term = raw
    const sort = /^(ORDERBYDESC|ORDERBY)(.*)$/s.exec(term)
    if (sort) {
      if (!FIELD_PATH.test(sort[2])) throw unsupported(raw, 'the sort field is not a valid field name')
      fields.push(sort[2])
      continue
    }

    if (term.startsWith('NQ') || term.startsWith('OR')) term = term.slice(2)
    if (term.startsWith('123TEXTQUERY321=')) continue

    const match = /^([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*)(.*)$/s.exec(term)
    if (!match) throw unsupported(raw, 'it does not start with a field name')

    const [, field, rest] = match
    const operator = OPERATORS.find((op) => rest.startsWith(op))
    if (!operator) throw unsupported(raw, `no known operator follows the field "${field}"`)

    fields.push(field)
    if (FIELD_COMPARISONS.has(operator)) {
      const other = rest.slice(operator.length).split('@')[0]
      if (!FIELD_PATH.test(other)) throw unsupported(raw, `${operator} needs a field name as its value`)
      fields.push(other)
    }
  }

  return [...new Set(fields)]
}
