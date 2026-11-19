import { z } from 'zod'
import type { Page, Row, ServiceNowClient } from './client.js'
import { ServiceNowError } from './errors.js'

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

/** Rough ceiling for one answer, so a single call cannot flood the agent's context. */
const MAX_ANSWER_CHARS = 60_000

export const rowSchema = z.record(z.string(), z.unknown())

/** Every answer says where it came from and when. */
export const sourceShape = {
  instance: z.string().describe('Host of the instance that answered.'),
  fetchedAt: z.string().describe('Time of the answer, ISO 8601, UTC.'),
  warnings: z.array(z.string()).describe('Things that limit how far this answer can be trusted.'),
}

/** Answers that list rows also say how complete the list is. */
export const listShape = {
  ...sourceShape,
  table: z.string(),
  query: z.string().describe('The encoded query that was sent. Re-run it to check the answer.'),
  total: z.number().nullable().describe('Rows matching on the server, before row-level access rules. null if unknown.'),
  returned: z.number(),
  offset: z.number(),
  truncated: z.boolean().describe('true if more rows match than were returned.'),
  nextOffset: z.number().optional().describe('Pass as offset to read the next page.'),
}

export function source(sn: ServiceNowClient, warnings: string[] = []) {
  return { instance: sn.host, fetchedAt: new Date().toISOString(), warnings }
}

/** Describes a page honestly: how many rows matched, how many came back, and whether some were withheld. */
export function listing(sn: ServiceNowClient, page: Page<unknown>, warnings: string[] = []) {
  const returned = page.records.length
  const end = page.offset + page.limit
  const truncated = page.total !== null ? end < page.total : returned === page.limit

  if (page.total !== null) {
    const expected = Math.min(page.limit, Math.max(page.total - page.offset, 0))
    if (returned < expected) {
      warnings.push(
        `${expected - returned} matching row(s) on this page were not returned. Row-level access rules are applied ` +
          'after the page is cut, so this account cannot see them.',
      )
    }
  }

  return {
    ...source(sn, warnings),
    table: page.table,
    query: page.query,
    total: page.total,
    returned,
    offset: page.offset,
    truncated,
    ...(truncated ? { nextOffset: end } : {}),
  }
}

/**
 * With sysparm_display_value=all every field arrives as {display_value, value}.
 * Keep both where they differ (a sys_id and its name, a choice code and its label),
 * and collapse the rest. Timestamps keep the raw value, which is UTC.
 */
export function tidy(record: Row): Row {
  return Object.fromEntries(
    Object.entries(record).map(([key, field]) => {
      if (!field || typeof field !== 'object' || !('value' in field)) return [key, field]
      const { value, display_value: display } = field as { value?: unknown; display_value?: unknown }
      const isTimestamp = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/.test(value)
      if (display === undefined || display === null || display === '' || display === value || isTimestamp) return [key, value]
      return [key, { value, display }]
    }),
  )
}

/** The raw value of a tidied field. */
export function rawOf(field: unknown): string {
  if (field && typeof field === 'object' && 'value' in field) return String((field as { value: unknown }).value ?? '')
  return field === undefined || field === null ? '' : String(field)
}

/** The readable form of a tidied field. */
export function labelOf(field: unknown): string {
  if (field && typeof field === 'object' && 'display' in field) return String((field as { display: unknown }).display ?? '')
  return rawOf(field)
}

export function tally<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of items) counts[key(item) || 'unknown'] = (counts[key(item) || 'unknown'] ?? 0) + 1
  return counts
}

/** Drops rows from the end until the answer fits. Returns how many were dropped. */
export function clip<T>(records: T[], warnings: string[]): T[] {
  let size = 0
  for (const [index, record] of records.entries()) {
    size += JSON.stringify(record).length
    if (size > MAX_ANSWER_CHARS && index > 0) {
      warnings.push(
        `Only the first ${index} of ${records.length} fetched rows are shown, because the answer would be too large. ` +
          'Ask for fewer fields, or page with a smaller limit.',
      )
      return records.slice(0, index)
    }
  }
  return records
}

export function ok(payload: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload }
}

/**
 * Errors are answers. "This account cannot read that table" is a fact about the
 * instance, and the agent should report it as one instead of guessing around it.
 */
export function fail(error: unknown, table?: string): ToolResult {
  const known = error instanceof ServiceNowError ? error : undefined
  const payload = {
    error: known?.kind ?? 'unknown',
    message: error instanceof Error ? error.message : String(error),
    table: known?.table ?? table,
    hint: hintFor(known?.kind ?? 'unknown', known?.table ?? table),
  }
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

function hintFor(kind: string, table?: string): string {
  switch (kind) {
    case 'validation':
      return 'Nothing was sent to the instance. Correct the input and call again.'
    case 'auth':
      return 'The instance rejected the credentials. Check the SERVICENOW_* variables.'
    case 'acl':
      return `This account may not read "${table}" through the REST API. That says something about access, not about the data: report it as "could not be checked", never as "nothing found".`
    case 'not_found':
      return `Table "${table}" does not exist on this instance. Search sys_db_object with nameLIKE to find the right name.`
    case 'bad_request':
      return 'The instance rejected the request. Check the query syntax.'
    case 'rate_limited':
      return 'The instance is limiting requests. Wait before trying again.'
    case 'timeout':
      return 'The instance did not answer in time. Narrow the query, or try again later.'
    case 'network':
      return 'The instance could not be reached. Check the address and the network.'
    case 'invalid_response':
      return 'The answer was not the expected JSON. A developer instance may be hibernating: open it in a browser to wake it. Otherwise check the instance address.'
    default:
      return 'Unexpected failure. Report the message as it is; do not guess what the data would have been.'
  }
}
