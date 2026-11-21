import { z } from 'zod'
import type { Page, Row, ServiceNowClient } from './client.js'
import { ServiceNowError } from './errors.js'
import { scrubSecrets } from './tools/shared.js'
import { currentCall } from './trace.js'

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

/** Rough ceiling for the rows of one answer, so a single call cannot flood the agent's context. */
const MAX_ANSWER_CHARS = 60_000
/** Text values up to this length are never cut. */
const LONG_VALUE_CHARS = 2_000

export const rowSchema = z.record(z.string(), z.unknown())

/** Every answer says where it came from, when, and what it cost. */
export const sourceShape = {
  instance: z.string().describe('Host of the instance that answered.'),
  fetchedAt: z.string().describe('Time of the answer, ISO 8601, UTC.'),
  requests: z.number().describe('GET requests this answer needed.'),
  warnings: z.array(z.string()).describe('Things that limit how far this answer can be trusted. Pass them on.'),
}

/** Answers that list rows also say how complete the list is. */
export const listShape = {
  ...sourceShape,
  table: z.string(),
  query: z.string().describe('The encoded query that was sent. Re-run it to check the answer.'),
  total: z
    .number()
    .nullable()
    .describe('Rows matching on the server, before row-level access rules. Not the number of rows this account can see. null if unknown, or where the call asked not to count.'),
  returned: z.number().describe('Rows in this answer.'),
  offset: z.number(),
  truncated: z
    .boolean()
    .describe('true if rows follow behind this answer: rows were left out to fit it, or more rows match behind this page. Where the answer has no total: rows were left out, or the page is full, so that more can match.'),
  nextOffset: z.number().optional().describe('Pass as offset to read on.'),
}

/** Reading on behind a cut answer begins at or before the first row that was not shown, where the rows keep their order. */
const NONE_SKIPPED = 'It skips none where every row keeps its place from one page to the next.'

export const ROWS_LEFT_OUT =
  'Tables are closed on this machine. What this answer was read from leaves out, by a condition on the class of a record, any row of a class that is closed or whose rows are copies of records of other tables, and any row that reaches such a row through a reference the query walks along, or through a joined table. A total does not count them.'

/**
 * What an answer says where it left out what fields show, for closed tables. One text for the server and for the
 * script that checks it against an instance: reworded in one place only, the script looked for the old words.
 */
export const namesLeftOut = (fields: string[]): string =>
  `Tables are closed on this machine, and what these fields show can come from a record of one, or from a row that is a copy of a record of another table, so it was left out: ${[...fields].sort().join(', ')}.`

export function source(sn: ServiceNowClient, warnings: string[] = []) {
  // What the gate of closed tables did to the requests of this call, whichever tool sent them.
  const closed = currentCall()?.closed
  const add = (text: string) => {
    if (!warnings.includes(text)) warnings.push(text)
  }
  if (closed?.rowsLeftOut) add(ROWS_LEFT_OUT)
  if (closed?.names.size) add(namesLeftOut([...closed.names]))
  if (closed?.copies.size) {
    add(
      `Tables are closed on this machine, and these fields point into a table whose rows are named after records of other tables, so their display values were left out: ${[...closed.copies].sort().join(', ')}. ` +
        'Read the names from that table itself: there each one is judged by the table of its record.',
    )
  }
  if (closed?.untold.size) {
    add(
      `Tables are closed on this machine, and it could not be told which table these fields point to, or what a row of that table shows as its name (read from sys_dictionary and sys_dictionary_override), so their display values were left out: ${[...closed.untold].sort().join(', ')}.`,
    )
  }
  return { instance: sn.host, fetchedAt: new Date().toISOString(), requests: currentCall()?.requests ?? 0, warnings }
}

/**
 * Describes a page honestly: how many rows matched, how many are in the answer,
 * and whether some were withheld. "shown" is the number of rows left after the
 * answer was cut to size; reading on continues right behind them.
 */
export function listing(sn: ServiceNowClient, page: Page<unknown>, warnings: string[] = [], shown = page.records.length) {
  const fetched = page.records.length
  const end = page.offset + page.limit
  const cut = shown < fetched

  let withheld = 0
  if (page.total !== null) {
    const expected = Math.min(page.limit, Math.max(page.total - page.offset, 0))
    withheld = Math.max(expected - fetched, 0)
    if (withheld) {
      warnings.push(
        `${withheld} matching row(s) on this page were not returned. Row-level access rules are applied after the page ` +
          'is cut, so this account cannot see them.',
      )
    }
  }
  if (cut && withheld) {
    warnings.push(`Because rows were withheld and the answer was cut, reading on from nextOffset can repeat a few rows. ${NONE_SKIPPED}`)
  } else if (cut && page.total === null) {
    // Without a total it is not known whether rows of this page were withheld, and the same holds if some were.
    warnings.push(`The answer was cut, and without a total it cannot be told whether rows of this page are hidden from this account. If some are, reading on from nextOffset can repeat a few rows. ${NONE_SKIPPED}`)
  }

  const truncated = cut || (page.total !== null ? end < page.total : fetched === page.limit)
  return {
    ...source(sn, warnings),
    table: page.table,
    query: page.query,
    total: page.total,
    returned: shown,
    offset: page.offset,
    truncated,
    ...(truncated ? { nextOffset: cut ? page.offset + shown : end } : {}),
  }
}

/** A warning for a list that is not paged by the caller: rows the account could not see. */
export function withheldWarning(what: string, page: Page<unknown>, warnings: string[]): void {
  if (page.total === null) return
  const expected = Math.min(page.limit, Math.max(page.total - page.offset, 0))
  if (page.records.length < expected) {
    warnings.push(`${what}: ${expected - page.records.length} matching row(s) were not returned, because row-level access rules hide them from this account.`)
  }
}

/**
 * With sysparm_display_value=all every field arrives as {display_value, value}.
 * Keep both where they differ (a sys_id and its name, a choice code and its label),
 * and collapse the rest. A timestamp keeps the raw value, which is UTC; its display
 * value would be the same moment in the account's time zone.
 */
export function tidy(record: Row): Row {
  const DATE = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/
  // The display value follows the date format of the account: 01.06.2026, 06/01/2026, 2026-06-01, with or without a time.
  const SHOWN_DATE = /^\d{1,4}[./-]\d{1,2}[./-]\d{1,4}( \d{1,2}:\d{2}(:\d{2})?( ?[AP]M)?)?$/i
  return Object.fromEntries(
    Object.entries(record).map(([key, field]) => {
      if (!field || typeof field !== 'object' || !('value' in field)) return [key, field]
      const { value, display_value: display } = field as { value?: unknown; display_value?: unknown }
      const sameMoment = typeof value === 'string' && DATE.test(value) && typeof display === 'string' && SHOWN_DATE.test(display)
      if (display === undefined || display === null || display === '' || display === value || sameMoment) return [key, value]
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
  const counts = new Map<string, number>()
  for (const item of items) {
    const name = key(item) || 'unknown'
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return Object.fromEntries(counts)
}

/** Replaces the value of the named fields. Used for fields that hold secrets. */
export function redact<T extends Row>(record: T, fields: Set<string>, note: string): T {
  if (!fields.size) return record
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, fields.has(key) && value !== '' && value !== null && value !== undefined ? note : value]),
  ) as T
}

/**
 * Keeps an answer within its budget. Long text values are cut first, so that one
 * script or one payload cannot crowd out every other row; only then rows are
 * dropped from the end. Pass the length of the result to listing(), so that
 * reading on continues behind the last row shown.
 */
export function clip<T>(records: T[], warnings: string[]): T[] {
  const sizeOf = (list: unknown[]) => list.reduce<number>((sum, item) => sum + (JSON.stringify(item)?.length ?? 0), 0)
  if (sizeOf(records) <= MAX_ANSWER_CHARS) return records

  const longValues = records.reduce((count, record) => count + countLong(record), 0)
  const cutTo = (cap: number, counted: () => void) => (given: string) => {
    // Read before it is cut: a secret is recognised by where it ends, and the cut takes the end away.
    const text = scrubSecrets(given).text
    if (text.length <= cap) return text
    counted()
    // Not in the middle of a note that stands for something taken out.
    const note = text.lastIndexOf('[withheld', cap)
    const end = note >= 0 ? text.indexOf(']', note) + 1 : 0
    const at = end > cap && end - cap <= 80 ? end : cap
    return `${text.slice(0, at)} … [cut here: ${text.length - at} more characters]`
  }
  let shown = records
  const cap = longValues ? Math.max(LONG_VALUE_CHARS, Math.floor((MAX_ANSWER_CHARS * 0.8) / longValues)) : Infinity
  if (longValues) {
    let cut = 0
    shown = records.map((record) => mapStrings(record, cutTo(cap, () => cut++)))
    if (cut) {
      warnings.push(
        `${cut} long value(s) were cut to about ${cap} characters, because the answer would be too large. To read more of ` +
          'one, ask for that field alone with limit 1. A value longer than one answer can carry cannot be read completely.',
      )
    }
  }
  // One row can be more than an answer carries by itself: a hundred texts that are each short enough. The first
  // row is always shown, so its texts are cut to what fits, each from what it was.
  if (records.length && sizeOf([shown[0]]) > MAX_ANSWER_CHARS) {
    const texts = Math.max(countTexts(records[0]), 1)
    // Not below eighty characters: a note of the server that stands in place of a value is shorter than that,
    // and is not cut in two. A row of many hundred texts stays larger than the budget then, and the warning says so.
    const narrow = Math.min(cap, Math.max(80, Math.floor((MAX_ANSWER_CHARS * 0.8) / texts)))
    let cut = 0
    shown = [mapStrings(records[0], cutTo(narrow, () => cut++)), ...shown.slice(1)]
    const still = sizeOf([shown[0]])
    warnings.push(
      `The first row is larger than one answer carries by itself: ${cut} of its values were cut to about ${narrow} characters. ` +
        (still > MAX_ANSWER_CHARS ? `It is still about ${Math.round(still / 1000)},000 characters long. ` : '') +
        'Ask for fewer fields.',
    )
  }

  let size = 0
  for (const [index, record] of shown.entries()) {
    size += JSON.stringify(record)?.length ?? 0
    if (size > MAX_ANSWER_CHARS && index > 0) {
      warnings.push(
        `Only the first ${index} of ${records.length} fetched rows are shown, because the answer would be too large. ` +
          'Read on with nextOffset, or ask for fewer fields.',
      )
      return shown.slice(0, index)
    }
  }
  return shown
}

function countTexts(value: unknown): number {
  if (typeof value === 'string') return 1
  if (value && typeof value === 'object') return Object.values(value).reduce<number>((count, item) => count + countTexts(item), 0)
  return 0
}

function countLong(value: unknown): number {
  if (typeof value === 'string') return value.length > LONG_VALUE_CHARS ? 1 : 0
  if (value && typeof value === 'object') return Object.values(value).reduce<number>((count, item) => count + countLong(item), 0)
  return 0
}

function mapStrings<T>(value: T, change: (text: string) => string): T {
  if (typeof value === 'string') return change(value) as T
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, change)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, change)])) as T
  }
  return value
}

export function ok(payload: Record<string, unknown>): ToolResult {
  // A rejected login, an instance that could not be reached, or the limit of requests for one call: a look-up
  // that caught such a failure, where it meant to catch "this table is not readable", does not make it an answer.
  const ended = currentCall()?.ended
  if (ended) return fail(ended)
  // Every text of an answer is read once more for what looks like a secret, whichever tool put it there: the
  // name of a record can be such a text as well as a script can. What a tool took out itself reads the same
  // the second time. Not the query: that is what was sent, in the words of the call.
  let taken = 0
  const read = (value: unknown, key?: string): unknown => {
    if (key === 'query') return value
    if (typeof value === 'string') {
      const cleaned = scrubSecrets(value).text
      if (cleaned !== value) taken++
      return cleaned
    }
    if (Array.isArray(value)) return value.map((item) => read(item))
    // A key can be a text of the instance as well: the source of a version, the value a count is made by.
    if (value && typeof value === 'object') {
      // Collected in a map: a key can be called like something every object has.
      const out = new Map<string, unknown>()
      for (const [name, item] of Object.entries(value)) {
        const key = read(name) as string
        const cleaned = read(item, name)
        // Two keys that differ only in what was taken out of them are one key now: counts are added, not lost.
        const before = out.get(key)
        out.set(key, typeof before === 'number' && typeof cleaned === 'number' ? before + cleaned : cleaned)
      }
      return Object.fromEntries(out)
    }
    return value
  }
  const answer = read(payload) as Record<string, unknown>
  if (taken) {
    answer.warnings = [
      ...(Array.isArray(answer.warnings) ? answer.warnings : []),
      `${taken} text(s) of this answer carried what looks like a secret by its name (the content of an XML element or the value of a JSON key): that part is replaced by "[withheld]".`,
    ]
  }
  return { content: [{ type: 'text', text: JSON.stringify(answer) }], structuredContent: answer }
}

/**
 * Errors are answers. "This account cannot read that table" is a fact about the
 * instance, and the agent should report it as one instead of guessing around it.
 */
/**
 * The answer for a call that failed. Given the client, a call that was refused because of a closed table is
 * written to the audit log, also where it was refused before any request: "asked" is what the agent passed in.
 */
export function fail(error: unknown, table?: string, sn?: ServiceNowClient, asked?: { query?: string; fields?: string[] }): ToolResult {
  sn?.auditRefusal(error, table, asked)
  const known = error instanceof ServiceNowError ? error : undefined
  const kind = known?.kind ?? 'unknown'
  const about = known?.table ?? (kind === 'validation' || kind === 'config' ? undefined : table)
  // The words of an instance are part of a message, and an instance can quote anything: read like any other text.
  const message = scrubSecrets(error instanceof Error ? error.message : String(error)).text
  const payload = {
    error: kind,
    message: message.length > 1_000 ? `${message.slice(0, 1_000)}…` : message,
    ...(about ? { table: about } : {}),
    hint: hintFor(kind, about, message),
  }
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

function hintFor(kind: string, about: string | undefined, message: string): string {
  // An error can come without the table it is about: then the hint names none.
  const named = about ? `"${about}"` : 'the table that was asked for'
  switch (kind) {
    case 'validation':
      return 'What was asked for was not sent to the instance. Correct the input and call again.'
    case 'config':
      return 'The server is not configured correctly. This is for the person who set it up, not something to work around.'
    case 'blocked':
      return `Tables are closed on this machine (SERVICENOW_TABLE_ALLOW, SERVICENOW_TABLE_DENY). This request asks about one of them, would have read from one, or could not be shown to stay clear of them: the message says which, and why. Report it as "could not be checked": it says nothing about the data.`
    case 'auth':
      return 'The instance rejected the credentials. Check the SERVICENOW_* variables. With a token: it may have expired.'
    case 'acl':
      // Measured: the Aggregate API refuses to count by some fields that a condition may name, with these words.
      if (/field\(s\) present in the query/i.test(message)) {
        return `The instance refused this request because of a field in it: an access rule does not let this account filter, sort or count by that field. ${named[0].toUpperCase()}${named.slice(1)} itself may be readable, so ask again without that field. Report this as "could not be checked", never as "nothing found".`
      }
      return `This account may not read ${named} through the REST API. That says something about access, not about the data: report it as "could not be checked", never as "nothing found".`
    case 'not_found':
      return `${about ? `Table "${about}"` : 'That table'} does not exist on this instance. Search sys_db_object with nameLIKE to find the right name.`
    case 'bad_request':
      return 'The instance rejected the request. Check the query syntax.'
    case 'rate_limited':
      return 'The instance is limiting requests. Wait before trying again.'
    case 'timeout':
      return 'The instance did not answer in time, or ended the request because it ran too long. Narrow the query, or try again later.'
    case 'network':
      return 'The instance could not be reached. Check the address and the network. A certificate error points to a company proxy: see "Proxies and certificates" in the README.'
    case 'redirect':
      return 'The instance sent a redirect instead of data. That usually means single sign-on is enforced and this login is not accepted for the REST API, or the address is wrong.'
    case 'too_large':
      return 'Ask for fewer fields, or use a smaller limit.'
    case 'invalid_response':
      // A refusal with a page in place of the JSON an instance refuses with.
      if (/without the JSON of an instance/.test(message)) {
        return 'What answered stands in front of the instance: a proxy, a firewall, or a rule about which addresses may connect. That says nothing about the data and nothing about what this account may read: report it as "could not be checked".'
      }
      return 'The answer was not the expected JSON. A developer instance may be hibernating: open it in a browser to wake it. Otherwise check the instance address.'
    default:
      return 'Unexpected failure. Report the message as it is; do not guess what the data would have been.'
  }
}
