import type { Auth, InstanceConfig } from './config.js'
import { quoteInstanceText, ServiceNowError, type ErrorKind } from './errors.js'
import { assertFieldPath, assertTableName, fieldsInEncodedQuery } from './query.js'
import { currentCall } from './trace.js'
import { NAME, VERSION } from './version.js'

export type Row = Record<string, unknown>

export interface QueryOptions {
  table: string
  query?: string
  fields?: string[]
  limit?: number
  offset?: number
  /** true returns every field as {display_value, value}. */
  display?: boolean
  /** For the lookups the gate of closed tables is built from: sent without passing through it. */
  trusted?: boolean
}

/**
 * What stands between a request and the instance while tables are closed on this machine. The server sets it once.
 * Every request passes through it, whichever tool sends it, so that no tool has to remember the rules.
 */
export interface Gate {
  /**
   * Refuses a request that would read from a closed table: the table itself, a table one of its paths walks into,
   * a table a database view joins. Returns the query to send, in which the rows of closed child tables are left out.
   */
  enter(table: string, query: string, paths: string[]): Promise<string>
  /**
   * Whether the display value of a field can be the name of a record in a closed table: "closed" if it points
   * into one, "untold" if it cannot be told where it points.
   */
  hidesNames(table: string, path: string): Promise<'closed' | 'untold' | null>
}

export interface Page<T = Row> {
  table: string
  query: string
  limit: number
  offset: number
  records: T[]
  /** Rows matching the query on the server, before row-level access rules. null if the instance did not say. */
  total: number | null
}

export interface GroupCount {
  value: string
  count: number
  /** The readable form of the value, when it was asked for and differs. */
  display?: string
}

/** One request, as written to the audit log. It never holds credentials or record content. */
export interface AuditEntry {
  time: string
  tool: string | null
  api: 'table' | 'stats'
  table: string
  query: string
  /** The fields that were asked for. null means all fields of the table. For a count: the field it is grouped by. */
  fields: string[] | null
  /** HTTP status of the answer, or the kind of failure. */
  status: number | ErrorKind
  /** HTTP requests this took: 0 if nothing was sent, 2 after a retry. */
  sent: number
  rows: number | null
  total: number | null
  ms: number
}

export interface ClientOptions {
  audit?: (entry: AuditEntry) => void
  sleep?: (ms: number) => Promise<void>
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

const PAUSE_AFTER_REJECTED_LOGIN_MS = 60_000
const PAUSE_WHILE_UNREACHABLE_MS = 15_000

/**
 * ServiceNow REST client that can only read.
 *
 * Every request goes through send(), and send() uses the HTTP method GET against
 * one of two endpoints: the Table API and the Aggregate API. There is no other
 * method in this class and no parameter that changes the HTTP method. What the
 * instance does while answering a read (query business rules, logging) is outside
 * this client's control; see the security model in the README.
 */
export class ServiceNowClient {
  readonly host: string
  requestCount = 0

  /** Set by the server. Asked for every request while tables are closed on this machine. */
  gate: Gate | null = null

  private auth: Auth
  /** Becomes true once the instance has accepted the credentials. Until then requests go one at a time. */
  private accepted = false
  private opening: Promise<void> | null = null
  private paused: { until: number; error: ServiceNowError; rejected?: Auth } | null = null
  private readonly sleep: (ms: number) => Promise<void>

  constructor(
    private readonly config: InstanceConfig,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly options: ClientOptions = {},
  ) {
    this.host = new URL(config.instanceUrl).host
    this.auth = config.auth
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /** The user name the server logs in with, if it knows it. A token does not say whose it is. */
  get username(): string | null {
    return this.auth.kind === 'basic' ? this.auth.username : null
  }

  async query<T = Row>(opts: QueryOptions): Promise<Page<T>> {
    const { table, fields, limit = 20, offset = 0, display = false } = opts
    assertTableName(table)
    const named = fieldsInEncodedQuery(opts.query ?? '', table)
    fields?.forEach((field) => assertFieldPath(field, table))
    const gate = this.restricted && !opts.trusted ? this.gate : null
    const query = gate ? await gate.enter(table, opts.query ?? '', [...named, ...(fields ?? [])]) : (opts.query ?? '')

    const params = new URLSearchParams()
    if (query) params.set('sysparm_query', query)
    if (fields?.length) params.set('sysparm_fields', fields.join(','))
    params.set('sysparm_limit', String(limit))
    if (offset) params.set('sysparm_offset', String(offset))
    params.set('sysparm_exclude_reference_link', 'true')
    params.set('sysparm_suppress_pagination_header', 'true')
    if (display) params.set('sysparm_display_value', 'all')

    const { body, headers } = await this.get('table', table, query, fields?.length ? fields : null, params)
    if (!Array.isArray(body.result)) {
      throw new ServiceNowError(`${this.host} answered without a result list.`, 'invalid_response', table)
    }

    const header = headers.get('x-total-count')
    const total = header !== null && /^\d+$/.test(header) ? Number(header) : null
    const records = (body.result as unknown[]).filter((row): row is T => row !== null && typeof row === 'object')
    if (gate && display) await this.withoutClosedNames(gate, table, records as Row[])
    return { table, query, limit, offset, records, total }
  }

  /** Takes the display value off every field whose name could be that of a record in a closed table. */
  private async withoutClosedNames(gate: Gate, table: string, records: Row[]): Promise<void> {
    const verdicts = new Map<string, 'closed' | 'untold' | null>()
    const notes = currentCall()?.closed
    for (const row of records) {
      for (const [key, value] of Object.entries(row)) {
        if (!value || typeof value !== 'object' || !('display_value' in value)) continue
        const { value: raw, display_value: shown } = value as { value?: unknown; display_value?: unknown }
        // A display value that only repeats what is stored names nothing.
        if (shown === raw || shown === '' || shown === null || shown === undefined) continue
        if (!verdicts.has(key)) verdicts.set(key, await gate.hidesNames(table, key))
        const verdict = verdicts.get(key)
        if (!verdict) continue
        ;(verdict === 'closed' ? notes?.names : notes?.untold)?.add(key)
        row[key] = raw
      }
    }
  }

  /**
   * Reads every matching row, page by page. Row-level access rules are applied
   * after a page is cut, so a short or empty page does not mean the end: paging
   * runs on the server's total, not on the size of the pages.
   *
   * "complete" is true only if the server named a total and every page up to it
   * was read. The caller compares records.length with total to see whether rows
   * were withheld.
   */
  async all<T = Row>(
    opts: Omit<QueryOptions, 'limit' | 'offset'>,
    maxRows = 5_000,
    pageSize = 500,
  ): Promise<{ records: T[]; total: number | null; complete: boolean }> {
    const records: T[] = []
    let total: number | null = null

    for (let offset = 0; offset < maxRows; offset += pageSize) {
      const limit = Math.min(pageSize, maxRows - offset)
      const page = await this.query<T>({ ...opts, limit, offset })
      total = page.total
      for (const record of page.records) {
        if (records.length < maxRows) records.push(record)
      }
      if (total === null) {
        // Without a total there is no way to tell the last page from one that access rules emptied.
        if (page.records.length === 0) return { records, total, complete: false }
      } else if (offset + limit >= total) {
        return { records, total, complete: true }
      }
    }
    return { records, total, complete: false }
  }

  /** Counts rows per value of one field, through the Aggregate API. */
  async groupCount(table: string, groupBy: string, query = '', display = false): Promise<GroupCount[]> {
    return (await this.groupCountSent(table, groupBy, query, display)).groups
  }

  /** The same, together with the query that was sent: it differs from the one given where rows of closed tables were left out. */
  async groupCountSent(table: string, groupBy: string, given = '', labels = false): Promise<{ groups: GroupCount[]; query: string }> {
    assertTableName(table)
    assertFieldPath(groupBy, table)
    const named = fieldsInEncodedQuery(given, table)
    const gate = this.restricted ? this.gate : null
    const query = gate ? await gate.enter(table, given, [...named, groupBy]) : given
    // The label of a group is the name behind a reference: not asked for where that could be a record of a closed table.
    const hidden = gate && labels ? await gate.hidesNames(table, groupBy) : null
    const display = labels && !hidden
    if (hidden) (hidden === 'closed' ? currentCall()?.closed.names : currentCall()?.closed.untold)?.add(groupBy)

    const params = new URLSearchParams({ sysparm_count: 'true', sysparm_group_by: groupBy })
    if (query) params.set('sysparm_query', query)
    if (display) params.set('sysparm_display_value', 'all')

    const { body } = await this.get('stats', table, query, [groupBy], params)
    if (!Array.isArray(body.result)) {
      throw new ServiceNowError(`${this.host} answered without a result list.`, 'invalid_response', table)
    }

    const groups = (body.result as Array<{ stats?: { count?: unknown }; groupby_fields?: Array<{ value?: unknown; display_value?: unknown }> } | null>).map((group) => {
      const count = String(group?.stats?.count ?? '')
      if (!/^\d+$/.test(count)) {
        throw new ServiceNowError(`${this.host} answered with a count that is not a number.`, 'invalid_response', table)
      }
      const field = group?.groupby_fields?.[0]
      const value = String(field?.value ?? '')
      const shown = String(field?.display_value ?? '')
      return { value, count: Number(count), ...(shown && shown !== value ? { display: shown } : {}) }
    })
    return { groups, query }
  }

  private async get(
    api: 'table' | 'stats',
    table: string,
    query: string,
    fields: string[] | null,
    params: URLSearchParams,
  ): Promise<{ body: { result?: unknown }; headers: Headers }> {
    const started = Date.now()
    const count = { sent: 0 }
    const log = (status: number | ErrorKind, rows: number | null, total: number | null) =>
      this.options.audit?.({ time: new Date(started).toISOString(), tool: currentCall()?.tool ?? null, api, table, query, fields, status, sent: count.sent, rows, total, ms: Date.now() - started })

    try {
      // A table closed on this machine is not asked for, but the attempt is still written to the audit log.
      this.assertAllowed(table)
      const answer = this.accepted
        ? await this.send(api, table, params, count)
        : await this.alone(() => this.send(api, table, params, count))
      if (!Array.isArray(answer.body.result)) {
        throw new ServiceNowError(`${this.host} answered without a result list.`, 'invalid_response', table)
      }
      const header = answer.headers.get('x-total-count')
      log(200, answer.body.result.length, header !== null && /^\d+$/.test(header) ? Number(header) : null)
      return answer
    } catch (error) {
      // A request that was not sent has no HTTP status of its own.
      log(error instanceof ServiceNowError ? ((count.sent ? error.status : undefined) ?? error.kind) : 'unknown', null, null)
      throw error
    }
  }

  /**
   * Until the instance has accepted the credentials once, requests go one at a
   * time. A wrong password then costs one rejected login, not one per request in
   * flight, and cannot lock the account.
   */
  private async alone<T>(run: () => Promise<T>): Promise<T> {
    while (this.opening) await this.opening
    if (this.accepted) return run()

    let release!: () => void
    this.opening = new Promise<void>((resolve) => (release = resolve))
    try {
      return await run()
    } finally {
      this.opening = null
      release()
    }
  }

  private async send(
    api: 'table' | 'stats',
    table: string,
    params: URLSearchParams,
    count: { sent: number },
    attempt = 0,
  ): Promise<{ body: { result?: unknown }; headers: Headers }> {
    if (this.paused?.rejected) {
      // A pause after a rejected login holds for the credentials that were rejected. Others end it at once:
      // a renewed token in the env file, or one a request in flight picked up in the meantime.
      const renewed = this.config.reloadAuth?.()
      if (renewed && !sameAuth(renewed, this.paused.rejected)) this.auth = renewed
      if (!sameAuth(this.auth, this.paused.rejected)) this.paused = null
    }
    if (this.paused) {
      if (Date.now() < this.paused.until) {
        const { error } = this.paused
        throw new ServiceNowError(`${error.message} Not sent again for a moment, because the last request to this instance failed.`, error.kind, table, error.status)
      }
      this.paused = null
    }

    const url = `${this.config.instanceUrl}/api/now/${api}/${table}?${params}`
    const sent = this.auth
    this.requestCount++
    count.sent++
    const call = currentCall()
    if (call) call.requests++

    let response: Response
    let text: string
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: this.authorization(), Accept: 'application/json', 'User-Agent': `${NAME}/${VERSION}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(this.config.timeoutMs),
      })

      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined)
        throw new ServiceNowError(
          `${this.host} answered with a redirect (HTTP ${response.status}). Redirects are not followed.`,
          'redirect',
          table,
          response.status,
        )
      }
      text = await this.readBody(response, table)
    } catch (cause) {
      throw this.pauseIfClosed(cause instanceof ServiceNowError ? cause : this.transportError(cause, table))
    }

    if (response.status === 401) {
      // Try again once with other credentials: those another request picked up in the meantime, or those now in the env file.
      const fresh = attempt === 0 ? this.config.reloadAuth?.() : undefined
      if (fresh && !sameAuth(fresh, sent)) this.auth = fresh
      if (attempt === 0 && !sameAuth(this.auth, sent)) return this.send(api, table, params, count, attempt + 1)

      const error = new ServiceNowError(`${this.host} rejected the credentials (HTTP 401).`, 'auth', table, 401)
      // Back to one request at a time: an expired token must not be retried by everything in flight.
      this.accepted = false
      this.paused = { until: Date.now() + PAUSE_AFTER_REJECTED_LOGIN_MS, error, rejected: sent }
      throw error
    }

    if (response.status === 429 && attempt === 0) {
      const wait = Number(response.headers.get('retry-after'))
      await this.sleep(Number.isFinite(wait) && wait > 0 ? Math.min(wait, 5) * 1000 : 500)
      return this.send(api, table, params, count, attempt + 1)
    }

    let body: { result?: unknown; error?: { message?: unknown; detail?: unknown } } | undefined
    try {
      body = JSON.parse(text)
    } catch {
      body = undefined
    }
    const isObject = body !== null && typeof body === 'object'

    if (!response.ok || (isObject && body?.error)) {
      // A refusal by the instance itself means it is reachable and took the login. A 5xx or 429 can come from in front of it.
      if (response.status < 500 && response.status !== 429) this.accepted = true
      const message = quoteInstanceText(isObject ? body?.error?.message : '')
      const detail = quoteInstanceText(isObject ? body?.error?.detail : '')
      const said = message ? `: "${message}"${detail ? ` ("${detail}")` : ''}` : ''
      throw new ServiceNowError(
        `${this.host} answered HTTP ${response.status}${said}.`,
        classify(response.status, `${message} ${detail}`),
        table,
        response.status,
      )
    }

    if (!isObject || !body) {
      const type = quoteInstanceText(response.headers.get('content-type') ?? 'unknown content type', 80)
      throw this.pauseIfClosed(
        new ServiceNowError(`${this.host} did not answer with JSON (HTTP ${response.status}, ${type}).`, 'invalid_response', table, response.status),
      )
    }

    this.accepted = true
    return { body, headers: response.headers }
  }

  /** Reads the body, and stops as soon as it is larger than allowed. */
  private async readBody(response: Response, table: string): Promise<string> {
    const limit = this.config.maxResponseBytes
    const tooLarge = () =>
      new ServiceNowError(`The answer is larger than ${limit} bytes. Ask for fewer fields or fewer rows.`, 'too_large', table, response.status)

    if (Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel().catch(() => undefined)
      throw tooLarge()
    }
    if (!response.body) return ''

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel().catch(() => undefined)
        throw tooLarge()
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  /**
   * Turns a failed fetch into an error that names the cause without repeating the
   * raw message, which can contain the Authorization header.
   */
  private transportError(cause: unknown, table: string): ServiceNowError {
    const error = cause as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | undefined
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      return new ServiceNowError(`No answer from ${this.host} within ${this.config.timeoutMs} ms.`, 'timeout', table)
    }
    const code = [error?.cause?.code, error?.code, error?.name].find((value) => typeof value === 'string' && /^[A-Za-z0-9_]{1,60}$/.test(value))
    return new ServiceNowError(`Cannot reach ${this.host} (${code ?? 'request failed'}).`, 'network', table)
  }

  /** While no request has ever succeeded, a failure to connect stops the queue behind it for a short time. */
  private pauseIfClosed(error: ServiceNowError): ServiceNowError {
    if (!this.accepted && ['network', 'timeout', 'redirect', 'invalid_response'].includes(error.kind)) {
      this.paused = { until: Date.now() + PAUSE_WHILE_UNREACHABLE_MS, error }
    }
    return error
  }

  /** true if SERVICENOW_TABLE_ALLOW or SERVICENOW_TABLE_DENY closes any table on this machine. */
  get restricted(): boolean {
    return this.config.tables.allow.length > 0 || this.config.tables.deny.length > 0
  }

  /** Whether this machine may ask for a table. Also used for tables a query reaches without naming them in the URL. */
  allows(table: string): boolean {
    const { allow, deny } = this.config.tables
    const matches = (pattern: string) => (pattern.endsWith('*') ? table.startsWith(pattern.slice(0, -1)) : table === pattern)
    return !deny.some(matches) && (!allow.length || allow.some(matches))
  }

  /** The deny list of this machine: the plain table names on it, and the prefixes of its patterns ("sys_user_*"). */
  get denied(): { names: string[]; prefixes: string[] } {
    const { deny } = this.config.tables
    return {
      names: deny.filter((pattern) => !pattern.endsWith('*')),
      prefixes: deny.filter((pattern) => pattern.endsWith('*')).map((pattern) => pattern.slice(0, -1)),
    }
  }

  /**
   * A query on a parent table answers with the rows of its child tables too: "task" holds every incident. With a
   * list of the only tables that may be read, this condition on sys_class_name keeps the rows of every other class
   * out. Rows without a class stay in: measured, "IN" alone would drop them. null without such a list. "field" is
   * the class field as the query has to name it: behind a dot-walk or under the prefix of a database view.
   */
  openClasses(field = 'sys_class_name'): string | null {
    const { allow } = this.config.tables
    if (!allow.length) return null
    const names = allow.filter((pattern) => !pattern.endsWith('*'))
    const prefixes = allow.filter((pattern) => pattern.endsWith('*')).map((pattern) => pattern.slice(0, -1))
    const open = [names.length ? `${field}IN${names.join(',')}` : '', ...prefixes.map((prefix) => (prefix ? `${field}STARTSWITH${prefix}` : `${field}ISNOTEMPTY`))].filter(Boolean)
    return `${open.join('^OR')}^OR${field}ISEMPTY`
  }

  private assertAllowed(table: string): void {
    if (!this.allows(table)) {
      throw new ServiceNowError(`Table "${table}" is closed on this machine (SERVICENOW_TABLE_ALLOW, SERVICENOW_TABLE_DENY). Nothing was sent.`, 'blocked', table)
    }
  }

  private authorization(): string {
    if (this.auth.kind === 'bearer') return `Bearer ${this.auth.token}`
    return 'Basic ' + Buffer.from(`${this.auth.username}:${this.auth.password}`).toString('base64')
  }
}

function sameAuth(a: Auth, b: Auth): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function classify(status: number, text: string): ErrorKind {
  if (status === 401) return 'auth'
  if (status === 404 || /invalid table/i.test(text)) return 'not_found'
  if (status === 403 || /\bACL\b|not authorized|insufficient rights|security constraints/i.test(text)) return 'acl'
  if (status === 429) return 'rate_limited'
  if (status === 400) return 'bad_request'
  return 'unknown'
}
