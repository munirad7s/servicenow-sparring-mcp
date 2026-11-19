import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ServiceNowClient } from '../src/client.js'
import { ServiceNowError } from '../src/errors.js'
import { config, fakeInstance } from './fake.js'

const kindOf = async (run: () => Promise<unknown>) => {
  try {
    await run()
  } catch (error) {
    return error instanceof ServiceNowError ? error.kind : `not a ServiceNowError: ${error}`
  }
  return 'no error'
}

test('a query is one GET to the Table API with the expected parameters', async () => {
  const { sn, calls } = fakeInstance([{ table: 'incident', rows: [{ number: 'INC1' }], total: 42 }])
  const page = await sn.query({ table: 'incident', query: 'active=true', fields: ['number'], limit: 5, offset: 10, display: true })

  assert.equal(calls.length, 1)
  const [call] = calls
  assert.equal(call.method, 'GET')
  assert.equal(call.api, 'table')
  assert.equal(call.table, 'incident')
  assert.equal(call.query, 'active=true')
  assert.equal(call.params.get('sysparm_fields'), 'number')
  assert.equal(call.params.get('sysparm_limit'), '5')
  assert.equal(call.params.get('sysparm_offset'), '10')
  assert.equal(call.params.get('sysparm_display_value'), 'all')
  assert.equal(call.params.get('sysparm_exclude_reference_link'), 'true')
  assert.equal(call.headers.Authorization, 'Basic ' + Buffer.from('reader:secret').toString('base64'))
  assert.equal(page.total, 42)
})

test('a token is sent as a bearer header', async () => {
  let header = ''
  const sn = new ServiceNowClient({ ...config, auth: { kind: 'bearer', token: 'abc' } }, async (_url, init) => {
    header = (init.headers as Record<string, string>).Authorization
    return new Response('{"result":[]}', { status: 200 })
  })
  await sn.query({ table: 'incident' })
  assert.equal(header, 'Bearer abc')
})

test('unsafe input never reaches the network', async () => {
  const { sn, calls } = fakeInstance([])
  assert.equal(await kindOf(() => sn.query({ table: '../../x_app/endpoint' })), 'validation')
  assert.equal(await kindOf(() => sn.query({ table: 'incident', query: 'opened_at>javascript:gs.daysAgo(1)' })), 'validation')
  assert.equal(await kindOf(() => sn.query({ table: 'incident', fields: ['number,sys_id&x=1'] })), 'validation')
  assert.equal(await kindOf(() => sn.groupCount('incident', 'state^x', '')), 'validation')
  assert.equal(calls.length, 0)
})

test('an answer that is not JSON is an error, not "no rows"', async () => {
  const { sn } = fakeInstance([{ table: 'incident', body: '<html>Instance hibernating</html>' }])
  assert.equal(await kindOf(() => sn.query({ table: 'incident' })), 'invalid_response')
})

test('an answer without a result list is an error', async () => {
  const sn = new ServiceNowClient(config, async () => new Response('{"result":{"a":1}}', { status: 200 }))
  assert.equal(await kindOf(() => sn.query({ table: 'incident' })), 'invalid_response')
})

test('redirects are not followed', async () => {
  let redirectMode: unknown
  const sn = new ServiceNowClient(config, async (_url, init) => {
    redirectMode = init.redirect
    return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } })
  })
  assert.equal(await kindOf(() => sn.query({ table: 'incident' })), 'invalid_response')
  assert.equal(redirectMode, 'manual')
})

test('failures are classified', async () => {
  for (const [status, kind] of [[401, 'auth'], [403, 'acl'], [404, 'not_found'], [429, 'rate_limited'], [400, 'bad_request'], [500, 'unknown']] as const) {
    const { sn } = fakeInstance([{ table: 'incident', status }])
    assert.equal(await kindOf(() => sn.query({ table: 'incident' })), kind, `HTTP ${status}`)
  }
  const down = new ServiceNowClient(config, async () => {
    throw new TypeError('fetch failed')
  })
  assert.equal(await kindOf(() => down.query({ table: 'incident' })), 'network')
  const slow = new ServiceNowClient(config, async () => {
    throw new DOMException('timed out', 'TimeoutError')
  })
  assert.equal(await kindOf(() => slow.query({ table: 'incident' })), 'timeout')
})

test('a missing total is reported as unknown', async () => {
  const sn = new ServiceNowClient(config, async () => new Response('{"result":[{"a":"1"}]}', { status: 200 }))
  assert.equal((await sn.query({ table: 'incident' })).total, null)
})

test('paging follows the server total, because access rules can leave pages short', async () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({ n: String(index) }))
  // The instance says 12 rows match but this account only ever sees 5 of them.
  const { sn, calls } = fakeInstance([{ table: 'incident', rows, total: 12 }])
  const result = await sn.all({ table: 'incident' }, 100, 4)

  assert.equal(calls.length, 3)
  assert.equal(result.records.length, 5)
  assert.equal(result.total, 12)
  assert.equal(result.complete, true)
})

test('counts per group come from the Aggregate API', async () => {
  const { sn, calls } = fakeInstance([
    { table: 'sys_update_xml', api: 'stats', rows: [{ stats: { count: '7' }, groupby_fields: [{ field: 'type', value: 'Business Rule' }] }] },
  ])
  assert.deepEqual(await sn.groupCount('sys_update_xml', 'type', 'sys_created_by=admin'), [{ value: 'Business Rule', count: 7 }])
  assert.equal(calls[0].api, 'stats')
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].params.get('sysparm_group_by'), 'type')
})
