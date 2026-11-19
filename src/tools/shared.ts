import type { ServiceNowClient } from '../client.js'
import type { Dictionary } from '../dictionary.js'
import { validation } from '../errors.js'
import { assertFieldPath, fieldsInEncodedQuery } from '../query.js'

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

/**
 * Refuses a query or field list that names a field the table does not have.
 * Returns a sentence for the answer that says whether the check could be made.
 */
export async function guardFields(ctx: Context, table: string, query: string, fields: string[] = []): Promise<string> {
  fields.forEach((field) => assertFieldPath(field, table))
  const check = await ctx.dict.checkFields(table, [...fieldsInEncodedQuery(query, table), ...fields])

  if (check.unknown.length) {
    const details = check.unknown
      .map((item) => `${item.field}: ${item.reason}${item.suggestions.length ? ` (similar: ${item.suggestions.join(', ')})` : ''}`)
      .join('; ')
    throw validation(
      `Unknown field. ${details}. ServiceNow ignores a condition on an unknown field and answers unfiltered, so nothing was sent.`,
      table,
    )
  }

  return check.status === 'checked'
    ? 'all field names verified against sys_dictionary'
    : `not possible: ${check.reason}. A condition on a misspelled field would be ignored by the instance.`
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
  return error && typeof error === 'object' && 'kind' in error ? String((error as { kind: unknown }).kind) : 'unknown'
}
