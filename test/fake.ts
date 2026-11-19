import type { InstanceConfig } from '../src/config.js'
import { ServiceNowClient, type Row } from '../src/client.js'

export interface Route {
  table: string
  /** Text the sysparm_query must contain. Omit to match any query. */
  query?: string
  rows?: Row[]
  total?: number
  status?: number
  /** Raw body, for answers that are not the usual JSON. */
  body?: string
  api?: 'table' | 'stats'
}

export interface Call {
  method: string
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
}

/** A stand-in for an instance: answers from a list of routes and records every request. */
export function fakeInstance(routes: Route[]) {
  const calls: Call[] = []

  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const parsed = new URL(url)
    const [, , , api, table] = parsed.pathname.split('/')
    const query = parsed.searchParams.get('sysparm_query') ?? ''
    calls.push({ method: String(init.method), api, table, query, params: parsed.searchParams, headers: init.headers as Record<string, string> })

    const route = routes.find(
      (candidate) => candidate.table === table && (candidate.api ?? 'table') === api && (candidate.query === undefined || query.includes(candidate.query)),
    )
    const status = route?.status ?? 200
    if (route?.body !== undefined) return new Response(route.body, { status, headers: { 'content-type': 'text/html' } })
    if (status !== 200) {
      return new Response(JSON.stringify({ error: { message: `HTTP ${status}` }, status: 'failure' }), { status })
    }

    const rows = route?.rows ?? []
    const offset = Number(parsed.searchParams.get('sysparm_offset') ?? 0)
    const limit = Number(parsed.searchParams.get('sysparm_limit') ?? 10_000)
    const page = api === 'stats' ? rows : rows.slice(offset, offset + limit)
    return new Response(JSON.stringify({ result: page }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-total-count': String(route?.total ?? rows.length) },
    })
  }

  return { calls, sn: new ServiceNowClient(config, fetchImpl) }
}

const column = (name: string, element: string, internal_type = 'string', reference = '') => ({
  name,
  element,
  column_label: element,
  internal_type,
  reference,
  mandatory: 'false',
  read_only: 'false',
  max_length: '40',
})

/** Dictionary of a small world: incident extends task; both point to sys_user. */
export const dictionaryRoutes: Route[] = [
  { table: 'sys_db_object', query: 'name=incident', rows: [{ name: 'incident', label: 'Incident', 'super_class.name': 'task', 'super_class.super_class.name': '' }] },
  { table: 'sys_db_object', query: 'name=task', rows: [{ name: 'task', label: 'Task', 'super_class.name': '' }] },
  { table: 'sys_db_object', query: 'name=sys_user', rows: [{ name: 'sys_user', label: 'User', 'super_class.name': '' }] },
  {
    table: 'sys_dictionary',
    query: 'nameINincident,task',
    rows: [
      column('task', 'sys_id', 'GUID'),
      column('task', 'number'),
      column('task', 'short_description'),
      column('task', 'active', 'boolean'),
      column('task', 'assigned_to', 'reference', 'sys_user'),
      column('incident', 'caller_id', 'reference', 'sys_user'),
      column('incident', 'category'),
    ],
  },
  { table: 'sys_dictionary', query: 'nameINtask', rows: [column('task', 'sys_id', 'GUID'), column('task', 'number'), column('task', 'short_description')] },
  { table: 'sys_dictionary', query: 'nameINsys_user', rows: [column('sys_user', 'sys_id', 'GUID'), column('sys_user', 'name'), column('sys_user', 'email')] },
]
