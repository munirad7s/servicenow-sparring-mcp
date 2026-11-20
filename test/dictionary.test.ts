import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Dictionary } from '../src/dictionary.js'
import { ServiceNowError } from '../src/errors.js'
import { column, dictionaryRoutes, fakeInstance, isProof, showsParents, tableRow, type Route } from './fake.js'

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
  assert.match((await dict.checkFields('incident', ['watch_list.email'])).unknown[0].reason, /list of references \(glide_list\).*compare the list with its sys_id: watch_listLIKE<sys_id>/)
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

test('a miss is not looked up again within half a minute', async () => {
  const { sn, calls } = fakeInstance(dictionaryRoutes)
  const dict = new Dictionary(sn)
  assert.equal((await dict.checkFields('incident', ['u_late'])).unknown.length, 1)
  const before = calls.length
  assert.equal((await dict.checkFields('incident', ['u_late'])).unknown.length, 1)
  assert.equal(calls.length, before, 'the entry is younger than the time after which a miss is checked again')
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
        { sys_id: 'o1', name: 'incident', element: 'short_description', mandatory_override: 'true', mandatory: 'true' },
        { sys_id: 'o2', name: 'u_major', element: 'short_description', default_value_override: 'true' },
      ],
    },
    ...dictionaryRoutes,
  ])
  const effective = await new Dictionary(sn).effectiveColumns('u_major')
  const field = effective?.columns.find((item) => item.name === 'short_description')
  assert.equal(field?.mandatory, true)
  assert.equal(field?.overriddenOn, 'u_major')
  assert.deepEqual(field?.overrides, ['mandatory', 'default_value'])
  // Each override is a record of its own, with what it changes: the nearest table first.
  assert.deepEqual(field?.overrideRecords, [
    { table: 'u_major', sysId: 'o2', changes: ['default_value'] },
    { table: 'incident', sysId: 'o1', changes: ['mandatory'] },
  ])
  assert.equal(effective?.overridesRead, true)
})

test('a child table can rename an inherited field', async () => {
  const labels = [
    { name: 'task', element: 'short_description', label: 'Short description', language: 'en' },
    { name: 'task', element: 'number', label: 'Number', language: 'en' },
    { name: 'incident', element: 'short_description', label: 'Summary', language: 'en' },
  ]
  const { sn } = fakeInstance([{ table: 'sys_documentation', rows: labels }, ...dictionaryRoutes])
  const dict = new Dictionary(sn)

  const onIncident = await dict.effectiveColumns('incident')
  assert.equal(onIncident?.columns.find((item) => item.name === 'short_description')?.label, 'Summary')
  assert.equal(onIncident?.columns.find((item) => item.name === 'number')?.label, 'Number')
  // The label is a record of its own, and this one belongs to another table than the field does.
  assert.equal(onIncident?.columns.find((item) => item.name === 'short_description')?.labelFrom, 'incident')
  assert.equal(onIncident?.columns.find((item) => item.name === 'number')?.labelFrom, undefined)
  assert.equal(onIncident?.labelsRead, true)

  const unreadable = fakeInstance([{ table: 'sys_documentation', status: 403 }, ...dictionaryRoutes])
  const fallback = await new Dictionary(unreadable.sn).effectiveColumns('incident')
  assert.equal(fallback?.labelsRead, false)
  assert.equal(fallback?.columns.find((item) => item.name === 'number')?.label, 'number')
})

test('a database view has the fields of the tables it joins, with their prefix', async () => {
  const { sn } = fakeInstance([
    { table: 'sys_db_object', query: 'name=incident_sla', rows: [] },
    { table: 'sys_db_view', query: 'name=incident_sla', rows: [{ sys_id: 'a'.repeat(32), name: 'incident_sla', label: 'Incident SLA' }] },
    { table: 'sys_db_view_table', rows: [{ sys_id: 'f465a118eb100ae3d2798d4c5296a09c', table: 'incident', variable_prefix: 'inc' }, { sys_id: 'bf55059b290ba44777f3ddd89b854c4e', table: 'sys_user', variable_prefix: 'usr' }] },
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

test('a view that names itself or another view as a part does not send the server in circles', async () => {
  const view = (name: string, id: string, part: string): Parameters<typeof fakeInstance>[0] => [
    { table: 'sys_db_object', query: `name=${name}`, rows: [] },
    { table: 'sys_db_view', query: `name=${name}`, rows: [{ sys_id: id.repeat(32), name, label: name }] },
    { table: 'sys_db_view_table', query: `view=${id.repeat(32)}`, rows: [{ table: part, variable_prefix: 'p' }] },
  ]
  const self = fakeInstance([...view('view_a', 'a', 'view_a'), ...dictionaryRoutes])
  await assert.rejects(new Dictionary(self.sn).table('view_a'), (error: unknown) => error instanceof ServiceNowError && error.kind === 'invalid_response')

  const loop = fakeInstance([...view('view_a', 'a', 'view_b'), ...view('view_b', 'b', 'view_a'), ...dictionaryRoutes])
  const check = await new Dictionary(loop.sn).checkFields('view_a', ['p_number'])
  assert.equal(check.status, 'unavailable')
  assert.deepEqual(check.unknown, [])
})

test('choices come from the nearest table that defines any', async () => {
  const { sn } = fakeInstance(dictionaryRoutes)
  const dict = new Dictionary(sn)
  // In every language the instance has a label in.
  assert.deepEqual(await dict.choices('incident', 'state'), [
    { value: '1', label: 'New', language: 'en' },
    { value: '6', label: 'Resolved', language: 'en' },
    { value: '6', label: 'Gelöst', language: 'de' },
  ])
  assert.deepEqual(await dict.choices('task', 'state'), [{ value: '1', label: 'Open', language: 'en' }])
  assert.deepEqual(await dict.choices('incident', 'category'), [])
})

test('choices defined only on a parent table apply to the child', async () => {
  const { sn } = fakeInstance([{ table: 'sys_choice', query: 'element=priority', rows: [{ name: 'task', value: '1', label: 'Critical', language: 'en' }] }, ...dictionaryRoutes])
  assert.deepEqual(await new Dictionary(sn).choices('incident', 'priority'), [{ value: '1', label: 'Critical', language: 'en' }])
})

test('the tables a long deny list closes are asked for in several requests, each of which proves itself', async () => {
  // Sixty names of thirty characters: more than one query should carry.
  const names = Array.from({ length: 130 }, (_, index) => `u_closed_table_number_${String(index).padStart(8, '0')}`)
  const child = tableRow('u_child_of_the_last', 'Child', names[59])
  const { sn, calls } = fakeInstance(
    [
      showsParents,
      // Every request is answered with the same rows: the table of tables as proof, one closed table and its child.
      { table: 'sys_db_object', query: '^ORname=sys_db_object', rows: [tableRow(names[59], 'Closed'), child, tableRow('sys_db_object', 'Table')] },
    ],
    { tables: { allow: [], deny: [...names, 'sn_hr_*'] } },
  )
  const closed = await new Dictionary(sn).closedTables()
  assert.deepEqual([...closed.keys()].sort(), [names[59], 'u_child_of_the_last'].sort())
  assert.deepEqual(closed.get('u_child_of_the_last'), ['u_child_of_the_last', names[59]])

  const asked = calls.filter((call) => call.table === 'sys_db_object' && call.query !== showsParents.exact && !isProof(call))
  assert.ok(asked.length > 1, `${asked.length} requests`)
  for (const call of asked) {
    assert.ok(call.query.length < 3_500, `a query of ${call.query.length} characters`)
    assert.ok(call.query.endsWith('^ORname=sys_db_object^ORDERBYsys_id'), 'each asks for the table of tables as proof')
  }
  // Every level of parents is asked for, for the names and for the pattern.
  const whole = asked.map((call) => call.query).join('^OR')
  for (const path of ['name', 'super_class.name', 'super_class.super_class.super_class.super_class.super_class.super_class.super_class.super_class.name']) {
    assert.ok(whole.includes(`${path}IN${names[0]},`), path)
    // The names go in groups, so that one condition alone never outgrows a query.
    assert.ok(whole.includes(`${path}IN${names[120]},`), path)
    assert.ok(whole.includes(`${path}STARTSWITHsn_hr_`), path)
  }
  // Asked once, then remembered.
  await new Dictionary(sn).closedTables()
  const again = new Dictionary(sn)
  await again.closedTables()
  const before = calls.length
  await again.closedTables()
  assert.equal(calls.length, before)
})

test('the tables below a table are listed only where the answer can be trusted', async () => {
  const below = (rows: Array<Record<string, string> | null>, extra: Partial<{ total: number; status: number }> = {}) => fakeInstance([showsParents, { table: 'sys_db_object', query: '^ORname=task', rows, ...extra }])
  const task = tableRow('task', 'Task')
  const incident = tableRow('incident', 'Incident', 'task')
  const major = tableRow('u_major_incident', 'Major incident', 'incident', 'task')

  const fine = below([task, incident, major])
  // Each with its parents up to the table, so that a closed table in between can be seen.
  assert.deepEqual([...((await new Dictionary(fine.sn).childTables('task')) ?? [])], [['incident', ['incident', 'task']], ['u_major_incident', ['u_major_incident', 'incident', 'task']]])
  // Every level of parents is asked for, and the table itself as proof that the query was applied.
  assert.match(fine.calls.filter((call) => !isProof(call))[1].query, /^super_class\.nameINtask\^ORsuper_class\.super_class\.nameINtask\^OR.*\^ORname=task\^ORDERBYsys_id$/)
  assert.equal((await new Dictionary(below([task]).sn).childTables('task'))?.size, 0)

  // Not trusted: the table itself is missing from the answer, a row matches none of the conditions, rows are
  // hidden, or the table of tables cannot be read. null means "assume that a closed table is among them".
  for (const [name, world] of [
    ['no proof', below([incident])],
    ['a row that matches nothing', below([task, tableRow('problem', 'Problem')])],
    ['hidden rows', below([task, incident, null])],
    ['more than was read', below([task, incident], { total: 9_000 })],
    ['not readable', below([], { status: 403 })],
  ] as const) {
    assert.equal(await new Dictionary(world.sn).childTables('task'), null, name)
  }
})

test('a child table more than eight levels below a closed table is found, with its parents up to the root', async () => {
  // One request sees eight levels down. "u_deep" has the closed table as its eighth parent, and "u_deeper" is below it.
  const mids = Array.from({ length: 7 }, (_, index) => `u_mid_${7 - index}`)
  const deep = tableRow('u_deep', 'Deep', ...mids, 'u_base')
  const deeper = tableRow('u_deeper', 'Deeper', 'u_deep', ...mids)
  const proof = tableRow('sys_db_object', 'Table')
  const { sn, calls } = fakeInstance(
    [
      showsParents,
      // Asked a second time, for what is below the table that was found at the eighth level.
      { table: 'sys_db_object', query: 'super_class.nameINu_deep^', rows: [deep, deeper, proof] },
      { table: 'sys_db_object', query: 'nameINu_base', rows: [tableRow('u_base', 'Base', 'u_root'), deep, proof] },
      // The parents of the table at the end of a chain that is as long as one request reads.
      { table: 'sys_db_object', exact: 'name=u_base', rows: [tableRow('u_base', 'Base', 'u_root')] },
      { table: 'sys_db_object', exact: 'name=u_mid_1', rows: [tableRow('u_mid_1', 'Mid', 'u_base', 'u_root')] },
    ],
    { tables: { allow: [], deny: ['u_base'] } },
  )
  const closed = await new Dictionary(sn).closedTables()
  assert.deepEqual([...closed.keys()].sort(), ['u_base', 'u_deep', 'u_deeper'])
  // Up to the root: a query on any table above them has to leave their rows out.
  assert.deepEqual(closed.get('u_deep'), ['u_deep', ...mids, 'u_base', 'u_root'])
  assert.deepEqual(closed.get('u_deeper'), ['u_deeper', 'u_deep', ...mids, 'u_base', 'u_root'])
  assert.equal(calls.filter((call) => call.query.endsWith('^ORname=sys_db_object^ORDERBYsys_id')).length, 2)
})

test('the tables below a table are followed deeper than one request sees', async () => {
  const mids = Array.from({ length: 7 }, (_, index) => `u_mid_${7 - index}`)
  const root = tableRow('u_root', 'Root')
  const deep = tableRow('u_deep', 'Deep', ...mids, 'u_root')
  const deeper = tableRow('u_deeper', 'Deeper', 'u_deep', ...mids)
  const { sn, calls } = fakeInstance([
    showsParents,
    { table: 'sys_db_object', query: 'super_class.nameINu_deep^', rows: [root, deeper] },
    { table: 'sys_db_object', query: 'super_class.nameINu_root^', rows: [root, deep] },
  ])
  const below = await new Dictionary(sn).childTables('u_root')
  assert.deepEqual(below?.get('u_deep'), ['u_deep', ...mids, 'u_root'])
  assert.deepEqual(below?.get('u_deeper'), ['u_deeper', 'u_deep', ...mids, 'u_root'])
  assert.equal(calls.filter((call) => call.query !== showsParents.exact && !isProof(call)).length, 2)
})

test('an account that is not shown what a table extends gets no list of child tables', async () => {
  // The lists are built from conditions on the parent of a table. An instance that drops them for this account
  // would answer with the table that was named and none of its child tables, and nothing would show it.
  const task = tableRow('task', 'Task')
  const proofs: Array<[string, Route]> = [
    ['no row', { table: 'sys_db_object', exact: 'super_class.nameISNOTEMPTY', rows: [] }],
    ['a row without its parent', { table: 'sys_db_object', exact: 'super_class.nameISNOTEMPTY', rows: [{ name: 'incident' }] }],
    ['a parent without the table it belongs to', { table: 'sys_db_object', exact: 'super_class.nameISNOTEMPTY', rows: [{ name: '', 'super_class.name': 'task' }] }],
    ['not readable', { table: 'sys_db_object', exact: 'super_class.nameISNOTEMPTY', status: 403 }],
  ]
  for (const [name, proof] of proofs) {
    const routes: Route[] = [proof, { table: 'sys_db_object', query: '^ORname=sys_db_object', rows: [task, tableRow('sys_db_object', 'Table')] }, { table: 'sys_db_object', query: '^ORname=task', rows: [task] }]
    const denying = new Dictionary(fakeInstance(routes, { tables: { allow: [], deny: ['task'] } }).sn)
    await assert.rejects(denying.closedTables(), (error: unknown) => error instanceof ServiceNowError && error.kind === 'blocked' && /did not show this account which table a table extends/.test(error.message), name)
    assert.equal(await new Dictionary(fakeInstance(routes).sn).childTables('task'), null, name)
  }
})

test('a rotation entry that is hidden, or cannot be read, is not "not rotated"', async () => {
  const rotation = (rows: Array<Record<string, string> | null>, extra: { noTotal?: boolean } = {}) => new Dictionary(fakeInstance([{ table: 'sys_table_rotation', rows, ...extra }]).sn).rotation('syslog')
  assert.equal(await rotation([]), null)
  assert.deepEqual(await rotation([{ name: 'syslog', type: 'rotate', duration: '1970-01-08 00:00:00', rotations: '8' }]), { rotations: 8, days: 7 })
  for (const [name, read, kind] of [
    ['hidden', rotation([null]), 'acl'],
    ['no total', rotation([], { noTotal: true }), 'invalid_response'],
    ['no length', rotation([{ name: 'syslog', type: 'rotate', duration: '', rotations: '8' }]), 'invalid_response'],
  ] as const) {
    await assert.rejects(read, (error: unknown) => error instanceof ServiceNowError && error.kind === kind, name)
  }
})

test('a login the instance rejects is passed on as that, and one unusable answer is not', async () => {
  // Not being able to log in says nothing about a field: the check does not turn it into "could not be read".
  const rejected = new Dictionary(fakeInstance([{ table: 'sys_db_object', status: 401 }]).sn)
  await assert.rejects(rejected.checkFields('incident', ['number']), (error: unknown) => error instanceof ServiceNowError && error.kind === 'auth')
  // A table of tables this account may not read is about that table: the check goes on and says what it could not do.
  const unreadable = await new Dictionary(fakeInstance([{ table: 'sys_db_object', status: 403 }]).sn).checkFields('incident', ['number', 'ref_incident.number'])
  assert.equal(unreadable.status, 'unavailable')
  // "ref_<the table itself>." is refused by its name alone, before anything is read.
  assert.match(unreadable.unknown[0].reason, /names the table itself/)
})

test('a view whose list of tables is partly hidden is not taken for a smaller view', async () => {
  // A table that is joined and not seen would be read without any of the checks that go by the tables of a view.
  const hidden: Array<[string, Partial<Route>]> = [
    ['a hidden row', { rows: [{ sys_id: 'f465a118eb100ae3d2798d4c5296a09c', table: 'incident', variable_prefix: 'inc' }, null] }],
    ['no total', { rows: [{ sys_id: 'f465a118eb100ae3d2798d4c5296a09c', table: 'incident', variable_prefix: 'inc' }], noTotal: true }],
  ]
  for (const [name, members] of hidden) {
    const { sn } = fakeInstance([
      { table: 'sys_db_object', query: 'name=incident_sla', rows: [] },
      { table: 'sys_db_view', query: 'name=incident_sla', rows: [{ sys_id: 'a'.repeat(32), name: 'incident_sla', label: 'Incident SLA' }] },
      { table: 'sys_db_view_table', ...members },
      ...dictionaryRoutes,
    ])
    await assert.rejects(new Dictionary(sn).table('incident_sla'), (error: unknown) => error instanceof ServiceNowError && error.kind === 'acl', name)
  }
})

test('a list of child tables is trusted only where the instance filters by every level of parents', async () => {
  // Measured: a condition the instance cannot use is dropped, and behind another in a chain of ^OR it then matches
  // nothing. The tables named would come back and none of their child tables. So each level is asked alone for a
  // table that is two things at once, and an instance that drops the condition answers with a row.
  const task = tableRow('task', 'Task')
  const lists: Route[] = [{ table: 'sys_db_object', query: '^ORname=sys_db_object', rows: [task, tableRow('sys_db_object', 'Table')] }, { table: 'sys_db_object', query: '^ORname=task', rows: [task] }]
  const third = 'super_class.super_class.super_class.name'
  const dropsNames: Route = { table: 'sys_db_object', exact: `${third}INzz__no_such_table_a^${third}INzz__no_such_table_b`, rows: [task], total: 10_806 }
  const dropsPatterns: Route = { table: 'sys_db_object', exact: `${third}STARTSWITHzz__no_such_table_a^${third}STARTSWITHzz__no_such_table_b`, rows: [task], total: 10_806 }
  const notTrusted = (error: unknown) => error instanceof ServiceNowError && error.kind === 'blocked' && /did not filter by it/.test(error.message)

  const byName = fakeInstance([dropsNames, showsParents, ...lists], { tables: { allow: [], deny: ['task'] } })
  await assert.rejects(new Dictionary(byName.sn).closedTables(), notTrusted)
  // The name of a table is asked like its parents: the lists name tables by "is one of" behind other conditions.
  const dropsOwnName: Route = { table: 'sys_db_object', exact: 'nameINzz__no_such_table_a^nameINzz__no_such_table_b', rows: [task], total: 10_806 }
  await assert.rejects(new Dictionary(fakeInstance([dropsOwnName, showsParents, ...lists], { tables: { allow: [], deny: ['task'] } }).sn).closedTables(), notTrusted)
  assert.equal(await new Dictionary(fakeInstance([dropsNames, showsParents, ...lists]).sn).childTables('task'), null)
  // Nothing was asked of the list itself.
  assert.equal(byName.calls.filter((call) => call.query.endsWith('^ORname=sys_db_object^ORDERBYsys_id')).length, 0)

  // "Starts with" is asked only where the list has a pattern, and then for every level as well.
  const plain = fakeInstance([dropsPatterns, showsParents, ...lists], { tables: { allow: [], deny: ['task'] } })
  assert.deepEqual([...(await new Dictionary(plain.sn).closedTables()).keys()], ['task'])
  // The name of a table and each of its eight levels of parents.
  assert.equal(plain.calls.filter(isProof).length, 9)
  const pattern = fakeInstance([dropsPatterns, showsParents, ...lists], { tables: { allow: [], deny: ['task', 'sn_hr_*'] } })
  await assert.rejects(new Dictionary(pattern.sn).closedTables(), notTrusted)
  assert.equal(pattern.calls.filter(isProof).length, 18)

  // Asked once: the proof is remembered with the list.
  const dict = new Dictionary(plain.sn)
  await dict.closedTables()
  const before = plain.calls.length
  await dict.childTables('task')
  assert.equal(plain.calls.length - before, 1)
})

test('a row of the table of tables that cannot be placed makes the list untrusted', async () => {
  // Without its name a closed table would be on the list under no name, and with a gap among its parents the
  // place of a parent says nothing about how deep the table is.
  const proof = tableRow('sys_db_object', 'Table')
  const nameless = { ...tableRow('u_child', 'Child', 'task'), name: '' }
  const gap = { ...tableRow('u_child', 'Child', 'task'), 'super_class.name': '', 'super_class.super_class.name': 'task' }
  // A name read here goes into the condition that leaves rows out. One that carries a condition of its own would
  // rewrite it: "…NOT INtask,u_x^ORsys_class_nameISNOTEMPTY" matches every row.
  const written = { ...tableRow('u_child', 'Child', 'task'), name: 'u_x^ORsys_class_nameISNOTEMPTY' }
  const parent = tableRow('u_child', 'Child', 'u_mid^ORnameISNOTEMPTY', 'task')
  for (const [name, row] of [['no name', nameless], ['a gap among the parents', gap], ['a name that is a condition', written], ['a parent that is a condition', parent]] as const) {
    const denying = fakeInstance([showsParents, { table: 'sys_db_object', query: '^ORname=sys_db_object', rows: [tableRow('task', 'Task'), row, proof] }], { tables: { allow: [], deny: ['task'] } })
    await assert.rejects(new Dictionary(denying.sn).closedTables(), (error: unknown) => error instanceof ServiceNowError && error.kind === 'blocked' && /no name, or a gap/.test(error.message), name)
    // Asked for as one table, such a row is no table whose parents end where the gap is.
    const single = fakeInstance([{ table: 'sys_db_object', exact: 'name=u_child', rows: [{ ...row, name: 'u_child' }] }])
    if (name !== 'no name' && name !== 'a name that is a condition') await assert.rejects(new Dictionary(single.sn).table('u_child'), (error: unknown) => error instanceof ServiceNowError && error.kind === 'invalid_response', name)
    const listing = fakeInstance([showsParents, { table: 'sys_db_object', query: '^ORname=task', rows: [tableRow('task', 'Task'), row] }])
    assert.equal(await new Dictionary(listing.sn).childTables('task'), null, name)
  }
})

test('many tables at the eighth level are asked for in requests that stay requests', async () => {
  // Their names stand in the query once per level of parents. Measured: an instance takes an address of about
  // 8,200 characters, and a comma takes three of them.
  const mids = Array.from({ length: 7 }, (_, index) => `u_mid_${7 - index}`)
  const deep = Array.from({ length: 40 }, (_, index) => tableRow(`u_a_table_with_a_long_name_${String(index).padStart(3, '0')}`, 'Deep', ...mids, 'u_root'))
  const { sn, calls } = fakeInstance([showsParents, { table: 'sys_db_object', query: 'super_class.nameINu_root^', rows: [tableRow('u_root', 'Root'), ...deep] }, { table: 'sys_db_object', query: '^ORname=u_root', rows: [tableRow('u_root', 'Root')] }])
  const below = await new Dictionary(sn).childTables('u_root')
  assert.equal(below?.size, 40)
  const asked = calls.filter((call) => call.query.endsWith('^ORname=u_root^ORDERBYsys_id'))
  assert.ok(asked.length > 3, `${asked.length} requests`)
  for (const call of asked) assert.ok(encodeURIComponent(call.query).length < 6_000, `a query of ${encodeURIComponent(call.query).length} characters in the address`)
})

test('a parent that cannot be read does not end the chain of a table', async () => {
  // One request sees eight parents. Where the eighth does not come back when asked for, the chain so far would
  // pass for the whole of it, and a table nine levels below a closed one for an open table.
  const mids = Array.from({ length: 8 }, (_, index) => `u_mid_${8 - index}`)
  const unread: Array<[string, Partial<Route>]> = [['no row', { rows: [] }], ['no row and no total', { rows: [], noTotal: true }]]
  for (const [name, top] of unread) {
    const { sn } = fakeInstance([
      { table: 'sys_db_object', exact: 'name=u_leaf', rows: [tableRow('u_leaf', 'Leaf', ...mids)] },
      { table: 'sys_db_object', exact: 'name=u_mid_1', ...top },
    ])
    await assert.rejects(new Dictionary(sn).table('u_leaf'), (error: unknown) => error instanceof ServiceNowError && error.kind === 'invalid_response' && /"u_mid_1", a parent of "u_leaf"/.test(error.message), name)
  }
  // Where it comes back, the chain goes on from it.
  const { sn } = fakeInstance([
    { table: 'sys_db_object', exact: 'name=u_leaf', rows: [tableRow('u_leaf', 'Leaf', ...mids)] },
    { table: 'sys_db_object', exact: 'name=u_mid_1', rows: [tableRow('u_mid_1', 'Mid', 'u_root')] },
  ])
  assert.deepEqual((await new Dictionary(sn).table('u_leaf'))?.chain, ['u_leaf', ...mids, 'u_root'])
})

test('a database view that comes back without a table it joins is not a view of nothing', async () => {
  // Such a view would pass every check that goes by the tables of a view, and still answer with rows.
  const { sn } = fakeInstance([
    { table: 'sys_db_object', rows: [] },
    { table: 'sys_db_view', query: 'name=incident_sla', rows: [{ sys_id: 'a'.repeat(32), name: 'incident_sla', label: 'Incident SLA' }] },
    { table: 'sys_db_view_table', rows: [] },
  ])
  await assert.rejects(new Dictionary(sn).table('incident_sla'), (error: unknown) => error instanceof ServiceNowError && error.kind === 'invalid_response' && /without a table it joins/.test(error.message))
})

test('a name that cannot be a table is a failed look-up, not an exception', async () => {
  const dict = new Dictionary(fakeInstance(dictionaryRoutes).sn)
  // The promise fails, so that a catch behind the call sees it.
  assert.equal(await dict.table('My-App').catch(() => 'caught'), 'caught')
  assert.equal(await dict.childTables('My-App').catch(() => 'caught'), 'caught')
})

test('which names are tables is asked for many names at once, and remembered', async () => {
  const { sn, calls } = fakeInstance([{ table: 'sys_db_object', query: 'nameIN', rows: [{ name: 'sys_script' }, { name: 'sys_script_include' }] }])
  const dict = new Dictionary(sn)
  const names = ['sys_script_include', 'sys_script', 'sys', 'Not-A-Table', ...Array.from({ length: 60 }, (_, index) => `u_no_table_${index}`)]
  assert.deepEqual([...(await dict.knownTables(names))].sort(), ['sys_script', 'sys_script_include'])
  // 63 names that can be a table, forty to a request. The name that cannot be one is not asked for.
  assert.equal(calls.length, 2)
  assert.ok(calls.every((call) => !call.query.includes('Not-A-Table')))
  // Remembered, also for a name that is no table.
  assert.deepEqual([...(await dict.knownTables(['sys_script', 'sys', 'u_no_table_7']))], ['sys_script'])
  assert.equal(calls.length, 2)

  // Hidden rows: which of the names are tables cannot be told.
  const hidden = new Dictionary(fakeInstance([{ table: 'sys_db_object', query: 'nameIN', rows: [{ name: 'sys_script' }, null] }]).sn)
  await assert.rejects(hidden.knownTables(['sys_script', 'sys_user']), (error: unknown) => error instanceof ServiceNowError && error.kind === 'acl')
})

test('a name that had to make room among those remembered is not answered as "no table"', async () => {
  // What is remembered about names is bounded. A table whose entry is the oldest is dropped while more names than
  // that are asked about: read back from what is remembered, it came back as a name that is no table.
  const many = Array.from({ length: 5_200 }, (_, index) => `u_no_table_${index}`)
  const instance = () => new Dictionary(fakeInstance([{ table: 'sys_db_object', query: 'nameIN', rows: [{ name: 'sys_script' }] }]).sn)
  // Remembered from an earlier call.
  const earlier = instance()
  assert.deepEqual([...(await earlier.knownTables(['sys_script']))], ['sys_script'])
  assert.equal((await earlier.knownTables(['sys_script', ...many])).has('sys_script'), true)
  // Asked about first in the same call.
  assert.equal((await instance().knownTables(['sys_script', ...many])).has('sys_script'), true)
})

test('what the name look-up says about a table it finds is kept, where the row says all of it', async () => {
  const parentsOf = (...names: string[]) => Object.fromEntries(Array.from({ length: 8 }, (_, level) => [`${'super_class.'.repeat(level + 1)}name`, names[level] ?? '']))
  const row = (name: string, ...parents: string[]) => ({ name, label: name, scriptable_table: 'false', ...parentsOf(...parents) })
  const deep = Array.from({ length: 8 }, (_, level) => `u_level_${level}`)
  const { sn, calls } = fakeInstance([
    {
      table: 'sys_db_object',
      query: 'nameIN',
      rows: [
        row('sys_script', 'sys_metadata'),
        // Came without the fields asked for: it says less than it seems to.
        { name: 'u_bare' },
        // Its parents were asked for and are not in the row: that is no "has no parent".
        { name: 'u_cut', label: 'Cut', scriptable_table: 'false' },
        // Eight parents: one request sees no further, so the chain may go on.
        row('u_deep', ...deep),
        // A parent that comes twice is no chain.
        row('u_ring', 'u_other', 'u_ring'),
      ],
    },
    { table: 'sys_db_object', query: 'name=u_bare', rows: [row('u_bare', 'task')] },
    { table: 'sys_db_object', query: 'name=u_cut', rows: [row('u_cut', 'u_secret')] },
  ])
  const dict = new Dictionary(sn)
  assert.deepEqual([...(await dict.knownTables(['sys_script', 'u_bare', 'u_cut', 'u_deep', 'u_ring', 'u_none']))].sort(), ['sys_script', 'u_bare', 'u_cut', 'u_deep', 'u_ring'])
  assert.equal(calls.length, 1)
  // Kept: what the table extends is known without another request.
  assert.deepEqual((await dict.table('sys_script'))?.chain, ['sys_script', 'sys_metadata'])
  assert.equal(calls.length, 1)
  // Not kept: the table is asked for by itself.
  assert.deepEqual((await dict.table('u_bare'))?.chain, ['u_bare', 'task'])
  assert.equal(calls.length, 2)
  assert.deepEqual((await dict.table('u_cut'))?.chain, ['u_cut', 'u_secret'])
  assert.equal(calls.length, 3)
  for (const name of ['u_deep', 'u_ring']) {
    const sentBefore: number = calls.length
    await dict.table(name).catch(() => null)
    assert.ok(calls.length > sentBefore, name)
  }
})

test('names that look like an unknown field are searched for the first few only', async () => {
  // Each search compares with every field of the table: a hundred unknown names on a wide table took seconds.
  const check = await new Dictionary(fakeInstance(dictionaryRoutes).sn).checkFields('incident', Array.from({ length: 8 }, (_, index) => `numbe${index}`))
  assert.equal(check.unknown.length, 8)
  assert.deepEqual(check.unknown.map((item) => item.suggestions.length > 0), [true, true, true, true, true, false, false, false])
})

test('a row that is not the table that was asked for is not taken for it', async () => {
  // An instance that drops the condition answers with some table. Its parents are not those of the one asked for.
  const { sn } = fakeInstance([{ table: 'sys_db_object', exact: 'name=u_notes', rows: [tableRow('task', 'Task')] }])
  await assert.rejects(new Dictionary(sn).table('u_notes'), (error: unknown) => error instanceof ServiceNowError && error.kind === 'invalid_response')
  // A table that names itself among its parents, or one of them twice, has no chain that ends.
  const circle = fakeInstance([{ table: 'sys_db_object', exact: 'name=u_a', rows: [tableRow('u_a', 'A', 'u_b', 'u_a')] }])
  await assert.rejects(new Dictionary(circle.sn).table('u_a'), (error: unknown) => error instanceof ServiceNowError && error.kind === 'invalid_response')
})
