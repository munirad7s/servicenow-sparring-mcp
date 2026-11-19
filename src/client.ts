import type { InstanceConfig } from './config.js'
import { ServiceNowError, type ErrorKind } from './errors.js'
import { assertFieldPath, assertTableName, fieldsInEncodedQuery } from './query.js'

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
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/**
 * ServiceNow REST client that can only read.
 *
 * Every request goes through get(), and get() sends the HTTP method GET to one of
 * two endpoints: the Table API and the Aggregate API. There is no other method in
 * this class and no parameter that changes the HTTP method. What the instance does
 * while answering a read (query business rules, logging) is outside this client's
 * control; see the security model in the README.
 */
export class ServiceNowClient {
  readonly host: string
  requestCount = 0

  constructor(
    private readonly config: InstanceConfig,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
  ) {
    this.host = new URL(config.instanceUrl).host
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

    const { body, headers } = await this.get('table', table, params)
    if (!Array.isArray(body.result)) {
      throw new ServiceNowError(`${this.host} answered without a result list.`, 'invalid_response', table)
    }

    const header = headers.get('x-total-count')
    const total = header !== null && /^\d+$/.test(header) ? Number(header) : null
    return { table, query, limit, offset, records: body.result as T[], total }
  }

  /**
   * Reads every matching row, page by page. Row-level access rules are applied
   * after a page is cut, so a short or empty page does not mean the end: paging
   * runs on the server's total, not on the size of the pages.
   */
  async all<T = Row>(
    opts: Omit<QueryOptions, 'limit' | 'offset'>,
    maxRows = 5_000,
    pageSize = 500,
  ): Promise<{ records: T[]; total: number | null; complete: boolean }> {
    const records: T[] = []
    let offset = 0
    let total: number | null = null

    while (offset < maxRows) {
      const page = await this.query<T>({ ...opts, limit: pageSize, offset })
      total = page.total
      records.push(...page.records)
      offset += pageSize
      if (total === null ? page.records.length < pageSize : offset >= total) return { records, total, complete: true }
    }
    return { records, total, complete: false }
  }

  /** Counts rows per value of one field, through the Aggregate API. */
  async groupCount(table: string, groupBy: string, query = ''): Promise<GroupCount[]> {
    assertTableName(table)
    assertFieldPath(groupBy, table)
    fieldsInEncodedQuery(query, table)

    const params = new URLSearchParams({ sysparm_count: 'true', sysparm_group_by: groupBy })
    if (query) params.set('sysparm_query', query)

    const { body } = await this.get('stats', table, params)
    if (!Array.isArray(body.result)) {
      throw new ServiceNowError(`${this.host} answered without a result list.`, 'invalid_response', table)
    }

    return (body.result as Array<{ stats?: { count?: string }; groupby_fields?: Array<{ value?: string }> }>).map(
      (group) => ({ value: group.groupby_fields?.[0]?.value ?? '', count: Number(group.stats?.count ?? 0) }),
    )
  }

  private async get(
    api: 'table' | 'stats',
    table: string,
    params: URLSearchParams,
  ): Promise<{ body: { result?: unknown }; headers: Headers }> {
    const url = `${this.config.instanceUrl}/api/now/${api}/${table}?${params}`
    this.requestCount++

    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: this.authorization(), Accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(this.config.timeoutMs),
      })
    } catch (cause) {
      const error = cause as Error
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new ServiceNowError(`No answer from ${this.host} within ${this.config.timeoutMs} ms.`, 'timeout', table)
      }
      throw new ServiceNowError(`Cannot reach ${this.host}: ${error?.message ?? String(cause)}`, 'network', table)
    }

    if (response.status >= 300 && response.status < 400) {
      throw new ServiceNowError(
        `${this.host} answered with a redirect (HTTP ${response.status}). Redirects are not followed.`,
        'invalid_response',
        table,
        response.status,
      )
    }

    const text = await response.text()
    if (text.length > this.config.maxResponseBytes) {
      throw new ServiceNowError(
        `The answer is larger than ${this.config.maxResponseBytes} bytes. Ask for fewer fields or rows.`,
        'invalid_response',
        table,
        response.status,
      )
    }

    let body: { result?: unknown; error?: { message?: string; detail?: string } } | undefined
    try {
      body = JSON.parse(text)
    } catch {
      body = undefined
    }

    if (!response.ok || body?.error) {
      const message = body?.error?.message ?? `HTTP ${response.status}`
      const detail = body?.error?.detail ? ` (${body.error.detail})` : ''
      throw new ServiceNowError(`${message}${detail}`, classify(response.status, message), table, response.status)
    }

    if (!body || typeof body !== 'object') {
      const type = response.headers.get('content-type') ?? 'unknown content type'
      throw new ServiceNowError(
        `${this.host} did not answer with JSON (HTTP ${response.status}, ${type}).`,
        'invalid_response',
        table,
        response.status,
      )
    }

    return { body, headers: response.headers }
  }

  private authorization(): string {
    const { auth } = this.config
    if (auth.kind === 'bearer') return `Bearer ${auth.token}`
    return 'Basic ' + Buffer.from(`${auth.username}:${auth.password}`).toString('base64')
  }
}

function classify(status: number, message: string): ErrorKind {
  if (status === 401 || /not authenticated/i.test(message)) return 'auth'
  if (status === 403 || /ACL|not authorized/i.test(message)) return 'acl'
  if (status === 404 || /invalid table/i.test(message)) return 'not_found'
  if (status === 429) return 'rate_limited'
  if (status === 400) return 'bad_request'
  return 'unknown'
}
