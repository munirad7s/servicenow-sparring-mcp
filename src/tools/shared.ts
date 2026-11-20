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
  fields.forEach((field) => assertFieldPath(field, table))
  const parsed = parseEncodedQuery(query, table)
  const paths = [...new Set([...parsed.fields, ...fields])]
  const warnings: string[] = []
  if (parsed.escapedCaret) {
    warnings.push('The query contains "^^". ServiceNow reads that as a literal ^ inside a value, not as a separator between conditions.')
  }

  if (!paths.length) return { fieldCheck: 'not needed: the call names no fields', parsed, resolved: new Map(), warnings }

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

  if (check.status === 'checked') {
    await refuseChoiceLabels(ctx, table, parsed, check.resolved)
    return { fieldCheck: 'all field names verified against sys_dictionary', parsed, resolved: check.resolved, warnings }
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

/**
 * "state=Resolved" matches nothing, because a choice field stores "6". The answer
 * would be a correct-looking zero. Where the value is plainly a label, the query
 * is refused and the stored value is named.
 */
async function refuseChoiceLabels(ctx: Context, table: string, parsed: ParsedQuery, resolved: Map<string, Column>): Promise<void> {
  for (const { field, operator, value } of parsed.conditions) {
    const column = resolved.get(field)
    // A dot-walked field belongs to another table, and its choices can differ per child table. Those are left alone.
    if (!column?.choice || field.includes('.') || (operator !== '=' && operator !== 'IN')) continue

    const choices = await ctx.dict.choices(table, field).catch(() => [])
    if (!choices.length) continue
    const stored = new Set(choices.map((choice) => choice.value.toLowerCase()))

    for (const given of operator === 'IN' ? value.split(',') : [value]) {
      if (given === '' || given === 'NULL' || stored.has(given.toLowerCase())) continue
      const meant = choices.find((choice) => choice.label.toLowerCase() === given.toLowerCase())
      if (meant) {
        throw validation(
          `"${field}" stores the value of a choice, not its label: "${given}" is the label of "${meant.value}". ` +
            `Write ${meant.value} instead. With the label ServiceNow matches nothing, and the answer would be a misleading 0. Nothing was sent.`,
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
 */
export const BY_SYSTEM_ACCOUNT = 'sys_created_byINsystem,guest^ORsys_created_byLIKE@snc.'
export const NOT_BY_SYSTEM_ACCOUNT = 'sys_created_byNOT INsystem,guest^sys_created_byNOT LIKE@snc.'

export function isSystemAccount(user: string): boolean {
  return user === 'system' || user === 'guest' || user.includes('@snc.')
}
