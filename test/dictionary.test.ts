import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Dictionary } from '../src/dictionary.js'
import { ServiceNowError } from '../src/errors.js'
import { column, dictionaryRoutes, fakeInstance, tableRow } from './fake.js'

test('a table knows its parents and its kind', async () => {
  const { sn } = fakeInstance(dictionaryRoutes)
  const info = await new Dictionary(sn).table('incident')
  assert.deepEqual(info, { name: 'incident', label: 'Incident', chain: ['incident', 'task'], kind: 'table' })
  assert.equal(await new Dictionary(sn).table('no_such_table'), null)

  const remote = fakeInstance([{ table: 'sys_db_object', rows: [{ ...tableRow('v_remote', 'Remote'), scriptable_table: 'true' }] }])
  assert.equal((await new Dictionary(remote.sn).table('v_remote'))?.kind, 'remote_table')
})

test('a parent chain deeper than one request can see is followed to the root', async () => {
  const names = Array.from({ length: 12 }, (_, index) => `level_${index}`)
  const { sn, calls } = fakeInstance(names.map((name, index) => ({ table: 'sys_db_object', query: `name=${name}`, rows: [tableRow(name, name, ...names.slice(index + 1, index + 9))] })))

  assert.deepEqual((await new Dictionary(sn).table('level_0'))?.chain, names)
  assert.equal(calls.length, 2)
})

test('a parent chain that loops is an error, not an endless wait', async () => {
  const loop = fakeInstance([{ table: 'sys_db_object', rows: [tableRow('a', 'A', 'b', 'a', 'b', 'a', 'b', 'a', 'b', 'a')] }])
  await assert.rejects(new Dictionary(loop.sn).table('a'), (error: unknown) => error instanceof ServiceNowError && error.kind === 'invalid_response')

  const hostile = fakeInstance([{ table: 'sys_db_object', rows: [tableRow('a', 'A', 'task^ORname=sys_user')] }])
  await assert.rejects(new Dictionary(hostile.sn).table('a'), (error: unknown) => error instanceof ServiceNowError && error.kind === 'invalid_response')
})

test('a table entry that exists but is hidden is "not readable", not "does not exist"', async () => {
  const { sn } = fakeInstance([{ table: 'sys_db_object', rows: [], total: 1 }])
  await assert.rejects(new Dictionary(sn).table('x_secret'), (error: unknown) => error instanceof ServiceNowError && error.kind === 'acl')
})

test('fields are inherited and say where they are defined', async () => {
  const { sn } = fakeInstance(dictionaryRoutes)
  const columns = await new Dictionary(sn).columns('incident')
  assert.equal(columns?.get('short_description')?.definedOn, 'task')
  assert.equal(columns?.get('caller_id')?.definedOn, 'incident')
  assert.equal(columns?.get('caller_id')?.reference, 'sys_user')
  assert.equal(columns?.get('state')?.choice, true)
  assert.equal(columns?.get('number')?.choice, false)
})

test('a field defined again on the child table wins over the parent\'s definition', async () => {
  const { sn } = fakeInstance([
    { table: 'sys_dictionary', query: 'nameINincident,task', rows: [column('incident', 'short_description', 'string', '', { max_length: '160' }), column('task', 'short_description', 'string', '', { max_length: '40' })] },
    ...dictionaryRoutes,
  ])
  const field = (await new Dictionary(sn).columns('incident'))?.get('short_description')
  assert.deepEqual({ definedOn: field?.definedOn, maxLength: field?.maxLength }, { definedOn: 'incident', maxLength: 160 })
})

test('an unknown field is found, with suggestions', async () => {
  const { sn } = fakeInstance(dictionaryRoutes)
  const check = await new Dictionary(sn).checkFields('incident', ['short_descripton', 'active'])
  assert.equal(check.status, 'checked')
  assert.equal(check.unknown.length, 1)
  assert.equal(check.unknown[0].field, 'short_descripton')
  assert.ok(check.unknown[0].suggestions.includes('short_description'))
  assert.equal(check.resolved.get('active')?.type, 'boolean')
})

test('dot-walks are followed through single references only', async () => {
  const { sn } = fakeInstance(dictionaryRoutes)
  const dict = new Dictionary(sn)
  assert.deepEqual((await dict.checkFields('incident', ['caller_id.email', 'assigned_to.name'])).unknown, [])
  assert.match((await dict.checkFields('incident', ['caller_id.phone'])).unknown[0].reason, /not a field of "sys_user"/)
  assert.match((await dict.checkFields('incident', ['category.name'])).unknown[0].reason, /of type string, not a single reference/)
  // ServiceNow drops a condition that walks through a list field, although the field names a table.
  assert.match((await dict.checkFields('incident', ['watch_list.email'])).unknown[0].reason, /list of references \(glide_list\)/)
})

test('"ref_<child>" reaches a field of a child table', async () => {
  const { sn } = fakeInstance(dictionaryRoutes)
  const dict = new Dictionary(sn)
  const ok = await dict.checkFields('task', ['ref_incident.caller_id', 'ref_incident.caller_id.email'])
  assert.deepEqual(ok.unknown, [])
  assert.equal(ok.resolved.get('ref_incident.caller_id')?.reference, 'sys_user')
  assert.match((await dict.checkFields('task', ['ref_incident.zzz'])).unknown[0].reason, /not a field of "incident"/)
  // sys_user is not a child of task, so this is read as a field name and not found.
  assert.equal((await dict.checkFields('task', ['ref_sys_user.name'])).unknown.length, 1)
})

test('a table without dictionary cannot be checked, and says so', async () => {
  const { sn } = fakeInstance(dictionaryRoutes)
  const check = await new Dictionary(sn).checkFields('v_virtual', ['anything'])
  assert.equal(check.status, 'unavailable')
  assert.deepEqual(check.unknown, [])
})

test('an unreadable dictionary cannot be checked, and says so', async () => {
  const { sn } = fakeInstance([{ table: 'sys_db_object', status: 403 }])
  const check = await new Dictionary(sn).checkFields('incident', ['active'])
  assert.equal(check.status, 'unavailable')
  assert.match(check.reason ?? '', /acl/)
})

test('a field proven wrong stays wrong when another part of the dictionary cannot be read', async () => {
  const routes = dictionaryRoutes.map((route) => (route.query === 'name=sys_user' ? { ...route, rows: undefined, status: 403 } : route))
  const { sn } = fakeInstance(routes)
  const check = await new Dictionary(sn).checkFields('incident', ['actve', 'caller_id.email'])
  assert.equal(check.status, 'unavailable')
  assert.deepEqual(check.unknown.map((item) => item.field), ['actve'])
})

test('a dictionary with hidden rows proves nothing about a missing name', async () => {
  const routes = dictionaryRoutes.map((route) => (route.query === 'nameINincident,task' ? { ...route, total: 40 } : route))
  const { sn } = fakeInstance(routes)
  const dict = new Dictionary(sn)

  const check = await dict.checkFields('incident', ['active', 'u_hidden_field'])
  assert.equal(check.status, 'unavailable')
  assert.deepEqual(check.unknown, [])
  assert.match(check.reason ?? '', /only partly readable/)
  assert.equal((await dict.effectiveColumns('incident'))?.complete, false)
})

test('the dictionary is read once per table', async () => {
  const { sn, calls } = fakeInstance(dictionaryRoutes)
  const dict = new Dictionary(sn)
  await dict.checkFields('incident', ['active'])
  const after = calls.length
  await dict.checkFields('incident', ['number', 'category'])
  assert.equal(calls.length, after)
})

test('a field created during a session is found: a miss is looked up again', async () => {
  const routes = [...dictionaryRoutes]
  const { sn } = fakeInstance(routes)
  const dict = new Dictionary(sn, 600_000, 0)

  assert.equal((await dict.checkFields('incident', ['u_new_field'])).unknown.length, 1)
  const index = routes.findIndex((route) => route.query === 'nameINincident,task')
  routes[index] = { ...routes[index], rows: [...(routes[index].rows ?? []), column('incident', 'u_new_field')] }
  assert.equal((await dict.checkFields('incident', ['u_new_field'])).unknown.length, 0)
})

test('dictionary overrides change the effective field, and overrides of several tables add up', async () => {
  const { sn } = fakeInstance([
    { table: 'sys_db_object', query: 'name=u_major', rows: [tableRow('u_major', 'Major', 'incident', 'task')] },
    { table: 'sys_dictionary', query: 'nameINu_major,incident,task', rows: [column('task', 'short_description')] },
    {
      table: 'sys_dictionary_override',
      rows: [
        { name: 'incident', element: 'short_description', mandatory_override: 'true', mandatory: 'true' },
        { name: 'u_major', element: 'short_description', default_value_override: 'true' },
      ],
    },
    ...dictionaryRoutes,
  ])
  const effective = await new Dictionary(sn).effectiveColumns('u_major')
  const field = effective?.columns.find((item) => item.name === 'short_description')
  assert.equal(field?.mandatory, true)
  assert.equal(field?.overriddenOn, 'u_major')
  assert.deepEqual(field?.overrides, ['mandatory', 'default_value'])
  assert.equal(effective?.overridesRead, true)
})

test('a database view has the fields of the tables it joins, with their prefix', async () => {
  const { sn } = fakeInstance([
    { table: 'sys_db_object', query: 'name=incident_sla', rows: [] },
    { table: 'sys_db_view', query: 'name=incident_sla', rows: [{ sys_id: 'a'.repeat(32), name: 'incident_sla', label: 'Incident SLA' }] },
    { table: 'sys_db_view_table', rows: [{ table: 'incident', variable_prefix: 'inc' }, { table: 'sys_user', variable_prefix: 'usr' }] },
    ...dictionaryRoutes,
  ])
  const dict = new Dictionary(sn)

  assert.deepEqual(await dict.table('incident_sla'), {
    name: 'incident_sla',
    label: 'Incident SLA',
    chain: ['incident_sla'],
    kind: 'database_view',
    members: [{ table: 'incident', prefix: 'inc' }, { table: 'sys_user', prefix: 'usr' }],
  })
  const check = await dict.checkFields('incident_sla', ['inc_number', 'usr_email', 'inc_actve', 'number'])
  assert.equal(check.status, 'checked')
  assert.deepEqual(check.unknown.map((item) => item.field), ['inc_actve', 'number'])
  assert.equal(check.resolved.get('inc_number')?.definedOn, 'incident')
})

test('choices come from the nearest table that defines any', async () => {
  const { sn } = fakeInstance(dictionaryRoutes)
  const dict = new Dictionary(sn)
  assert.deepEqual(await dict.choices('incident', 'state'), [{ value: '1', label: 'New' }, { value: '6', label: 'Resolved' }])
  assert.deepEqual(await dict.choices('task', 'state'), [{ value: '1', label: 'Open' }])
  assert.deepEqual(await dict.choices('incident', 'category'), [])
})

test('choices defined only on a parent table apply to the child', async () => {
  const { sn } = fakeInstance([{ table: 'sys_choice', query: 'element=priority', rows: [{ name: 'task', value: '1', label: 'Critical' }] }, ...dictionaryRoutes])
  assert.deepEqual(await new Dictionary(sn).choices('incident', 'priority'), [{ value: '1', label: 'Critical' }])
})
