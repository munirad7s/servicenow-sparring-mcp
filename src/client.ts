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
  status: number | ErrorKind
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

  private auth: Auth
  /** Becomes true once the instance has accepted the credentials. Until then requests go one at a time. */
  private accepted = false
  private opening: Promise<void> | null = null
  private paused: { until: number; error: ServiceNowError } | null = null
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
    const { table, query = '', fields, limit = 20, offset = 0, display = false } = opts
    assertTableName(table)
    fieldsInEncodedQuery(query, table)
    fields?.forEach((field) => assertFieldPath(field, table))

    const params = new URLSearchParams()
    if (query) params.set('sysparm_query', query)
    if (fields?.length) params.set('sysparm_fields', fields.join(','))
    params.set('sysparm_limit', String(limit))
    if (offset) params.set('sysparm_offset', String(offset))
    params.set('sysparm_exclude_reference_link', 'true')
    params.set('sysparm_suppress_pagination_header', 'true')
    if (display) params.set('sysparm_display_value', 'all')

    const { body, headers } = await this.get('table', table, query, params)
    if (!Array.isArray(body.result)) {
      throw new ServiceNowError(`${this.host} answered without a result list.`, 'invalid_response', table)
    }

    const header = headers.get('x-total-count')
    const total = header !== null && /^\d+$/.test(header) ? Number(header) : null
    const records = (body.result as unknown[]).filter((row): row is T => row !== null && typeof row === 'object')
    return { table, query, limit, offset, records, total }
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
    assertTableName(table)
    assertFieldPath(groupBy, table)
    fieldsInEncodedQuery(query, table)

    const params = new URLSearchParams({ sysparm_count: 'true', sysparm_group_by: groupBy })
    if (query) params.set('sysparm_query', query)
    if (display) params.set('sysparm_display_value', 'all')

    const { body } = await this.get('stats', table, query, params)
    if (!Array.isArray(body.result)) {
      throw new ServiceNowError(`${this.host} answered without a result list.`, 'invalid_response', table)
    }

    return (body.result as Array<{ stats?: { count?: unknown }; groupby_fields?: Array<{ value?: unknown; display_value?: unknown }> } | null>).map((group) => {
      const count = String(group?.stats?.count ?? '')
      if (!/^\d+$/.test(count)) {
        throw new ServiceNowError(`${this.host} answered with a count that is not a number.`, 'invalid_response', table)
      }
      const field = group?.groupby_fields?.[0]
      const value = String(field?.value ?? '')
      const shown = String(field?.display_value ?? '')
      return { value, count: Number(count), ...(shown && shown !== value ? { display: shown } : {}) }
    })
  }

  private async get(
    api: 'table' | 'stats',
    table: string,
    query: string,
    params: URLSearchParams,
  ): Promise<{ body: { result?: unknown }; headers: Headers }> {
    const started = Date.now()
    const log = (status: number | ErrorKind, rows: number | null, total: number | null) =>
      this.options.audit?.({ time: new Date(started).toISOString(), tool: currentCall()?.tool ?? null, api, table, query, status, rows, total, ms: Date.now() - started })

    try {
      // A table closed on this machine is not asked for, but the attempt is still written to the audit log.
      this.assertAllowed(table)
      const answer = this.accepted
        ? await this.send(api, table, params)
        : await this.alone(() => this.send(api, table, params))
      const header = answer.headers.get('x-total-count')
      log(200, Array.isArray(answer.body.result) ? answer.body.result.length : null, header !== null && /^\d+$/.test(header) ? Number(header) : null)
      return answer
    } catch (error) {
      log(error instanceof ServiceNowError ? (error.status ?? error.kind) : 'unknown', null, null)
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
    attempt = 0,
  ): Promise<{ body: { result?: unknown }; headers: Headers }> {
    if (this.paused) {
      if (Date.now() < this.paused.until) {
        const { error } = this.paused
        throw new ServiceNowError(`${error.message} Not sent again for a moment, because the last request to this instance failed.`, error.kind, table, error.status)
      }
      this.paused = null
    }

    const url = `${this.config.instanceUrl}/api/now/${api}/${table}?${params}`
    this.requestCount++
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
      const fresh = attempt === 0 ? this.config.reloadAuth?.() : undefined
      if (fresh && JSON.stringify(fresh) !== JSON.stringify(this.auth)) {
        this.auth = fresh
        return this.send(api, table, params, attempt + 1)
      }
      const error = new ServiceNowError(`${this.host} rejected the credentials (HTTP 401).`, 'auth', table, 401)
      // Back to one request at a time: an expired token must not be retried by everything in flight.
      this.accepted = false
      this.paused = { until: Date.now() + PAUSE_AFTER_REJECTED_LOGIN_MS, error }
      throw error
    }

    if (response.status === 429 && attempt === 0) {
      const wait = Number(response.headers.get('retry-after'))
      await this.sleep(Number.isFinite(wait) && wait > 0 ? Math.min(wait, 5) * 1000 : 500)
      return this.send(api, table, params, attempt + 1)
    }

    let body: { result?: unknown; error?: { message?: unknown; detail?: unknown } } | undefined
    try {
      body = JSON.parse(text)
    } catch {
      body = undefined
    }
    const isObject = body !== null && typeof body === 'object'

    if (!response.ok || (isObject && body?.error)) {
      // The instance answered, so it is reachable and the login was accepted.
      this.accepted = true
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

  private assertAllowed(table: string): void {
    const { allow, deny } = this.config.tables
    const matches = (pattern: string) => (pattern.endsWith('*') ? table.startsWith(pattern.slice(0, -1)) : table === pattern)

    if (deny.some(matches)) {
      throw new ServiceNowError(`Table "${table}" is blocked on this machine by SERVICENOW_TABLE_DENY. Nothing was sent.`, 'blocked', table)
    }
    if (allow.length && !allow.some(matches)) {
      throw new ServiceNowError(`Table "${table}" is not in SERVICENOW_TABLE_ALLOW on this machine. Nothing was sent.`, 'blocked', table)
    }
  }

  private authorization(): string {
    if (this.auth.kind === 'bearer') return `Bearer ${this.auth.token}`
    return 'Basic ' + Buffer.from(`${this.auth.username}:${this.auth.password}`).toString('base64')
  }
}

function classify(status: number, text: string): ErrorKind {
  if (status === 401) return 'auth'
  if (status === 404 || /invalid table/i.test(text)) return 'not_found'
  if (status === 403 || /\bACL\b|not authorized|insufficient rights|security constraints/i.test(text)) return 'acl'
  if (status === 429) return 'rate_limited'
  if (status === 400) return 'bad_request'
  return 'unknown'
}
