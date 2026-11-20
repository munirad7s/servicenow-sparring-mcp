import type { Row, ServiceNowClient } from '../client.js'
import type { Column, Dictionary } from '../dictionary.js'
import { ServiceNowError, validation } from '../errors.js'
import { assertFieldPath, parseEncodedQuery, type ParsedQuery } from '../query.js'

export interface Context {
  sn: ServiceNowClient
  dict: Dictionary
}

export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const

/** Field types whose values are secrets, stored hashed or encrypted. The Table API hands them out as they are stored. */
export const SECRET_TYPES = new Set(['password', 'password2', 'glide_encrypted'])
export const SECRET_NOTE = '[withheld: this field holds a secret]'
/** Where the type of a field cannot be read, its name is the only sign left. */
export const LOOKS_SECRET = /passw(or)?d|passphrase|secret|token|credential|private_?key|api_?key/i

export interface Guard {
  /** A sentence for the answer: how the field names were verified. */
  fieldCheck: string
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
 */
export async function guardFields(ctx: Context, table: string, query: string, fields: string[] = []): Promise<Guard> {
  if (!ctx.sn.allows(table)) {
    throw new ServiceNowError(`Table "${table}" is closed on this machine (SERVICENOW_TABLE_ALLOW, SERVICENOW_TABLE_DENY). Nothing was sent.`, 'blocked', table)
  }
  fields.forEach((field) => assertFieldPath(field, table))
  const parsed = parseEncodedQuery(query, table)
  const paths = [...new Set([...parsed.fields, ...fields])]
  const warnings: string[] = []
  if (parsed.escapedCaret) {
    warnings.push('The query contains "^^". ServiceNow reads that as a literal ^ inside a value, not as a separator between conditions.')
  }

  if (!paths.length && !ctx.sn.restricted) return { fieldCheck: 'not needed: the call names no fields', parsed, resolved: new Map(), warnings }

  const check = await ctx.dict.checkFields(table, paths)
  if (check.unknown.length) {
    const details = check.unknown
      .map((item) => `${item.field}: ${item.reason}${item.suggestions.length ? ` (similar: ${item.suggestions.join(', ')})` : ''}`)
      .join('; ')
    throw validation(
      `Unknown field. ${details}. ServiceNow ignores a condition on an unknown field and answers unfiltered, so nothing was sent.`,
      table,
    )
  }

  // A table that is closed on this machine must not be read through the side door either.
  const closed = [...check.reached].filter((name) => !ctx.sn.allows(name))
  if (closed.length) {
    throw new ServiceNowError(
      `This query reads from ${closed.join(', ')} through a dot-walk or a database view, and ${closed.length === 1 ? 'that table is' : 'those tables are'} closed on this machine. Nothing was sent.`,
      'blocked',
      closed[0],
    )
  }
  if (ctx.sn.restricted && check.status !== 'checked') {
    throw new ServiceNowError(
      `Tables are closed on this machine, and it could not be established which tables this query reads from (${check.reason ?? 'the dictionary could not be used'}). Nothing was sent.`,
      'blocked',
      table,
    )
  }

  if (check.status === 'checked') {
    await refuseChoiceLabels(ctx, table, parsed, check.resolved, warnings)
    const fieldCheck = paths.length ? 'all field names verified against sys_dictionary' : 'not needed: the call names no fields'
    return { fieldCheck, parsed, resolved: check.resolved, warnings }
  }

  // Not every name could be checked against the dictionary. What it did resolve is still checked for choice labels.
  await refuseChoiceLabels(ctx, table, parsed, check.resolved, warnings)
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
    return { fieldCheck: `field names verified against a row of the table, because ${why}`, parsed, resolved: check.resolved, warnings }
  }

  if (probe.total === 0) {
    return { fieldCheck: `not possible: ${why}, and the table has no rows to check against. An empty table answers every query with 0 rows.`, parsed, resolved: check.resolved, warnings }
  }
  if (parsed.fields.length) {
    throw new ServiceNowError(
      `The field names in this query could not be verified: ${why}, and no row of "${table}" is visible to check against. ` +
        'A condition on a misspelled field would be ignored and the answer would be unfiltered, so the query was not sent.',
      'acl',
      table,
    )
  }
  return { fieldCheck: `not possible: ${why}, and no row of the table is visible to check against`, parsed, resolved: check.resolved, warnings }
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
          `"${field}" stores the value of a choice, not its label: "${given}" is the label of "${meant.value}". ` +
            `Write ${meant.value} instead. With the label ServiceNow does not compare what was meant, and the answer would mislead. Nothing was sent.`,
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
      const choices = await ctx.dict.choices(table, field).catch(() => [])
      const stored = new Set(choices.map((choice) => choice.value.toLowerCase()))
      const odd = given.find((item) => !stored.has(item.toLowerCase()))
      if (choices.length && odd) {
        const list = choices.slice(0, 15).map((choice) => `${choice.value} (${choice.label})`).join(', ')
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
 */
const BY_SYSTEM = (field: string) => `${field}INsystem,guest^OR${field}LIKE@snc.`
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
  return user === 'system' || user === 'guest' || user.includes('@snc.')
}
