import type { InstanceConfig } from '../src/config.js'
import { ServiceNowClient, type AuditEntry, type Row } from '../src/client.js'

export interface Route {
  table: string
  /** Text the sysparm_query must contain. Omit to match any query. */
  query?: string
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
 * - a table without a route answers "Invalid table", as a real instance does.
 */
export function fakeInstance(routes: Route[], overrides: Partial<InstanceConfig> = {}, audit?: (entry: AuditEntry) => void) {
  const calls: Call[] = []

  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const parsed = new URL(url)
    const [, , , api, table] = parsed.pathname.split('/')
    const query = parsed.searchParams.get('sysparm_query') ?? ''
    calls.push({ method: String(init.method), origin: parsed.origin, pathname: parsed.pathname, body: init.body, api, table, query, params: parsed.searchParams, headers: init.headers as Record<string, string> })

    const route = routes.find(
      (candidate) =>
        candidate.table === table &&
        (candidate.api ?? 'table') === api &&
        (candidate.query === undefined || query.includes(candidate.query)) &&
        (candidate.groupBy === undefined || parsed.searchParams.get('sysparm_group_by') === candidate.groupBy),
    )
    const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

    if (!route) return json({ error: { message: `Invalid table ${table}`, detail: null }, status: 'failure' }, 400)
    const status = route.status ?? 200
    if (route.body !== undefined) return new Response(route.body, { status, headers: { 'content-type': 'text/html' } })
    if (status !== 200) return json({ error: ERRORS[status] ?? { message: `HTTP ${status}`, detail: '' }, status: 'failure' }, status)

    const rows = route.rows ?? []
    if (api === 'stats') return json({ result: rows }, 200)

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

/** Dictionary of a small world: incident extends task; both point to sys_user. */
export const dictionaryRoutes: Route[] = [
  { table: 'sys_db_object', query: 'name=incident', rows: [tableRow('incident', 'Incident', 'task')] },
  { table: 'sys_db_object', query: 'name=task', rows: [tableRow('task', 'Task')] },
  { table: 'sys_db_object', query: 'name=sys_user', rows: [tableRow('sys_user', 'User')] },
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
  {
    table: 'sys_choice',
    query: 'element=state',
    rows: [
      { name: 'task', value: '1', label: 'Open' },
      { name: 'incident', value: '1', label: 'New' },
      { name: 'incident', value: '6', label: 'Resolved' },
    ],
  },
  { table: 'sys_choice', rows: [] },
]
