import type { InstanceConfig } from '../src/config.js'
import { ServiceNowClient, type AuditEntry, type Row } from '../src/client.js'

export interface Route {
  table: string
  /** Text the sysparm_query must contain. Omit to match any query. */
  query?: string
  /** The whole sysparm_query, where a part of it is not proof enough. */
  exact?: string
  /** A pattern the sysparm_query must match, where neither a part nor the whole says it. */
  match?: RegExp
  /** The sysparm_group_by a request to the Aggregate API must carry. Omit to match any. */
  groupBy?: string
  /** A null stands for a row that matches but is hidden from the account: counted in the total, never returned. */
  rows?: Array<Row | null>
  /** Value of X-Total-Count. Defaults to the number of rows. */
  total?: number
  /** true leaves the X-Total-Count header out. */
  noTotal?: boolean
  status?: number
  /** Raw body, for answers that are not the usual JSON. */
  body?: string
  /** true for a request that never gets an answer: the connection fails. */
  unreachable?: boolean
  api?: 'table' | 'stats'
}

export interface Call {
  method: string
  origin: string
  pathname: string
  body: unknown
  api: string
  table: string
  query: string
  params: URLSearchParams
  headers: Record<string, string>
}

export const config: InstanceConfig = {
  instanceUrl: 'https://example.service-now.com',
  auth: { kind: 'basic', username: 'reader', password: 'secret' },
  timeoutMs: 5_000,
  maxResponseBytes: 1_000_000,
  tables: { allow: [], deny: [] },
}

/** What a real instance says when it refuses, by status. */
const ERRORS: Record<number, { message: string; detail: string }> = {
  400: { message: 'Bad Request', detail: 'The request could not be understood' },
  401: { message: 'User Not Authenticated', detail: 'Required to provide Auth information' },
  403: { message: 'User Not Authorized', detail: 'Failed API level ACL Validation' },
  404: { message: 'No Record found', detail: 'Records matching the query not found' },
  429: { message: 'Too Many Requests', detail: 'Rate limit exceeded' },
  500: { message: 'Internal Server Error', detail: '' },
}

/**
 * A stand-in for an instance. It answers from a list of routes, records every
 * request, and behaves like the Table API where the tools depend on it:
 *
 * - a field named in sysparm_fields that a row does not have is left out;
 * - sysparm_display_value=all wraps every value as {value, display_value};
 * - a query that asks for a field to be two things at once (empty and filled, one of two names that no table or
 *   class has) matches no row;
 * - a table without a route answers "Invalid table", as a real instance does.
 */
export function fakeInstance(routes: Route[], overrides: Partial<InstanceConfig> = {}, audit?: (entry: AuditEntry) => void) {
  const calls: Call[] = []

  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const parsed = new URL(url)
    const [, , , api, table] = parsed.pathname.split('/')
    const query = parsed.searchParams.get('sysparm_query') ?? ''
    calls.push({ method: String(init.method), origin: parsed.origin, pathname: parsed.pathname, body: init.body, api, table, query, params: parsed.searchParams, headers: init.headers as Record<string, string> })

    const fits = (candidate: Route) =>
      candidate.table === table &&
      (candidate.api ?? 'table') === api &&
      (candidate.query === undefined || query.includes(candidate.query)) &&
      (candidate.exact === undefined || query === candidate.exact) &&
      (candidate.match === undefined || candidate.match.test(query)) &&
      (candidate.groupBy === undefined || parsed.searchParams.get('sysparm_group_by') === candidate.groupBy)
    const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

    // A field that is empty and filled at once: no row is. An instance that applies the query answers with none,
    // whatever the table holds. A test that wants an instance which drops the condition says so with a route for
    // exactly this query.
    const impossible = IMPOSSIBLE.some((pattern) => pattern.test(query))
    const route = impossible ? (routes.find((candidate) => candidate.exact === query && fits(candidate)) ?? (routes.some((candidate) => candidate.table === table) ? { table, rows: [] } : undefined)) : routes.find(fits)

    if (!route) return json({ error: { message: `Invalid table ${table}`, detail: null }, status: 'failure' }, 400)
    if (route.unreachable) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })
    const status = route.status ?? 200
    if (route.body !== undefined) return new Response(route.body, { status, headers: { 'content-type': 'text/html' } })
    if (status !== 200) return json({ error: ERRORS[status] ?? { message: `HTTP ${status}`, detail: '' }, status: 'failure' }, status)

    const rows = route.rows ?? []
    if (api === 'stats') {
      // Like the Aggregate API: a group carries its label only when display values were asked for.
      const labelled = parsed.searchParams.get('sysparm_display_value') === 'all'
      const groups = rows
        .filter((row): row is Row => row !== null)
        .map((row) => {
          const fields = (row as { groupby_fields?: Array<Record<string, unknown>> }).groupby_fields
          return labelled || !Array.isArray(fields) ? row : { ...row, groupby_fields: fields.map(({ display_value: _label, ...rest }) => rest) }
        })
      return json({ result: groups }, 200)
    }

    const offset = Number(parsed.searchParams.get('sysparm_offset') ?? 0)
    const limit = Number(parsed.searchParams.get('sysparm_limit') ?? 10_000)
    const fields = parsed.searchParams.get('sysparm_fields')?.split(',')
    const display = parsed.searchParams.get('sysparm_display_value') === 'all'

    const visible = rows.slice(offset, offset + limit).filter((row): row is Row => row !== null)
    const page = visible.map((row) => {
      const kept = fields ? Object.fromEntries(Object.entries(row).filter(([key]) => fields.includes(key))) : row
      if (!display) return Object.fromEntries(Object.entries(kept).map(([key, value]) => [key, isPair(value) ? value.value : value]))
      return Object.fromEntries(Object.entries(kept).map(([key, value]) => [key, isPair(value) ? value : { value, display_value: value }]))
    })
    return json({ result: page }, 200, route.noTotal ? {} : { 'x-total-count': String(route.total ?? rows.length) })
  }

  return { calls, sn: new ServiceNowClient({ ...config, ...overrides }, fetchImpl, { audit, sleep: async () => undefined }) }
}

/**
 * true for a request the server sends to prove something before it relies on it, and not to read: a question that
 * has to match nothing, or the one row it asks a table for to see that the table has rows at all.
 */
export function isProof(call: Call): boolean {
  const impossible = IMPOSSIBLE.some((pattern) => pattern.test(call.query))
  // One row that has a class, with its class: `<field>ISNOTEMPTY`, asking for the sys_id and that field.
  const field = /^([a-z0-9_.]+)ISNOTEMPTY$/.exec(call.query)?.[1]
  const oneRow = field !== undefined && call.params.get('sysparm_fields') === `sys_id,${field}` && call.params.get('sysparm_limit') === '1' && call.api === 'table'
  return impossible || oneRow
}

/**
 * Questions that no row can answer: a field that is empty and filled at once, one of two names that nothing has,
 * a class and not that class.
 */
const IMPOSSIBLE = [
  /^([a-z0-9_.]+)ISEMPTY\^\1ISNOTEMPTY$/,
  /^([a-z0-9_.]+)(IN|STARTSWITH)zz__no_such_[a-z_]+\^\1\2zz__no_such_[a-z_]+$/,
  /^([a-z0-9_.]+)=([a-z0-9_]+)\^\1NOT IN\2$/,
]

function isPair(value: unknown): value is { value: unknown; display_value: unknown } {
  return Boolean(value) && typeof value === 'object' && 'value' in (value as object) && 'display_value' in (value as object)
}

/** A value with a label that differs from what is stored, as references and choices have. */
export const labelled = (value: string, display_value: string) => ({ value, display_value })

export const column = (name: string, element: string, internal_type = 'string', reference = '', extra: Row = {}) => ({
  name,
  element,
  column_label: element,
  internal_type,
  reference,
  mandatory: 'false',
  read_only: 'false',
  max_length: '40',
  active: 'true',
  choice: '0',
  ...extra,
})

const noParents = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`${'super_class.'.repeat(i + 1)}name`, '']))
export const tableRow = (name: string, label: string, ...parents: string[]) => ({
  name,
  label,
  scriptable_table: 'false',
  ...noParents,
  ...Object.fromEntries(parents.map((parent, i) => [`${'super_class.'.repeat(i + 1)}name`, parent])),
})

/**
 * What an instance answers when it is asked which tables a deny list closes: the tables given, which are the closed
 * ones and their child tables, and always the row of its own table of tables, which the question asks for as proof
 * that it was understood.
 */
export const closedTables = (...rows: Row[]): Route => ({ table: 'sys_db_object', query: '^ORname=sys_db_object', rows: [...rows, tableRow('sys_db_object', 'Table')] })

/** What an instance answers when it is asked which of some names are tables: the names that are. */
export function knownTables(...names: string[]): Route {
  // That question is nothing but a list of names. A list of child tables asks by name too, with more behind it.
  return { table: 'sys_db_object', match: /^nameIN[^^]*$/, rows: names.map((name) => ({ name })) }
}

/**
 * What an instance answers when it is asked for one table that extends another: the proof that this account can be
 * told what a table extends. The lists of child tables are trusted only after it.
 */
export const showsParents: Route = { table: 'sys_db_object', exact: 'super_class.nameISNOTEMPTY', rows: [{ name: 'incident', 'super_class.name': 'task' }] }

/** Dictionary of a small world: incident extends task; both point to sys_user. */
export const dictionaryRoutes: Route[] = [
  showsParents,
  { table: 'sys_db_object', query: 'name=incident', rows: [tableRow('incident', 'Incident', 'task')] },
  { table: 'sys_db_object', query: 'name=task', rows: [tableRow('task', 'Task')] },
  { table: 'sys_db_object', query: 'name=sys_user', rows: [tableRow('sys_user', 'User')] },
  // The tables the server looks things up in for its own checks. While tables are closed on the machine, a table
  // the instance does not list is not asked for, so the stand-in lists them as an instance does.
  ...['sys_script', 'sys_archive', 'sys_table_rotation', 'sys_properties', 'sys_choice', 'sys_documentation', 'sys_dictionary_override'].flatMap((name): Route[] => [
    { table: 'sys_db_object', exact: `name=${name}`, rows: [tableRow(name, name)] },
    // Asked which tables are below it, each answers with itself and no child table.
    { table: 'sys_db_object', query: `^ORname=${name}`, rows: [tableRow(name, name)] },
  ]),
  // The two tables everything else is read from, as tables of their own.
  { table: 'sys_db_object', exact: 'name=sys_db_object', rows: [tableRow('sys_db_object', 'Table')] },
  { table: 'sys_db_object', exact: 'name=sys_dictionary', rows: [tableRow('sys_dictionary', 'Dictionary Entry')] },
  // No table of this small world is a child of a closed one, unless a test says so with a route of its own.
  closedTables(),
  // Asked which of some names are tables, it lists the tables of this world.
  knownTables('incident', 'task', 'sys_user', 'sys_script', 'sys_archive', 'sys_table_rotation', 'sys_properties', 'sys_choice', 'sys_documentation', 'sys_dictionary_override'),
  { table: 'sys_db_object', rows: [] },
  { table: 'sys_db_view', rows: [] },
  {
    table: 'sys_dictionary',
    query: 'nameINincident,task',
    rows: [
      column('task', 'sys_id', 'GUID'),
      column('task', 'number'),
      column('task', 'short_description'),
      column('task', 'active', 'boolean'),
      column('task', 'state', 'integer', '', { choice: '3' }),
      column('task', 'assigned_to', 'reference', 'sys_user'),
      column('task', 'watch_list', 'glide_list', 'sys_user'),
      column('incident', 'caller_id', 'reference', 'sys_user'),
      column('incident', 'category'),
    ],
  },
  { table: 'sys_dictionary', query: 'nameINtask', rows: [column('task', 'sys_id', 'GUID'), column('task', 'number'), column('task', 'short_description')] },
  {
    table: 'sys_dictionary',
    query: 'nameINsys_user',
    rows: [column('sys_user', 'sys_id', 'GUID'), column('sys_user', 'name'), column('sys_user', 'email'), column('sys_user', 'user_password', 'password')],
  },
  { table: 'sys_dictionary_override', rows: [] },
  { table: 'sys_documentation', rows: [] },
  // Not set, as on most instances: a query the instance cannot use is answered with every row.
  { table: 'sys_properties', query: 'name=glide.invalid_query.returns_no_rows', rows: [] },
  {
    table: 'sys_choice',
    query: 'element=state',
    rows: [
      { name: 'task', value: '1', label: 'Open', language: 'en' },
      { name: 'incident', value: '1', label: 'New', language: 'en' },
      { name: 'incident', value: '6', label: 'Resolved', language: 'en' },
      { name: 'incident', value: '6', label: 'Gelöst', language: 'de' },
    ],
  },
  { table: 'sys_choice', rows: [] },
]
