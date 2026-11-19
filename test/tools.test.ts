import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildServer } from '../src/server.js'
import { dictionaryRoutes, fakeInstance, type Route } from './fake.js'

type Data = Record<string, any>

async function connect(routes: Route[]) {
  const { sn, calls } = fakeInstance(routes)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '1.0.0' })
  await Promise.all([client.connect(clientTransport), buildServer(sn).connect(serverTransport)])

  const call = async (name: string, args: Data = {}) => {
    const result = await client.callTool({ name, arguments: args })
    const text = (result.content as Array<{ text: string }>)[0].text
    return { data: JSON.parse(text) as Data, structured: result.structuredContent as Data | undefined, isError: result.isError === true }
  }
  return { client, call, calls }
}

const ID = '0123456789abcdef0123456789abcdef'
const file = (packageClass: string) => ({
  sys_id: ID,
  sys_class_name: 'sys_script',
  sys_name: 'Example rule',
  sys_update_name: `sys_script_${ID}`,
  sys_package: { value: 'p1', display_value: 'Example package' },
  'sys_package.sys_class_name': packageClass,
  'sys_package.source': 'example',
  sys_created_on: '2020-01-01 00:00:00',
})
const customerRow = { name: `sys_script_${ID}`, action: 'INSERT_OR_UPDATE', update_set: { value: 's1', display_value: 'Default' } }

test('eight tools, all marked read-only, none that writes', async () => {
  const { client } = await connect([])
  const { tools } = await client.listTools()
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ['sn_delta', 'sn_dependencies', 'sn_instance', 'sn_origin', 'sn_plugins', 'sn_query', 'sn_schema', 'sn_upgrade_skips'],
  )
  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, true, tool.name)
    assert.equal(tool.annotations?.destructiveHint, false, tool.name)
    assert.ok(tool.outputSchema, `${tool.name} has an output schema`)
    assert.doesNotMatch(tool.name, /create|update|delete|insert|write|exec|run/i)
  }
})

test('sn_query refuses a misspelled field before anything is sent to the table', async () => {
  const { call, calls } = await connect([...dictionaryRoutes, { table: 'incident', rows: [{ number: 'INC1' }] }])
  const result = await call('sn_query', { table: 'incident', query: 'actve=true' })

  assert.equal(result.isError, true)
  assert.equal(result.data.error, 'validation')
  assert.match(result.data.message, /actve/)
  assert.match(result.data.message, /similar: active/)
  assert.equal(calls.filter((entry) => entry.table === 'incident').length, 0)
})

test('sn_query refuses an unknown field in the field list too', async () => {
  const { call } = await connect([...dictionaryRoutes, { table: 'incident', rows: [] }])
  assert.equal((await call('sn_query', { table: 'incident', fields: ['nmber'] })).data.error, 'validation')
})

test('sn_query answers with the query, the total and where to continue', async () => {
  const rows = Array.from({ length: 3 }, (_, index) => ({ number: `INC${index}` }))
  const { call } = await connect([...dictionaryRoutes, { table: 'incident', rows, total: 3 }])
  const { data, structured, isError } = await call('sn_query', { table: 'incident', query: 'active=true^caller_id.emailLIKEexample', fields: ['number'], limit: 2 })

  assert.equal(isError, false)
  assert.deepEqual(structured, data)
  assert.equal(data.instance, 'example.service-now.com')
  assert.equal(data.query, 'active=true^caller_id.emailLIKEexample')
  assert.equal(data.total, 3)
  assert.equal(data.returned, 2)
  assert.equal(data.truncated, true)
  assert.equal(data.nextOffset, 2)
  assert.match(data.fieldCheck, /verified/)
})

test('sn_query says when rows matched but were withheld from this account', async () => {
  const { call } = await connect([...dictionaryRoutes, { table: 'incident', rows: [{ number: 'INC1' }], total: 5 }])
  const { data } = await call('sn_query', { table: 'incident', limit: 5 })
  assert.equal(data.total, 5)
  assert.equal(data.returned, 1)
  assert.match(data.warnings.join(' '), /4 matching row\(s\)/)
})

test('sn_query says when field names could not be verified', async () => {
  const { call } = await connect([{ table: 'v_virtual', rows: [{ a: '1' }] }])
  const { data, isError } = await call('sn_query', { table: 'v_virtual', query: 'a=1' })
  assert.equal(isError, false)
  assert.match(data.fieldCheck, /not possible/)
})

test('an unreadable table is an error that says "could not be checked"', async () => {
  const { call } = await connect([...dictionaryRoutes, { table: 'incident', status: 403 }])
  const { data, isError } = await call('sn_query', { table: 'incident' })
  assert.equal(isError, true)
  assert.equal(data.error, 'acl')
  assert.match(data.hint, /could not be checked/)
})

test('sn_schema returns the effective structure with inherited fields', async () => {
  const { call } = await connect(dictionaryRoutes)
  const own = (await call('sn_schema', { table: 'incident' })).data
  const all = (await call('sn_schema', { table: 'incident', includeInherited: true })).data

  assert.deepEqual(own.table, { name: 'incident', label: 'Incident', extends: ['task'] })
  assert.deepEqual(own.columns.map((column: Data) => column.name), ['caller_id', 'category'])
  assert.equal(own.inheritedColumnCount, 5)
  assert.equal(all.columnCount, 7)
  assert.equal(all.columns.find((column: Data) => column.name === 'number').definedOn, 'task')
})

test('sn_origin: vendor record without customer change', async () => {
  const { call } = await connect([{ table: 'sys_metadata', rows: [file('sys_plugins')] }])
  const { data } = await call('sn_origin', { sysId: ID })
  assert.equal(data.verdict, 'out_of_box_as_captured')
  assert.equal(data.provenance, 'vendor')
  assert.equal(data.divergence, 'no_customer_changes_captured')
  assert.equal(data.record.package, 'Example package')
  assert.ok(data.caveats.length > 0)
})

test('sn_origin: vendor record with a customer update is customized', async () => {
  const { call } = await connect([{ table: 'sys_metadata', rows: [file('sys_store_app')] }, { table: 'sys_update_xml', rows: [customerRow] }])
  const { data } = await call('sn_origin', { sysId: ID })
  assert.equal(data.verdict, 'customized')
  assert.equal(data.provenance, 'installed_application')
  assert.equal(data.evidence.customerUpdates.total, 1)
})

test('sn_origin: version history from an update set also counts as a customer change', async () => {
  const { call } = await connect([
    { table: 'sys_metadata', rows: [file('sys_package')] },
    { table: 'sys_update_version', rows: [{ state: 'current', source_table: 'sys_update_set' }, { state: 'previous', source_table: 'sys_upgrade_history' }] },
  ])
  const { data } = await call('sn_origin', { sysId: ID })
  assert.equal(data.verdict, 'customized')
  assert.deepEqual(data.evidence.versions.bySource, { sys_update_set: 1, sys_upgrade_history: 1 })
})

test('sn_origin: global record with a customer update is customer-created', async () => {
  const { call } = await connect([{ table: 'sys_metadata', rows: [file('sys_scope')] }, { table: 'sys_update_xml', rows: [customerRow] }])
  assert.equal((await call('sn_origin', { updateName: `sys_script_${ID}` })).data.verdict, 'customer_created')
})

test('sn_origin abstains when the evidence does not decide', async () => {
  const globalNoRows = await connect([{ table: 'sys_metadata', rows: [file('sys_scope')] }])
  assert.equal((await globalNoRows.call('sn_origin', { sysId: ID })).data.verdict, 'unknown')

  const unreadable = await connect([{ table: 'sys_metadata', rows: [file('sys_plugins')] }, { table: 'sys_update_xml', status: 403 }])
  const { data } = await unreadable.call('sn_origin', { sysId: ID })
  assert.equal(data.verdict, 'unknown')
  assert.equal(data.divergence, 'unknown')
  assert.equal(data.evidence.customerUpdates.readable, false)
  assert.match(data.warnings.join(' '), /sys_update_xml could not be read/)

  const noPackage = await connect([{ table: 'sys_metadata', rows: [{ ...file(''), sys_package: '' }] }])
  assert.equal((await noPackage.call('sn_origin', { sysId: ID })).data.provenance, 'unknown')
})

test('sn_origin: a record that is gone', async () => {
  const deleted = await connect([{ table: 'sys_update_xml', rows: [{ ...customerRow, action: 'DELETE' }] }])
  assert.equal((await deleted.call('sn_origin', { updateName: `sys_script_${ID}` })).data.verdict, 'deleted_here')
  const missing = await connect([])
  assert.equal((await missing.call('sn_origin', { sysId: ID })).data.verdict, 'not_found')
  assert.equal((await missing.call('sn_origin', {})).data.error, 'validation')
  assert.equal((await missing.call('sn_origin', { updateName: 'x^ORname=y' })).data.error, 'validation')
})

test('sn_delta lists updates, exact counts per type and its own gaps', async () => {
  const { call, calls } = await connect([
    { table: 'sys_update_xml', rows: [{ name: 'sys_script_1', type: 'Business Rule', action: 'INSERT_OR_UPDATE' }], total: 9 },
    { table: 'sys_update_xml', api: 'stats', rows: [{ stats: { count: '2' }, groupby_fields: [{ value: 'Dictionary' }] }, { stats: { count: '7' }, groupby_fields: [{ value: 'Business Rule' }] }] },
  ])
  const { data } = await call('sn_delta', { type: 'Business Rule', since: '2026-01-01', limit: 1 })

  assert.equal(data.total, 9)
  assert.equal(data.truncated, true)
  assert.deepEqual(data.byType, [{ type: 'Business Rule', count: 7 }, { type: 'Dictionary', count: 2 }])
  assert.ok(data.notCaptured.length >= 5)
  assert.equal(calls.find((entry) => entry.api === 'table')?.query, 'type=Business Rule^sys_created_on>=2026-01-01 00:00:00^ORDERBYDESCsys_created_on')
  assert.equal((await call('sn_delta', { nameContains: 'a^ORb=c' })).data.error, 'validation')
})

test('sn_plugins falls back to sys_scope when store apps are not readable', async () => {
  const { call, calls } = await connect([
    { table: 'v_plugin', rows: [{ id: 'com.example', name: 'Example', active: 'active', version: '1.0.0' }] },
    { table: 'sys_store_app', status: 403 },
    { table: 'sys_scope', rows: [{ name: 'Example app', scope: 'x_example', version: '2.0.0', active: 'true' }] },
  ])
  const { data } = await call('sn_plugins', { filter: 'Example' })

  assert.equal(data.plugins.returned, 1)
  assert.equal(data.storeApps.readFrom, 'sys_scope')
  assert.equal(data.storeApps.items[0].scope, 'x_example')
  assert.equal(calls.find((entry) => entry.table === 'v_plugin')?.query, 'nameLIKEExample^active=active')
  assert.equal(calls.find((entry) => entry.table === 'sys_scope')?.query, 'sys_class_name=sys_store_app^nameLIKEExample^active=true')
})

test('sn_upgrade_skips covers the latest family upgrade and names it', async () => {
  const { call, calls } = await connect([
    { table: 'sys_upgrade_history', rows: [{ sys_id: 'u1', from_version: 'glide-a.zip', to_version: 'glide-b.zip', upgrade_finished: '2026-07-04 12:00:00' }] },
    { table: 'sys_choice', rows: [{ value: '10', label: 'Skipped Manual Merge' }, { value: '9', label: 'Skipped Error' }] },
    {
      table: 'upgrade_history_task',
      rows: [{ 'upgrade_detail.file_name': 'sys_script_1', 'upgrade_detail.type': 'Business Rule', 'upgrade_detail.disposition': { value: '10', display_value: 'Skipped Manual Merge' }, state: { value: '1', display_value: 'Not Reviewed' } }],
    },
  ])
  const { data } = await call('sn_upgrade_skips', {})

  assert.deepEqual(data.upgrade, { from: 'glide-a.zip', to: 'glide-b.zip', finished: '2026-07-04 12:00:00' })
  assert.deepEqual(data.dispositionCodes, { codes: ['10', '9'], from: 'instance' })
  assert.deepEqual(data.byDisposition, { 'Skipped Manual Merge': 1 })
  assert.deepEqual(data.records[0].disposition, { value: '10', display: 'Skipped Manual Merge' })
  assert.equal(calls.find((entry) => entry.table === 'upgrade_history_task')?.query, 'upgrade_detail.upgrade_history=u1^upgrade_detail.dispositionIN10,9^ORDERBYDESCsys_created_on')
})

test('sn_upgrade_skips says when it had to fall back to built-in codes', async () => {
  const { call } = await connect([{ table: 'sys_choice', status: 403 }])
  const { data } = await call('sn_upgrade_skips', { upgrade: 'all' })
  assert.equal(data.dispositionCodes.from, 'fallback')
  assert.match(data.warnings.join(' '), /built-in list/)
  assert.equal(data.upgrade, null)
})

test('sn_dependencies checks what it can and marks the rest', async () => {
  const { call } = await connect([
    { table: 'sys_db_object', query: 'super_class.name=incident', rows: [{ name: 'incident_child' }] },
    ...dictionaryRoutes,
    { table: 'sys_db_object', query: 'name=sys_script', rows: [{ name: 'sys_script', label: 'Business Rule', 'super_class.name': '' }] },
    { table: 'sys_dictionary', query: 'nameINsys_script', rows: [{ name: 'sys_script', element: 'collection', internal_type: 'table_name' }, { name: 'sys_script', element: 'active', internal_type: 'boolean' }] },
    { table: 'sys_script', rows: [{ sys_id: 'a1', sys_name: 'Rule on task', sys_update_name: 'sys_script_a1', collection: 'task', active: 'true', when: 'before' }, { sys_id: 'a2', sys_name: 'Rule on incident', sys_update_name: 'sys_script_a2', collection: 'incident', active: 'true' }], total: 12 },
    { table: 'sys_update_xml', rows: [{ name: 'sys_script_a2' }] },
  ])
  const { data } = await call('sn_dependencies', { table: 'incident', limit: 2 })
  const rules = data.categories.businessRules

  assert.deepEqual(data.tablesCovered, ['incident', 'task'])
  assert.equal(rules.status, 'checked')
  assert.equal(rules.total, 12)
  assert.equal(rules.truncated, true)
  assert.deepEqual(rules.items[0], { name: 'Rule on task', sysId: 'a1', definedOn: 'task', active: true, customerUpdate: false, details: { when: 'before' } })
  assert.equal(rules.items[1].customerUpdate, true)
  assert.equal(data.categories.clientScripts.status, 'not_checked')
  assert.deepEqual(data.childTables.names, ['incident_child'])
  assert.ok(data.notCovered.length > 0)
  assert.match(data.warnings.join(' '), /Not checked/)
})

test('sn_instance names the release and reports unreadable sources', async () => {
  const { call } = await connect([
    { table: 'sys_properties', rows: [{ name: 'glide.war', value: 'glide-zurich-07-01-2025__patch1.zip' }, { name: 'glide.script.use.sandbox', value: 'true' }] },
    { table: 'sys_update_xml', rows: [{ sys_id: '1' }], total: 321 },
    { table: 'sys_store_app', status: 403 },
  ])
  const { data } = await call('sn_instance')

  assert.deepEqual(data.release, { build: 'glide-zurich-07-01-2025__patch1.zip', family: 'zurich' })
  assert.equal(data.scriptSandbox, 'true')
  assert.equal(data.counts.customerUpdates, 321)
  assert.equal(data.sources.sys_store_app, 'acl')
  assert.equal(data.sources.sys_dictionary, 'readable')
  assert.match(data.warnings.join(' '), /sys_store_app \(acl\)/)
})

test('every request any tool sends is a GET to one of two read endpoints', async () => {
  const { call, calls, client } = await connect(dictionaryRoutes)
  for (const [name, args] of [
    ['sn_instance', {}],
    ['sn_query', { table: 'incident', query: 'active=true' }],
    ['sn_schema', { table: 'incident', includeInherited: true }],
    ['sn_plugins', {}],
    ['sn_delta', {}],
    ['sn_origin', { sysId: ID }],
    ['sn_dependencies', { table: 'incident' }],
    ['sn_upgrade_skips', {}],
  ] as const) {
    await call(name, args)
  }
  await client.readResource({ uri: 'servicenow-sparring://limitations' })

  assert.ok(calls.length > 40)
  for (const entry of calls) {
    assert.equal(entry.method, 'GET')
    assert.match(entry.api, /^(table|stats)$/)
    assert.match(entry.table, /^[a-z0-9_]+$/)
    assert.doesNotMatch(entry.query, /javascript/i)
  }
})
