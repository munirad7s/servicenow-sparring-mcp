import type { Auth, InstanceConfig } from './config.js'
import { endsTheCall, quoteInstanceText, ServiceNowError, unusableAnswer, validation, type ErrorKind } from './errors.js'
import { assertFieldPath, assertTableName, fieldsInEncodedQuery, withAnOrder, withStableOrder } from './query.js'
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
  /**
   * The fields that tell two rows apart, added as the last sort keys of a sorted query. The sys_id for a table,
   * which is the default; for a database view the sys_ids of the tables it joins. Empty adds nothing.
   */
  stableBy?: string[]
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
   * into one, "copies" if it points into an open table whose rows are named after records of other tables,
   * "untold" if it cannot be told where it points. "shown" asks about the display value as it is
   * passed on, where a field of a kind that is not known to show nothing of other records counts as "untold".
   * Without it the question is whether a comparison with text, or a sort, works on such names.
   */
  hidesNames(table: string, path: string, shown?: boolean): Promise<'closed' | 'copies' | 'untold' | null>
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
/** Requests with the instance at a time. */
const MAX_IN_FLIGHT = 8
/**
 * As many requests as one tool call may send. Measured on a fresh server: the largest call, sn_instance, sends 50,
 * and 169 with a long list of the only tables that may be read, where each of its sources is judged first. A call
 * that needs more than this was built to need them: hundreds of conditions that each have to be looked up, or a
 * page whose every row names tables that do not exist.
 */
const MAX_REQUESTS_PER_CALL = 500
/**
 * As long as the path and the parameters of a request may be. Measured: an instance took an address of 8,218
 * characters and answered HTTP 414 to one of 8,223. A caret or a comma takes three of them.
 */
const MAX_REQUEST_LENGTH = 8_000
/** A cell of a row is a text, or a value with its display value. Anything nested deeper is no row of a table. */
const MAX_CELL_DEPTH = 4
const nestedTooDeep = (value: unknown, left: number): boolean => value !== null && typeof value === 'object' && (left === 0 || Object.values(value).some((inner) => nestedTooDeep(inner, left - 1)))
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
  private inFlight = 0
  private readonly waiting: Array<() => void> = []
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
    const query = gate ? await this.entered(gate, 'table', table, opts.query ?? '', [...named, ...(fields ?? [])], fields?.length ? fields : null) : (opts.query ?? '')

    // What is sent sorts by the sys_id last, so that rows which are equal in what was asked for keep their place
    // from one page to the next. The page names the query as it was sent.
    const sent = withStableOrder(query, opts.stableBy)

    const params = new URLSearchParams()
    if (sent) params.set('sysparm_query', sent)
    if (fields?.length) params.set('sysparm_fields', fields.join(','))
    params.set('sysparm_limit', String(limit))
    if (offset) params.set('sysparm_offset', String(offset))
    params.set('sysparm_exclude_reference_link', 'true')
    params.set('sysparm_suppress_pagination_header', 'true')
    if (display) params.set('sysparm_display_value', 'all')

    const { body, headers } = await this.get('table', table, sent, fields?.length ? fields : null, params)

    const header = headers.get('x-total-count')
    const total = header !== null && /^\d+$/.test(header) ? Number(header) : null
    const records = (body.result as unknown[]).filter((row): row is T => row !== null && typeof row === 'object')
    // What reads the rows afterwards goes as deep as they go. A row nested thousands of levels would end the call
    // with an error of the runtime, and not with a sentence about the answer.
    if (records.some((row) => nestedTooDeep(row, MAX_CELL_DEPTH))) {
      throw unusableAnswer(`${this.host} answered with rows that are nested deeper than a row of a table is.`, table)
    }
    if (gate && display) await this.withoutClosedNames(gate, table, records as Row[])
    return { table, query: sent, limit, offset, records, total }
  }

  /**
   * Asks the rules for closed tables. A request they refuse is not sent, but the attempt is still written to the
   * audit log, like one that names a closed table outright.
   */
  private async entered(gate: Gate, api: 'table' | 'stats', table: string, given: string, paths: string[], fields: string[] | null): Promise<string> {
    const started = Date.now()
    try {
      return await gate.enter(table, given, paths)
    } catch (error) {
      const status = error instanceof ServiceNowError ? error.kind : 'unknown'
      this.options.audit?.({ time: new Date(started).toISOString(), tool: currentCall()?.tool ?? null, api, table, query: given, fields, status, sent: 0, rows: null, total: null, ms: Date.now() - started })
      if (error instanceof Error) this.written.add(error)
      throw error
    }
  }

  /** Failures that already have their line in the audit log. */
  private readonly written = new WeakSet<Error>()

  /**
   * Writes a line to the audit log for a tool call that was refused because of a closed table before any request
   * was made for it: the table asked for was closed, or the name of a record said so. A person who reads the log
   * wants to see what was tried, not only what was sent. A refusal that already has its line gets no second one.
   */
  auditRefusal(error: unknown, table: string | undefined, asked: { query?: string; fields?: string[] } = {}): void {
    if (!(error instanceof ServiceNowError) || error.kind !== 'blocked' || this.written.has(error)) return
    this.written.add(error)
    const now = new Date().toISOString()
    this.options.audit?.({ time: now, tool: currentCall()?.tool ?? null, api: 'table', table: table ?? error.table ?? '', query: asked.query ?? '', fields: asked.fields?.length ? asked.fields : null, status: 'blocked', sent: 0, rows: null, total: null, ms: 0 })
  }

  /** Takes the display value off every field whose name could be that of a record in a closed table. */
  private async withoutClosedNames(gate: Gate, table: string, records: Row[]): Promise<void> {
    const verdicts = new Map<string, 'closed' | 'copies' | 'untold' | null>()
    const notes = currentCall()?.closed
    for (const row of records) {
      for (const [key, value] of Object.entries(row)) {
        if (!value || typeof value !== 'object' || !('display_value' in value)) continue
        const { value: raw, display_value: shown } = value as { value?: unknown; display_value?: unknown }
        // A display value that only repeats what is stored names nothing.
        if (shown === raw || shown === '' || shown === null || shown === undefined) continue
        if (!verdicts.has(key)) verdicts.set(key, await gate.hidesNames(table, key, true))
        const verdict = verdicts.get(key)
        if (!verdict) continue
        ;(verdict === 'closed' ? notes?.names : verdict === 'copies' ? notes?.copies : notes?.untold)?.add(key)
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
    // Every page in one order, so that no row changes its place between two of them.
    const query = withAnOrder(opts.query ?? '')

    for (let offset = 0; offset < maxRows; offset += pageSize) {
      const limit = Math.min(pageSize, maxRows - offset)
      const page = await this.query<T>({ ...opts, query, limit, offset })
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
    const query = gate ? await this.entered(gate, 'stats', table, given, [...named, groupBy], [groupBy]) : given
    // The label of a group is the name behind a reference: not asked for where that could be a record of a closed table.
    const hidden = gate && labels ? await gate.hidesNames(table, groupBy, true) : null
    const display = labels && !hidden
    if (hidden) (hidden === 'closed' ? currentCall()?.closed.names : hidden === 'copies' ? currentCall()?.closed.copies : currentCall()?.closed.untold)?.add(groupBy)

    const params = new URLSearchParams({ sysparm_count: 'true', sysparm_group_by: groupBy })
    if (query) params.set('sysparm_query', query)
    if (display) params.set('sysparm_display_value', 'all')

    const { body } = await this.get('stats', table, query, [groupBy], params)

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
    // Measured: counted per class, a table without rows can answer with one group of no rows and an empty value
    // (2 of 51 such tables, 15 views), where others answer with an empty list. A group of no rows is none.
    return { groups: groups.filter((group) => group.count > 0), query }
  }

  private async get(
    api: 'table' | 'stats',
    table: string,
    query: string,
    fields: string[] | null,
    params: URLSearchParams,
  ): Promise<{ body: { result: unknown[] }; headers: Headers }> {
    const started = Date.now()
    const count = { sent: 0 }
    const log = (status: number | ErrorKind, rows: number | null, total: number | null) =>
      this.options.audit?.({ time: new Date(started).toISOString(), tool: currentCall()?.tool ?? null, api, table, query, fields, status, sent: count.sent, rows, total, ms: Date.now() - started })

    try {
      // A table closed on this machine is not asked for, but the attempt is still written to the audit log.
      this.assertAllowed(table)
      const answer = await this.inTurn(() => (this.accepted ? this.send(api, table, params, count) : this.alone(() => this.send(api, table, params, count))))
      const header = answer.headers.get('x-total-count')
      log(200, answer.body.result.length, header !== null && /^\d+$/.test(header) ? Number(header) : null)
      return answer
    } catch (error) {
      // A request that was not sent has no HTTP status of its own. And a status that says "fine" is not written for
      // a request that failed: an answer too large to read, an error inside it, or no answer of an instance at all.
      const status = error instanceof ServiceNowError && count.sent ? error.status : undefined
      log(error instanceof ServiceNowError ? (status !== undefined && (status < 200 || status > 299) ? status : error.kind) : 'unknown', null, null)
      if (error instanceof Error) this.written.add(error)
      throw error
    }
  }

  /**
   * No more than a few requests are with the instance at a time, whichever function sends them and however many
   * rows it looks something up for. An instance gives an account only so many requests at once, and a burst beyond
   * that is answered with "too many requests". A request that has to wait takes the place of the one that ends.
   */
  private async inTurn<T>(run: () => Promise<T>): Promise<T> {
    if (this.inFlight < MAX_IN_FLIGHT) this.inFlight++
    else await new Promise<void>((resolve) => this.waiting.push(resolve))
    try {
      return await run()
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.inFlight--
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
    // Each kind of second try is made once, and one does not use up the other: a token can expire while a request
    // waits for the rate limit.
    tried: { login?: boolean; rate?: boolean } = {},
  ): Promise<{ body: { result: unknown[] }; headers: Headers }> {
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
        const held = new ServiceNowError(`${error.message} Not sent again for a moment, because the last request to this instance failed.`, error.kind, table, error.status)
        const now = currentCall()
        // Held, the request says nothing about what was asked: also where the failure before it was one request
        // that ran out of time, which ends no call of its own.
        if (now) now.ended ??= held
        throw held
      }
      this.paused = null
    }

    const path = `/api/now/${api}/${table}?${params}`
    if (path.length > MAX_REQUEST_LENGTH) {
      throw validation(
        `This request would be ${path.length} characters long, and an instance takes about ${MAX_REQUEST_LENGTH}: measured, a longer one is answered with HTTP 414. ` +
          'A caret, a comma and an equals sign each take three characters. Shorten the query, or name fewer fields. Nothing was sent.',
        table,
      )
    }
    const call = currentCall()
    if (call && call.requests >= MAX_REQUESTS_PER_CALL) {
      call.ended ??= endsTheCall(
        `This call was stopped after ${MAX_REQUESTS_PER_CALL} requests to the instance. A call needs that many only where it names hundreds of things that each have to be looked up. ` +
          'Ask for less at a time: fewer conditions, fewer fields, fewer rows.',
        table,
      )
      throw call.ended
    }
    const url = `${this.config.instanceUrl}${path}`
    const sent = this.auth
    this.requestCount++
    count.sent++
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
      const error = this.pauseIfClosed(cause instanceof ServiceNowError ? cause : this.transportError(cause, table))
      // An instance that cannot be reached, or that answers with a redirect, ends the call. One request that ran
      // out of time, or one answer that was too large, is about that request.
      if (call && (error.kind === 'network' || error.kind === 'redirect')) call.ended ??= error
      throw error
    }

    if (response.status === 401) {
      // Try again once with other credentials: those another request picked up in the meantime, or those now in the env file.
      const fresh = tried.login ? undefined : this.config.reloadAuth?.()
      if (fresh && !sameAuth(fresh, sent)) this.auth = fresh
      if (!tried.login && !sameAuth(this.auth, sent)) return this.send(api, table, params, count, { ...tried, login: true })

      const error = new ServiceNowError(`${this.host} rejected the credentials (HTTP 401).`, 'auth', table, 401)
      // Back to one request at a time: an expired token must not be retried by everything in flight.
      this.accepted = false
      this.paused = { until: Date.now() + PAUSE_AFTER_REJECTED_LOGIN_MS, error, rejected: sent }
      // A rejected login is not a missing piece of an answer: the call it happens in fails.
      if (call) call.ended ??= error
      throw error
    }

    if (response.status === 429 && !tried.rate) {
      const wait = Number(response.headers.get('retry-after'))
      await this.sleep(Number.isFinite(wait) && wait > 0 ? Math.min(wait, 5) * 1000 : 500)
      return this.send(api, table, params, count, { ...tried, rate: true })
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

    const result = isObject ? body?.result : undefined
    if (!Array.isArray(result)) {
      const type = quoteInstanceText(response.headers.get('content-type') ?? 'unknown content type', 80)
      const said = isObject ? `${this.host} answered without a result list (HTTP ${response.status}).` : `${this.host} did not answer with JSON (HTTP ${response.status}, ${type}).`
      const error = this.pauseIfClosed(new ServiceNowError(said, 'invalid_response', table, response.status))
      // What answers is not the API of an instance: a page of a sleeping instance, or the answer of a proxy,
      // also where that is JSON. Every list this server asks for comes as a list.
      if (call) call.ended ??= error
      throw error
    }

    this.accepted = true
    return { body: { result }, headers: response.headers }
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
    const { allow } = this.config.tables
    return !this.denies(table) && (!allow.length || allow.some((pattern) => matches(pattern, table)))
  }

  /** Whether the deny list of this machine names a table, by name or by pattern. Says nothing about its child tables. */
  denies(table: string): boolean {
    return this.config.tables.deny.some((pattern) => matches(pattern, table))
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

/** Whether an entry of a table list, a name or a pattern that ends in "*", names a table. */
function matches(pattern: string, table: string): boolean {
  return pattern.endsWith('*') ? table.startsWith(pattern.slice(0, -1)) : table === pattern
}

function sameAuth(a: Auth, b: Auth): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function classify(status: number, text: string): ErrorKind {
  if (status === 401) return 'auth'
  if (status === 404 || /invalid table/i.test(text)) return 'not_found'
  if (status === 403 || /\bACL\b|not authorized|insufficient rights|security constraints/i.test(text)) return 'acl'
  if (status === 429) return 'rate_limited'
  // 414: the address of the request was longer than what stands in front of the instance takes.
  if (status === 400 || status === 414) return 'bad_request'
  return 'unknown'
}
