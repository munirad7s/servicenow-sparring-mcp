import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { InstanceConfig } from '../src/config.js'
import { buildServer } from '../src/server.js'
import { queryByContent } from '../src/tools/origin.js'
import { column, dictionaryRoutes, fakeInstance, labelled, tableRow, type Route } from './fake.js'

type Data = Record<string, any>

async function connect(routes: Route[], overrides: Partial<InstanceConfig> = {}) {
  const { sn, calls } = fakeInstance(routes, overrides)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '1.0.0' })
  await Promise.all([client.connect(clientTransport), buildServer(sn).connect(serverTransport)])

  const call = async (name: string, args: Data = {}) => {
    const result = await client.callTool({ name, arguments: args })
    const text = (result.content as Array<{ text: string }>)[0].text
    // An input the schema rejects is answered by the protocol layer, in plain text.
    const data: Data = text.startsWith('{') ? JSON.parse(text) : { message: text }
    return { data, structured: result.structuredContent as Data | undefined, isError: result.isError === true }
  }
  /** A call that must succeed: its answer is returned, an error fails the test with the message. */
  const answer = async (name: string, args: Data = {}) => {
    const result = await call(name, args)
    assert.equal(result.isError, false, `${name} failed: ${result.data.message}`)
    return result.data
  }
  const sentTo = (table: string, api = 'table') => calls.filter((entry) => entry.table === table && entry.api === api)
  return { client, call, answer, calls, sentTo }
}

const ID = '0123456789abcdef0123456789abcdef'
const NAME = `sys_script_${ID}`
const stats = (table: string, groups: Record<string, number>, query?: string, groupBy?: string): Route => ({
  table,
  api: 'stats',
  query,
  groupBy,
  rows: Object.entries(groups).map(([value, count]) => ({ stats: { count: String(count) }, groupby_fields: [{ value }] })),
})

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

// ---------------------------------------------------------------- sn_query

test('sn_query refuses a misspelled field before anything is sent to the table', async () => {
  const { call, sentTo } = await connect([...dictionaryRoutes, { table: 'incident', rows: [{ number: 'INC1' }] }])
  const result = await call('sn_query', { table: 'incident', query: 'actve=true' })

  assert.equal(result.isError, true)
  assert.equal(result.data.error, 'validation')
  assert.match(result.data.message, /actve/)
  assert.match(result.data.message, /similar: active/)
  assert.equal(sentTo('incident').length, 0)
  assert.equal((await call('sn_query', { table: 'incident', fields: ['nmber'] })).data.error, 'validation')
  assert.equal((await call('sn_query', { table: 'incident', query: 'watch_list.email=a' })).data.error, 'validation')
})

test('sn_query answers with the query, the total, the cost and where to continue', async () => {
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
  assert.equal(data.fieldCheck, 'all field names verified against sys_dictionary')
  // Four to check the names, one to ask for rules that run on every read, one for the rows.
  assert.equal(data.requests, 6)
})

test('sn_query says when business rules run on every read of the table', async () => {
  // Measured: 183 such rules on one instance. They add conditions that depend on who asks.
  const rules = (rows: Array<Record<string, string>>, total = rows.length): Route => ({ table: 'sys_script', query: 'action_query=true', rows, total })
  const incident = { table: 'incident', rows: [{ number: 'INC1' }] }

  const { answer, sentTo } = await connect([rules([{ sys_id: 'r1', action_query: 'true' }], 2), ...dictionaryRoutes, incident, stats('incident', { '1': 1 })])
  const data = await answer('sn_query', { table: 'incident', fields: ['number'] })
  assert.match(data.warnings.join(' '), /2 business rules run on every read of this table.*what they let this account see.*sys_script, collectionINincident,task,global\^action_query=true\^active=true/)
  // Counting is a read too. The rules of a table are asked for once, not with every query.
  assert.match((await answer('sn_query', { table: 'incident', groupBy: 'state' })).warnings.join(' '), /2 business rules run on every read/)
  assert.equal(sentTo('sys_script').length, 1)

  const none = await connect([rules([]), ...dictionaryRoutes, incident])
  assert.deepEqual((await none.answer('sn_query', { table: 'incident', fields: ['number'] })).warnings, [])

  // Not readable, or the instance does not know the field that marks such a rule: nothing is claimed.
  for (const route of [{ table: 'sys_script', status: 403 }, rules([{ sys_id: 'r1' }], 500)]) {
    const blind = await connect([route, ...dictionaryRoutes, incident])
    assert.deepEqual((await blind.answer('sn_query', { table: 'incident', fields: ['number'] })).warnings, [])
  }
})

test('sn_query says when rows matched but were withheld from this account', async () => {
  const { answer } = await connect([...dictionaryRoutes, { table: 'incident', rows: [{ number: 'INC1' }], total: 5 }])
  const data = await answer('sn_query', { table: 'incident', limit: 5 })
  assert.equal(data.total, 5)
  assert.equal(data.returned, 1)
  assert.match(data.warnings.join(' '), /4 matching row\(s\)/)
})

test('sn_query keeps paging honest when the answer has to be cut', async () => {
  const rows = Array.from({ length: 150 }, (_, index) => ({ number: `INC${index}`, short_description: 'y'.repeat(1_500) }))
  const { answer } = await connect([...dictionaryRoutes, { table: 'incident', rows }])
  const data = await answer('sn_query', { table: 'incident', fields: ['number', 'short_description'], limit: 150 })

  assert.ok(data.records.length < 150)
  assert.equal(data.returned, data.records.length)
  assert.equal(data.truncated, true)
  assert.equal(data.nextOffset, data.records.length)
})

test('without a dictionary, field names are checked against a row of the table', async () => {
  const routes = [{ table: 'sys_db_object', rows: [] }, { table: 'sys_db_view', rows: [] }, { table: 'v_virtual', rows: [{ a: '1', b: '2' }] }]
  const ok = await connect(routes)
  assert.match((await ok.answer('sn_query', { table: 'v_virtual', query: 'a=1', fields: ['b'] })).fieldCheck, /verified against a row of the table/)

  const typo = await connect(routes)
  const refused = await typo.call('sn_query', { table: 'v_virtual', query: 'zzz=1' })
  assert.equal(refused.data.error, 'validation')
  assert.match(refused.data.message, /Unknown field: zzz/)
  assert.equal(typo.sentTo('v_virtual').length, 1, 'only the probe was sent')
})

test('when field names cannot be verified at all, a filtered query is not sent', async () => {
  const base = [{ table: 'sys_db_object', status: 403 }]
  const empty = await connect([...base, { table: 'incident', rows: [] }])
  assert.match((await empty.answer('sn_query', { table: 'incident', query: 'active=true' })).fieldCheck, /no rows to check against/)

  const hidden = await connect([...base, { table: 'incident', rows: [], total: 7 }])
  const result = await hidden.call('sn_query', { table: 'incident', query: 'active=true' })
  assert.equal(result.data.error, 'acl')
  assert.match(result.data.message, /could not be verified/)
  assert.equal(hidden.sentTo('incident').length, 1, 'only the probe was sent')

  const unfiltered = await connect([...base, { table: 'incident', rows: [{ number: 'INC1' }] }])
  assert.match((await unfiltered.answer('sn_query', { table: 'incident' })).fieldCheck, /not needed/)
})

test('a choice label in place of the stored value is refused, with the value to use', async () => {
  const { call, answer, sentTo } = await connect([...dictionaryRoutes, { table: 'incident', rows: [{ number: 'INC1' }] }])

  const refused = await call('sn_query', { table: 'incident', query: 'state=Resolved' })
  assert.equal(refused.data.error, 'validation')
  assert.match(refused.data.message, /"Resolved" is the label of "6"/)
  assert.equal((await call('sn_query', { table: 'incident', query: 'stateIN1,New' })).data.error, 'validation')
  // Measured: with a label, "is not" matches nothing either where the stored value is a number.
  assert.equal((await call('sn_query', { table: 'incident', query: 'state!=Resolved' })).data.error, 'validation')
  assert.equal((await call('sn_query', { table: 'incident', query: 'stateNOT INNew,Resolved' })).data.error, 'validation')
  assert.equal(sentTo('incident').length, 0)

  assert.equal((await answer('sn_query', { table: 'incident', query: 'state=6' })).returned, 1)
  assert.equal((await answer('sn_query', { table: 'incident', query: 'stateIN1,6' })).returned, 1)
})

test('the check of choice labels also runs for a database view and with a partly readable dictionary', async () => {
  const view: Route[] = [
    { table: 'sys_db_object', query: 'name=incident_view', rows: [] },
    { table: 'sys_db_view', query: 'name=incident_view', rows: [{ sys_id: 'c'.repeat(32), name: 'incident_view', label: 'Incidents' }] },
    { table: 'sys_db_view_table', rows: [{ table: 'incident', variable_prefix: 'inc' }] },
  ]
  const onView = await connect([...view, ...dictionaryRoutes, { table: 'incident_view', rows: [{ inc_number: 'INC1' }] }])
  const refused = await onView.call('sn_query', { table: 'incident_view', query: 'inc_state=Resolved' })
  assert.match(refused.data.message, /"Resolved" is the label of "6"/)
  assert.equal((await onView.answer('sn_query', { table: 'incident_view', query: 'inc_state=6' })).returned, 1)

  // The dictionary of sys_user cannot be read, so the dot-walk is checked against a row. The label is still caught.
  const partly = dictionaryRoutes.map((route) => (route.query === 'name=sys_user' ? { ...route, rows: undefined, status: 403 } : route))
  const { call, sentTo } = await connect([...partly, { table: 'incident', rows: [{ number: 'INC1', 'caller_id.email': 'a@example.org' }] }])
  assert.match((await call('sn_query', { table: 'incident', query: 'state=Resolved^caller_id.emailLIKEexample' })).data.message, /label of "6"/)
  assert.equal(sentTo('incident').length, 0)

  // A choice field reached by a dot-walk is not checked, and the answer says so.
  const walked = await connect([
    { table: 'sys_db_object', query: 'name=problem', rows: [tableRow('problem', 'Problem', 'task')] },
    { table: 'sys_dictionary', query: 'nameINproblem,task', rows: [column('task', 'state', 'integer', '', { choice: '3' }), column('problem', 'first_incident', 'reference', 'incident')] },
    ...dictionaryRoutes,
    { table: 'problem', rows: [] },
  ])
  const data = await walked.answer('sn_query', { table: 'problem', query: 'first_incident.state=Resolved' })
  assert.match(data.warnings.join(' '), /"first_incident.state" is a choice field, and its values could not be checked/)
})

test('an empty result is explained when a value has the wrong shape', async () => {
  const { answer } = await connect([...dictionaryRoutes, { table: 'incident', rows: [] }])

  const byName = await answer('sn_query', { table: 'incident', query: 'caller_id=Abel Tuter' })
  assert.equal(byName.total, 0)
  assert.match(byName.warnings.join(' '), /reference to sys_user.*does not look like one/)

  const odd = await answer('sn_query', { table: 'incident', query: 'state=42' })
  assert.match(odd.warnings.join(' '), /"42" is not among the choice values of "state".*1 \(New\), 6 \(Resolved\)/)

  const fine = await answer('sn_query', { table: 'incident', query: `caller_id=${ID}^state=6` })
  assert.deepEqual(fine.warnings, [])
})

test('sn_query counts rows per value of a field', async () => {
  const { answer, call, sentTo } = await connect([
    ...dictionaryRoutes,
    { table: 'incident', api: 'stats', rows: [
      { stats: { count: '8' }, groupby_fields: [{ field: 'state', value: '6', display_value: 'Resolved' }] },
      { stats: { count: '24' }, groupby_fields: [{ field: 'state', value: '1', display_value: 'New' }] },
      { stats: { count: '3' }, groupby_fields: [{ field: 'state', value: '', display_value: '' }] },
    ] },
  ])
  const data = await answer('sn_query', { table: 'incident', query: 'active=true', groupBy: 'state', limit: 2 })

  assert.deepEqual(data.groups, [{ value: '1', count: 24, display: 'New' }, { value: '6', count: 8, display: 'Resolved' }])
  assert.deepEqual({ total: data.total, returned: data.returned, truncated: data.truncated, groupBy: data.groupBy, records: data.records }, { total: 35, returned: 2, truncated: true, groupBy: 'state', records: [] })
  assert.equal(sentTo('incident', 'stats')[0].params.get('sysparm_group_by'), 'state')
  assert.equal(sentTo('incident', 'stats')[0].query, 'active=true')
  assert.equal(sentTo('incident').length, 0, 'no rows are read')

  // The Aggregate API ignores an unknown field as well, and would answer with one group of every row.
  assert.equal((await call('sn_query', { table: 'incident', groupBy: 'stat' })).data.error, 'validation')
  assert.equal((await call('sn_query', { table: 'sys_user', groupBy: 'user_password' })).data.error, 'validation')
})

test('fields that hold secrets are withheld', async () => {
  const user = { user_name: 'abel', user_password: '$s$hash', email: 'abel@example.org' }
  const { answer } = await connect([
    ...dictionaryRoutes,
    { table: 'sys_user', rows: [{ ...user, name: 'Abel' }] },
    { table: 'sys_db_object', query: 'name=sys_properties', rows: [tableRow('sys_properties', 'System Property')] },
    { table: 'sys_dictionary', query: 'nameINsys_properties', rows: [column('sys_properties', 'name'), column('sys_properties', 'value'), column('sys_properties', 'type')] },
    { table: 'sys_properties', query: 'name=glide.smtp.pw', rows: [{ name: 'glide.smtp.pw', value: labelled('ciphertext', '********'), type: labelled('password2', 'Password (2 Way Encrypted)') }] },
    { table: 'sys_properties', rows: [{ name: 'glide.smtp.pw', value: 'ciphertext', type: 'password2' }, { name: 'glide.war', value: 'glide-zurich', type: 'string' }] },
    { table: 'incident', rows: [{ number: 'INC1', 'caller_id.user_password': labelled('$s$hash', '********') }] },
  ])

  const named = await answer('sn_query', { table: 'sys_user', fields: ['name', 'user_password'] })
  assert.deepEqual(named.records, [{ name: 'Abel', user_password: '[withheld: this field holds a secret]' }])
  const all = await answer('sn_query', { table: 'sys_user' })
  assert.equal(all.records[0].user_password, '[withheld: this field holds a secret]')
  assert.match(all.warnings.join(' '), /user_password/)

  const walked = await answer('sn_query', { table: 'incident', fields: ['number', 'caller_id.user_password'], displayValue: true })
  assert.equal(walked.records[0]['caller_id.user_password'], '[withheld: this field holds a secret]')
  const shown = await answer('sn_query', { table: 'sys_properties', query: 'name=glide.smtp.pw', fields: ['name', 'value', 'type'], displayValue: true })
  assert.deepEqual(shown.records[0], { name: 'glide.smtp.pw', value: '[withheld: this field holds a secret]', type: { value: 'password2', display: 'Password (2 Way Encrypted)' } })

  const properties = await answer('sn_query', { table: 'sys_properties', fields: ['name', 'value'] })
  assert.deepEqual(properties.records, [{ name: 'glide.smtp.pw', value: '[withheld: this field holds a secret]' }, { name: 'glide.war', value: 'glide-zurich' }])
  assert.match(properties.warnings.join(' '), /1 system property was withheld/)
})

test('sn_query points out "^^" and fields the instance left out', async () => {
  const { answer } = await connect([...dictionaryRoutes, { table: 'incident', rows: [{ number: 'INC1' }] }])
  const data = await answer('sn_query', { table: 'incident', query: 'short_descriptionLIKEa^^b', fields: ['number', 'category'] })
  assert.match(data.warnings.join(' '), /literal \^ inside a value/)
  assert.match(data.warnings.join(' '), /left out the requested field\(s\) category/)
})

test('an unreadable table is an error that says "could not be checked"', async () => {
  const { call } = await connect([...dictionaryRoutes, { table: 'incident', status: 403 }])
  const { data, isError } = await call('sn_query', { table: 'incident' })
  assert.equal(isError, true)
  assert.equal(data.error, 'acl')
  assert.match(data.hint, /could not be checked/)
})

test('a table closed on this machine is never asked for', async () => {
  const { call, calls } = await connect(dictionaryRoutes, { tables: { allow: [], deny: ['sys_user'] } })
  const { data } = await call('sn_query', { table: 'sys_user' })
  assert.equal(data.error, 'blocked')
  assert.equal(calls.length, 0)
})

test('a closed table cannot be read through a dot-walk, a child table, a view or a display value', async () => {
  const view: Route[] = [
    { table: 'sys_db_object', query: 'name=incident_caller', rows: [] },
    { table: 'sys_db_view', query: 'name=incident_caller', rows: [{ sys_id: 'a'.repeat(32), name: 'incident_caller', label: 'Incident with caller' }] },
    { table: 'sys_db_view_table', rows: [{ table: 'incident', variable_prefix: 'inc' }, { table: 'sys_user', variable_prefix: 'usr' }] },
  ]
  const rows = [{ number: 'INC1', caller_id: labelled(ID, 'Abel Tuter'), assigned_to: labelled(ID, 'Beth Anglin') }]
  const routes = [...view, ...dictionaryRoutes, { table: 'incident', rows }, { table: 'incident_caller', rows: [{ inc_number: 'INC1' }] }, { table: 'task', rows: [{ number: 'TASK1' }] }]
  const noUsers = await connect(routes, { tables: { allow: [], deny: ['sys_user'] } })

  for (const args of [
    { table: 'incident', fields: ['number', 'caller_id.email'] },
    { table: 'incident', query: 'caller_id.emailLIKEexample' },
    { table: 'incident', query: 'ORDERBYcaller_id.name' },
    { table: 'incident', groupBy: 'caller_id.email' },
    { table: 'incident_caller', fields: ['inc_number'] },
    { table: 'incident_caller' },
  ]) {
    const { data } = await noUsers.call('sn_query', args)
    assert.equal(data.error, 'blocked', JSON.stringify(args))
    assert.match(data.message, /sys_user/)
  }
  assert.equal(noUsers.sentTo('incident').length + noUsers.sentTo('incident_caller').length, 0)

  // The reference itself may be read. The name behind it comes from the closed table and is left out.
  const data = await noUsers.answer('sn_query', { table: 'incident', fields: ['number', 'caller_id'], displayValue: true })
  assert.deepEqual(data.records, [{ number: 'INC1', caller_id: ID }])
  assert.match(data.warnings.join(' '), /closed on this machine were left out: caller_id/)
  const all = await noUsers.answer('sn_query', { table: 'incident', displayValue: true })
  assert.deepEqual({ caller: all.records[0].caller_id, assignee: all.records[0].assigned_to }, { caller: ID, assignee: ID })

  const noIncident = await connect(routes, { tables: { allow: [], deny: ['incident'] } })
  assert.equal((await noIncident.call('sn_query', { table: 'task', query: 'ref_incident.caller_id=x' })).data.error, 'blocked')
  assert.equal((await noIncident.answer('sn_query', { table: 'task', fields: ['number'] })).returned, 1)

  // With tables closed, a query whose reach cannot be established is not sent.
  const blind = await connect([{ table: 'sys_db_object', status: 403 }, { table: 'incident', rows }], { tables: { allow: [], deny: ['sys_user'] } })
  assert.equal((await blind.call('sn_query', { table: 'incident', fields: ['number'] })).data.error, 'blocked')
  assert.equal(blind.sentTo('incident').length, 0)
})

test('a closed table gives away no names through a list of references, an unknown field type, or a hint', async () => {
  const closed = { tables: { allow: [], deny: ['sys_user'] } }
  const rows = [{ number: 'INC1', caller_id: labelled(ID, 'Abel Tuter'), watch_list: labelled(`${ID},${ID}`, 'Abel Tuter, Beth Anglin') }]
  const noUsers = await connect([...dictionaryRoutes, { table: 'incident', rows }, stats('incident', { [ID]: 1 })], closed)

  // A watch list holds references too: its display value is a list of names from the closed table.
  const listed = await noUsers.answer('sn_query', { table: 'incident', fields: ['number', 'watch_list'], displayValue: true })
  assert.deepEqual(listed.records, [{ number: 'INC1', watch_list: `${ID},${ID}` }])
  assert.match(listed.warnings.join(' '), /closed on this machine were left out: watch_list/)
  await noUsers.answer('sn_query', { table: 'incident', groupBy: 'watch_list' })
  assert.equal(noUsers.sentTo('incident', 'stats')[0].params.get('sysparm_display_value'), null, 'the groups are not asked for their names')

  // "Starts with A" on the reference compares with the names in the closed table, and a sort orders the rows by them.
  for (const query of ['caller_idSTARTSWITHAb', 'caller_idLIKEbel', 'watch_listLIKEAbel', 'ORDERBYcaller_id', 'active=true^ORDERBYDESCassigned_to', 'numberGT_FIELDcaller_id']) {
    const refused = await noUsers.call('sn_query', { table: 'incident', query, fields: ['number'] })
    assert.equal(refused.data.error, 'blocked', query)
    assert.match(refused.data.message, /found out by trying/, query)
  }
  // Compared with a sys_id, or asked whether it is filled, the reference gives nothing away.
  for (const query of [`caller_id=${ID}`, `caller_idIN${ID}`, 'caller_idISEMPTY', 'assigned_toSAMEAScaller_id']) {
    assert.equal((await noUsers.answer('sn_query', { table: 'incident', query, fields: ['number'] })).returned, 1, query)
  }

  // A misspelled field behind the reference: the refusal comes first, and names no field of the closed table.
  const { data } = await noUsers.call('sn_query', { table: 'incident', query: 'caller_id.user_passwrd=x' })
  assert.equal(data.error, 'blocked')
  assert.doesNotMatch(data.message, /similar|user_password/)

  // The types of the fields cannot be read: it is not known which of them point into the closed table.
  const untyped = await connect([{ table: 'sys_dictionary', query: 'nameINincident,task', status: 403 }, ...dictionaryRoutes, { table: 'incident', rows }], closed)
  const all = await untyped.answer('sn_query', { table: 'incident', displayValue: true })
  assert.deepEqual(all.records, [{ number: 'INC1', caller_id: ID, watch_list: `${ID},${ID}` }])
  assert.match(all.warnings.join(' '), /could not be told which table these fields point to, so their display values were left out: caller_id, watch_list/)
})

test('journal fields: a condition on one is refused, and an empty value is explained', async () => {
  // Measured: the entries are in sys_journal_field. "Is empty" and "is not empty" on the field return the same rows.
  const withNotes: Route[] = [
    { table: 'sys_dictionary', query: 'nameINincident,task', rows: [column('task', 'number'), column('task', 'work_notes', 'journal_input'), column('task', 'comments_and_work_notes', 'journal_list')] },
    ...dictionaryRoutes,
    { table: 'incident', rows: [{ number: 'INC1', work_notes: labelled('', '2026-03-01 10:00:00 - Abel (Work notes)\nRestarted the service') }] },
  ]
  const { answer, call, sentTo } = await connect(withNotes)

  for (const query of ['work_notesISEMPTY', 'work_notesISNOTEMPTY', 'work_notesLIKErestart', 'ORDERBYwork_notes', 'comments_and_work_notesLIKEx']) {
    const { data } = await call('sn_query', { table: 'incident', query, fields: ['number'] })
    assert.equal(data.error, 'validation', query)
    assert.match(data.message, /is a journal field.*Query sys_journal_field instead, for example element=(work_notes|comments_and_work_notes)\^valueLIKE/, query)
  }
  assert.equal(sentTo('incident').length, 0)

  const empty = await answer('sn_query', { table: 'incident', fields: ['number', 'work_notes'] })
  assert.deepEqual(empty.records, [{ number: 'INC1', work_notes: '' }])
  assert.match(empty.warnings.join(' '), /work_notes: a journal field comes back empty unless displayValue is true/)

  const shown = await answer('sn_query', { table: 'incident', fields: ['number', 'work_notes'], displayValue: true })
  assert.match(shown.records[0].work_notes.display, /Restarted the service/)
  assert.deepEqual(shown.warnings, [])
})

test('a field to count by that cannot be verified is not sent', async () => {
  // No dictionary, and no visible row to check the name against: an ignored field would give one group of all rows.
  const { call, sentTo } = await connect([{ table: 'sys_db_object', status: 403 }, { table: 'incident', rows: [null], total: 35 }, stats('incident', { '': 35 })])
  const { data } = await call('sn_query', { table: 'incident', groupBy: 'stat' })
  assert.equal(data.error, 'acl')
  assert.match(data.message, /could not be verified/)
  assert.equal(sentTo('incident', 'stats').length, 0)
})

test('sn_query says what it could not check about choices, and what "is not" leaves out', async () => {
  // Without the dictionary nothing says that "state" is a choice field.
  const blind = await connect([{ table: 'sys_db_object', status: 403 }, { table: 'incident', rows: [{ number: 'INC1', state: '1' }] }])
  const unchecked = await blind.answer('sn_query', { table: 'incident', query: 'state=Resolved', fields: ['number'] })
  assert.match(unchecked.warnings.join(' '), /could not be checked whether state is a choice field/)

  // Some of the choices are hidden from the account: a label among them would not be recognised.
  const partial = await connect([{ table: 'sys_choice', query: 'element=state', rows: [{ name: 'incident', value: '1', label: 'New' }, null] }, ...dictionaryRoutes, { table: 'incident', rows: [] }])
  const hidden = await partial.answer('sn_query', { table: 'incident', query: 'state=Resolved' })
  assert.match(hidden.warnings.join(' '), /"state" is a choice field, and its values could not be checked/)

  // Measured: "is not" leaves out rows where the field is empty. A boolean is never empty, and "!=" without a value means "is not empty".
  const { answer } = await connect([...dictionaryRoutes, { table: 'incident', rows: [{ number: 'INC1' }] }])
  const data = await answer('sn_query', { table: 'incident', query: `assigned_to!=${ID}^active!=true^category!=^short_descriptionNOT LIKEtest` })
  assert.match(data.warnings.join(' '), /leave out rows where the field is empty \(assigned_to, short_description\)\. To count those rows too, add \^ORassigned_toISEMPTY/)
  assert.deepEqual((await answer('sn_query', { table: 'incident', query: 'active!=true^category!=' })).warnings, [])
})

test('an empty result on a database view is explained from the choices of the table behind it', async () => {
  const { answer } = await connect([
    { table: 'sys_db_object', query: 'name=incident_caller', rows: [] },
    { table: 'sys_db_view', query: 'name=incident_caller', rows: [{ sys_id: 'a'.repeat(32), name: 'incident_caller', label: 'Incident with caller' }] },
    { table: 'sys_db_view_table', rows: [{ table: 'incident', variable_prefix: 'inc' }, { table: 'sys_user', variable_prefix: 'usr' }] },
    ...dictionaryRoutes,
    { table: 'incident_caller', rows: [] },
  ])
  const data = await answer('sn_query', { table: 'incident_caller', query: 'inc_state=42' })
  assert.match(data.warnings.join(' '), /"42" is not among the choice values of "inc_state".*1 \(New\), 6 \(Resolved\)/)
})

test('where field types cannot be read, a secret is recognised by its name, and the answer says so', async () => {
  const user = { name: 'Abel', user_password: '$s$hash', u_api_token: 'tok', email: 'abel@example.org' }

  // The dictionary hides rows from this account: the entry of user_password is not among those it returns.
  const partial = await connect([
    { table: 'sys_dictionary', query: 'nameINsys_user', rows: [column('sys_user', 'name'), column('sys_user', 'email')], total: 4 },
    ...dictionaryRoutes,
    { table: 'sys_user', rows: [user] },
  ])
  const named = await partial.answer('sn_query', { table: 'sys_user', fields: ['name', 'user_password'] })
  assert.deepEqual(named.records, [{ name: 'Abel', user_password: '[withheld: this field holds a secret]' }])
  assert.match(named.warnings.join(' '), /name suggests a secret: user_password/)
  const whole = await partial.answer('sn_query', { table: 'sys_user' })
  assert.deepEqual(whole.records, [{ name: 'Abel', user_password: '[withheld: this field holds a secret]', u_api_token: '[withheld: this field holds a secret]', email: 'abel@example.org' }])
  assert.match(whole.warnings.join(' '), /recognised by its name only/)

  // No dictionary at all.
  const none = await connect([{ table: 'sys_db_object', status: 403 }, { table: 'sys_user', rows: [user] }])
  assert.equal((await none.answer('sn_query', { table: 'sys_user' })).records[0].user_password, '[withheld: this field holds a secret]')

  // A system property whose type the instance does not return.
  const untyped = await connect([
    { table: 'sys_db_object', query: 'name=sys_properties', rows: [tableRow('sys_properties', 'System Property')] },
    { table: 'sys_dictionary', query: 'nameINsys_properties', rows: [column('sys_properties', 'name'), column('sys_properties', 'value'), column('sys_properties', 'type')] },
    ...dictionaryRoutes,
    { table: 'sys_properties', rows: [{ name: 'glide.smtp.password', value: 'ciphertext' }, { name: 'glide.war', value: 'glide-zurich' }] },
  ])
  const properties = await untyped.answer('sn_query', { table: 'sys_properties', fields: ['name', 'value'] })
  assert.deepEqual(properties.records.map((row: Data) => row.value), ['[withheld: this field holds a secret]', 'glide-zurich'])
  assert.match(properties.warnings.join(' '), /its type did not come back, and its name suggests a secret/)
})

test('a system property is withheld when nothing says whether it holds a secret', async () => {
  const dictionary: Route[] = [
    { table: 'sys_db_object', query: 'name=sys_properties', rows: [tableRow('sys_properties', 'System Property')] },
    { table: 'sys_dictionary', query: 'nameINsys_properties', rows: [column('sys_properties', 'name'), column('sys_properties', 'value'), column('sys_properties', 'type')] },
    ...dictionaryRoutes,
  ]

  // Only the value was asked for: type and name are read along to judge it, and are not passed on.
  const typed = await connect([...dictionary, { table: 'sys_properties', rows: [{ name: 'glide.smtp.pw', value: 'ciphertext', type: 'password2' }, { name: 'glide.war', value: 'glide-zurich', type: 'string' }] }])
  const judged = await typed.answer('sn_query', { table: 'sys_properties', fields: ['value'] })
  assert.deepEqual(judged.records, [{ value: '[withheld: this field holds a secret]' }, { value: 'glide-zurich' }])
  assert.equal(typed.sentTo('sys_properties')[0].params.get('sysparm_fields'), 'value,type,name')

  // An empty type says nothing: then the name decides.
  const empty = await connect([...dictionary, { table: 'sys_properties', rows: [{ name: 'glide.smtp.password', value: 'ciphertext', type: '' }, { name: 'glide.war', value: 'glide-zurich', type: '' }] }])
  assert.deepEqual((await empty.answer('sn_query', { table: 'sys_properties', fields: ['value'] })).records, [{ value: '[withheld: this field holds a secret]' }, { value: 'glide-zurich' }])

  // Neither type nor name comes back, as when access rules hide both fields.
  const bare = await connect([...dictionary, { table: 'sys_properties', rows: [{ value: 'ciphertext' }] }])
  const nothing = await bare.answer('sn_query', { table: 'sys_properties', query: 'name=glide.smtp.pw', fields: ['value'] })
  assert.deepEqual(nothing.records, [{ value: '[withheld: this field holds a secret]' }])
  assert.match(nothing.warnings.join(' '), /neither type nor name came back/)
})

test('a field that holds a secret can be asked whether it is filled, and nothing else', async () => {
  const { answer, call, sentTo } = await connect([...dictionaryRoutes, { table: 'sys_user', rows: [{ name: 'Abel' }] }, { table: 'incident', rows: [] }])

  // "Starts with a", "starts with b": the number of matches would give the value away piece by piece.
  for (const query of ['user_passwordSTARTSWITH$s$a', 'user_password=x', 'name=Abel^ORuser_passwordLIKEa', 'ORDERBYuser_password', 'emailSAMEASuser_password']) {
    const { data } = await call('sn_query', { table: 'sys_user', query, fields: ['name'] })
    assert.equal(data.error, 'validation', query)
    assert.match(data.message, /holds a secret/, query)
  }
  assert.equal((await call('sn_query', { table: 'incident', query: 'caller_id.user_passwordSTARTSWITHa' })).data.error, 'validation')
  assert.equal(sentTo('sys_user').length + sentTo('incident').length, 0)

  assert.equal((await answer('sn_query', { table: 'sys_user', query: 'user_passwordISNOTEMPTY', fields: ['name'] })).returned, 1)

  // Where the type cannot be read, the name decides.
  const blind = await connect([{ table: 'sys_db_object', status: 403 }, { table: 'sys_user', rows: [{ name: 'Abel', u_api_token: 'tok' }] }])
  const refused = await blind.call('sn_query', { table: 'sys_user', query: 'u_api_tokenSTARTSWITHa' })
  assert.equal(refused.data.error, 'validation')
  assert.match(refused.data.message, /judged by its name/)
  assert.equal(blind.sentTo('sys_user').length, 0)
})

test('the values of system properties that hold secrets cannot be found out by trying', async () => {
  const LEFT_OUT = 'typeNOT INpassword,password2'
  const { answer, call, sentTo } = await connect([
    { table: 'sys_db_object', query: 'name=sys_properties', rows: [tableRow('sys_properties', 'System Property')] },
    { table: 'sys_dictionary', query: 'nameINsys_properties', rows: [column('sys_properties', 'name'), column('sys_properties', 'value'), column('sys_properties', 'type')] },
    ...dictionaryRoutes,
    { table: 'sys_properties', rows: [{ name: 'glide.war', value: 'glide-zurich', type: 'string' }] },
    stats('sys_properties', { string: 3 }),
  ])

  // A condition on the value, or a sort by it: the properties of type password are taken out, in every part of the query.
  const found = await answer('sn_query', { table: 'sys_properties', query: 'valueLIKEzurich^NQname=glide.war^ORDERBYvalue', fields: ['name', 'value'] })
  const sent = `valueLIKEzurich^${LEFT_OUT}^NQname=glide.war^ORDERBYvalue^${LEFT_OUT}`
  assert.equal(sentTo('sys_properties')[0].query, sent)
  assert.equal(found.query, sent)
  assert.match(found.warnings.join(' '), /Properties that hold a secret \(type password or password2\) and properties without a type were left out/)

  // Nothing compares the value: the query goes out as written. Asking whether it is filled compares nothing.
  await answer('sn_query', { table: 'sys_properties', query: 'name=glide.war', fields: ['name', 'value'] })
  await answer('sn_query', { table: 'sys_properties', query: 'valueISEMPTY', fields: ['name'] })
  assert.deepEqual(sentTo('sys_properties').slice(1).map((entry) => entry.query), ['name=glide.war', 'valueISEMPTY'])

  // Listed as groups, every value would be in the answer.
  const grouped = await call('sn_query', { table: 'sys_properties', groupBy: 'value' })
  assert.equal(grouped.data.error, 'validation')
  assert.match(grouped.data.message, /not listed as groups/)
  // Counted by another field, a condition on the value is treated like any other.
  await answer('sn_query', { table: 'sys_properties', query: 'valueLIKEa', groupBy: 'type' })
  assert.equal(sentTo('sys_properties', 'stats')[0].query, `valueLIKEa^${LEFT_OUT}`)
})

test('through a database view the value of a system property can be neither compared nor counted', async () => {
  const view: Route[] = [
    { table: 'sys_db_object', query: 'name=u_property_view', rows: [] },
    { table: 'sys_db_view', query: 'name=u_property_view', rows: [{ sys_id: 'b'.repeat(32), name: 'u_property_view', label: 'Properties' }] },
    { table: 'sys_db_view_table', rows: [{ table: 'sys_properties', variable_prefix: 'prop' }] },
    { table: 'sys_db_object', query: 'name=sys_properties', rows: [tableRow('sys_properties', 'System Property')] },
  ]
  const rows = [{ prop_name: 'glide.smtp.pw', prop_value: 'ciphertext' }]
  const { call, sentTo } = await connect([...view, { table: 'sys_dictionary', query: 'nameINsys_properties', rows: [column('sys_properties', 'name'), column('sys_properties', 'value')] }, ...dictionaryRoutes, { table: 'u_property_view', rows }])

  for (const args of [{ query: 'prop_valueLIKEa' }, { query: 'ORDERBYprop_value' }, { groupBy: 'prop_value' }]) {
    const { data } = await call('sn_query', { table: 'u_property_view', ...args })
    assert.equal(data.error, 'validation', JSON.stringify(args))
    assert.match(data.message, /value of a system property/)
  }
  assert.equal(sentTo('u_property_view').length, 0)

  // The definition of the view says which field is the value, also where the dictionary of sys_properties is not readable.
  const blind = await connect([...view, { table: 'sys_dictionary', status: 403 }, ...dictionaryRoutes, { table: 'u_property_view', rows }])
  const data = await blind.answer('sn_query', { table: 'u_property_view' })
  assert.deepEqual(data.records, [{ prop_name: 'glide.smtp.pw', prop_value: '[withheld: this field holds a secret]' }])
})

test('the value of a system property is withheld when it is read through a database view', async () => {
  const { answer } = await connect([
    { table: 'sys_db_object', query: 'name=u_property_view', rows: [] },
    { table: 'sys_db_view', query: 'name=u_property_view', rows: [{ sys_id: 'b'.repeat(32), name: 'u_property_view', label: 'Properties' }] },
    { table: 'sys_db_view_table', rows: [{ table: 'sys_properties', variable_prefix: 'prop' }] },
    { table: 'sys_db_object', query: 'name=sys_properties', rows: [tableRow('sys_properties', 'System Property')] },
    { table: 'sys_dictionary', query: 'nameINsys_properties', rows: [column('sys_properties', 'name'), column('sys_properties', 'value')] },
    ...dictionaryRoutes,
    { table: 'u_property_view', rows: [{ prop_name: 'glide.smtp.pw', prop_value: 'ciphertext' }] },
  ])
  const data = await answer('sn_query', { table: 'u_property_view', fields: ['prop_name', 'prop_value'] })
  assert.deepEqual(data.records, [{ prop_name: 'glide.smtp.pw', prop_value: '[withheld: this field holds a secret]' }])
})

// --------------------------------------------------------------- sn_schema

test('sn_schema reads a database view and the tables it joins anew, and each part once', async () => {
  const { answer, calls, sentTo } = await connect([
    { table: 'sys_db_object', query: 'name=incident_caller', rows: [] },
    { table: 'sys_db_view', query: 'name=incident_caller', rows: [{ sys_id: 'a'.repeat(32), name: 'incident_caller', label: 'Incident with caller' }] },
    { table: 'sys_db_view_table', rows: [{ table: 'incident', variable_prefix: 'inc' }, { table: 'sys_user', variable_prefix: 'usr' }] },
    ...dictionaryRoutes,
    { table: 'incident', rows: [{ number: 'INC1' }] },
  ])
  // Something else has read the joined table before.
  await answer('sn_query', { table: 'incident', query: 'active=true', fields: ['number'] })

  const before = calls.length
  await answer('sn_schema', { table: 'incident_caller' })
  const first = calls.slice(before).map((entry) => `${entry.table} ${entry.query}`)
  assert.equal(new Set(first).size, first.length, 'no request is sent twice within one call')
  assert.ok(first.some((entry) => entry.startsWith('sys_dictionary nameINincident,task')), 'the fields of the joined table are read again')

  const between = calls.length
  await answer('sn_schema', { table: 'incident_caller' })
  assert.deepEqual(calls.slice(between).map((entry) => `${entry.table} ${entry.query}`), first, 'the next call reads all of it again')
  assert.equal(sentTo('sys_db_view').length, 2)
})

test('sn_schema returns the fields that apply to the table, inherited ones included', async () => {
  const { answer } = await connect(dictionaryRoutes)
  const all = await answer('sn_schema', { table: 'incident' })

  assert.deepEqual(all.table, { name: 'incident', label: 'Incident', kind: 'table', extends: ['task'] })
  assert.equal(all.fieldCount, 9)
  assert.equal(all.ownFieldCount, 2)
  assert.equal(all.returned, 9)
  assert.deepEqual(all.columns.find((item: Data) => item.name === 'number'), { name: 'number', label: 'number', type: 'string', definedOn: 'task', maxLength: 40 })
  assert.deepEqual(all.columns.find((item: Data) => item.name === 'state'), { name: 'state', label: 'state', type: 'integer', definedOn: 'task', maxLength: 40, choice: true })
  assert.deepEqual(all.warnings, [])
})

test('sn_schema finds a field by part of its name, and says what "own fields only" leaves out', async () => {
  const { answer } = await connect(dictionaryRoutes)
  const found = await answer('sn_schema', { table: 'incident', filter: 'assign' })
  assert.deepEqual(found.columns.map((item: Data) => `${item.name} on ${item.definedOn}`), ['assigned_to on task'])

  const own = await answer('sn_schema', { table: 'incident', includeInherited: false })
  assert.deepEqual(own.columns.map((item: Data) => item.name), ['caller_id', 'category'])
  assert.match(own.warnings.join(' '), /7 inherited field\(s\) are left out/)
})

test('sn_schema is honest about a table it cannot describe', async () => {
  const missing = await connect(dictionaryRoutes)
  assert.equal((await missing.call('sn_schema', { table: 'no_such_table' })).data.error, 'not_found')

  const partial = await connect(dictionaryRoutes.map((route) => (route.query === 'nameINincident,task' ? { ...route, total: 40 } : route)))
  assert.match((await partial.answer('sn_schema', { table: 'incident' })).warnings.join(' '), /only partly readable/)
})

test('sn_schema describes database views and remote tables, and says what it could not read', async () => {
  const { answer } = await connect([
    { table: 'sys_db_object', query: 'name=incident_sla', rows: [] },
    { table: 'sys_db_view', query: 'name=incident_sla', rows: [{ sys_id: 'a'.repeat(32), name: 'incident_sla', label: 'Incident SLA' }] },
    { table: 'sys_db_view_table', rows: [{ table: 'incident', variable_prefix: 'inc' }, { table: 'sys_user', variable_prefix: 'usr' }] },
    { table: 'sys_db_object', query: 'name=v_remote', rows: [{ ...tableRow('v_remote', 'Remote'), scriptable_table: 'true' }] },
    { table: 'sys_dictionary', query: 'nameINv_remote', rows: Array.from({ length: 500 }, (_, index) => column('v_remote', `f_${String(index).padStart(3, '0')}`, 'string', '', { column_label: 'x'.repeat(120) })) },
    { table: 'sys_dictionary_override', query: 'nameINv_remote', status: 403 },
    ...dictionaryRoutes,
  ])

  const view = await answer('sn_schema', { table: 'incident_sla', filter: 'email' })
  assert.deepEqual(view.table, { name: 'incident_sla', label: 'Incident SLA', kind: 'database_view', extends: [], joins: [{ table: 'incident', prefix: 'inc' }, { table: 'sys_user', prefix: 'usr' }] })
  assert.deepEqual(view.columns.map((item: Data) => `${item.name} from ${item.definedOn}`), ['usr_email from sys_user'])

  const remote = await answer('sn_schema', { table: 'v_remote' })
  assert.equal(remote.table.kind, 'remote_table')
  assert.equal(remote.fieldCount, 500)
  assert.ok(remote.returned < 500)
  const warnings = remote.warnings.join(' ')
  assert.match(warnings, /remote table/)
  assert.match(warnings, /sys_dictionary_override could not be read completely/)
  assert.match(warnings, new RegExp(`Only the first ${remote.returned} of 500 fields`))
})

// --------------------------------------------------------------- sn_origin

const file = (packageClass: string, extra: Data = {}) => ({
  sys_id: ID,
  sys_class_name: 'sys_script',
  sys_name: 'Example rule',
  sys_update_name: NAME,
  sys_package: labelled('p1', 'Example package'),
  'sys_package.sys_class_name': packageClass,
  sys_scope: labelled('s1', 'Example scope'),
  sys_policy: '',
  sys_created_on: '2020-01-01 00:00:00',
  sys_created_by: 'vendor.dev',
  sys_updated_on: '2026-03-01 10:00:00',
  sys_updated_by: 'abel',
  ...extra,
})
const change = (extra: Data = {}) => ({
  name: NAME,
  action: 'INSERT_OR_UPDATE',
  type: 'Business Rule',
  update_set: labelled('s1', 'Default'),
  sys_created_by: 'abel',
  sys_created_on: '2026-03-01 10:00:00',
  sys_updated_by: 'abel',
  sys_updated_on: '2026-03-01 10:00:00',
  ...extra,
})
const version = (state: string, source_table: string, sys_created_on: string, sys_created_by = 'system') => ({ state, source_table, source: '', sys_created_on, sys_created_by })

const skip = (disposition: string, review = 'Not Reviewed') => ({
  'upgrade_detail.disposition': labelled('10', disposition),
  'upgrade_detail.target_name': 'Example rule',
  'upgrade_detail.upgrade_history.to_version': 'glide-australia-02-11-2026__patch1.zip',
  state: labelled('1', review),
  sys_created_on: '2026-09-25 17:00:00',
})

function origin(packageClass: string | null, changes: Data[], versions: Data[], fileExtra: Data = {}, skips: Data[] = []): Route[] {
  const bySource: Record<string, number> = {}
  for (const item of versions) bySource[item.source_table] = (bySource[item.source_table] ?? 0) + 1
  return [
    { table: 'sys_metadata', rows: packageClass === null ? [] : [file(packageClass, fileExtra)] },
    { table: 'sys_update_xml', rows: changes },
    { table: 'sys_update_version', rows: versions },
    stats('sys_update_version', bySource),
    { table: 'upgrade_history_task', query: 'upgrade_detail.file_name=', rows: skips },
  ]
}

test('sn_origin: a delivered record without a customer change is out-of-the-box as far as captured', async () => {
  const { answer, calls } = await connect(origin('sys_plugins', [], []))
  const data = await answer('sn_origin', { sysId: ID })

  assert.equal(data.verdict, 'out_of_box_as_captured')
  assert.equal(data.provenance, 'vendor')
  assert.equal(data.divergence, 'no_customer_changes_captured')
  assert.equal(data.capturedBy, 'nobody')
  assert.equal(data.record.package, 'Example package')
  assert.equal(data.record.updateName, NAME)
  assert.ok(data.caveats.length > 0)
  assert.equal(calls.length, 5)
})

test('sn_origin: a change nobody captured shows when an upgrade refused to overwrite the record', async () => {
  const { answer } = await connect(origin('sys_plugins', [], [], {}, [skip('Skipped Manual Merge')]))
  const data = await answer('sn_origin', { sysId: ID })

  assert.equal(data.divergence, 'changed_without_capture')
  assert.equal(data.verdict, 'customized')
  assert.equal(data.capturedBy, 'nobody')
  assert.match(data.warnings.join(' '), /did not overwrite it \("Skipped Manual Merge"\)/)
  assert.deepEqual(data.evidence.upgradeSkips.rows[0], { disposition: 'Skipped Manual Merge', review: 'Not Reviewed', target: 'Example rule', upgrade: 'glide-australia-02-11-2026__patch1.zip', createdOn: '2026-09-25 17:00:00' })
  assert.equal(data.evidence.upgradeSkips.query, `upgrade_detail.file_name=${NAME}^ORDERBYDESCsys_created_on`)

  // A file the upgrade could not apply is a failure, and a reverted one is the vendor's again: neither is a local change.
  for (const row of [skip('Skipped Error'), skip('Skipped', 'Reviewed and Reverted')]) {
    const other = await connect(origin('sys_plugins', [], [], {}, [row]))
    assert.equal((await other.answer('sn_origin', { sysId: ID })).verdict, 'out_of_box_as_captured')
  }
})

test('sn_origin: a delivered record with a customer change is customized', async () => {
  const { answer } = await connect(origin('sys_plugins', [change()], [version('current', 'sys_update_set', '2026-03-01 10:00:00', 'abel'), version('previous', 'sys_upgrade_history', '2026-03-01 09:59:59')]))
  const data = await answer('sn_origin', { sysId: ID })

  assert.equal(data.verdict, 'customized')
  assert.equal(data.created, 'delivered')
  assert.equal(data.capturedBy, 'people')
  assert.deepEqual(data.evidence.versions.bySource, { sys_update_set: 1, sys_upgrade_history: 1 })
  assert.equal(data.evidence.versions.current.source_table, 'sys_update_set')
  assert.deepEqual(data.warnings, [])
})

test('sn_origin: the evidence can be run again', async () => {
  const { answer } = await connect(origin('sys_plugins', [change()], []))
  const { evidence } = await answer('sn_origin', { sysId: ID })
  assert.deepEqual(
    { table: evidence.customerUpdates.table, query: evidence.customerUpdates.query, total: evidence.customerUpdates.total, first: evidence.customerUpdates.firstCapturedOn },
    { table: 'sys_update_xml', query: `name=${NAME}^ORDERBYDESCsys_updated_on`, total: 1, first: '2026-03-01 10:00:00' },
  )
  assert.equal(evidence.versions.table, 'sys_update_version')
  assert.equal(evidence.versions.query, `name=${NAME}^ORDERBYstate^ORDERBYDESCsys_created_on`)
})

test('sn_origin: with more update rows than one page, the first capture is asked for', async () => {
  const many = Array.from({ length: 20 }, (_, index) => change({ sys_created_on: `2026-03-${String(index + 2).padStart(2, '0')} 00:00:00` }))
  const routes = origin('sys_store_app', many, [version('current', 'sys_update_set', '2026-03-21 00:00:00', 'abel')], { sys_created_on: '2026-03-01 00:00:00' })
  const { answer, sentTo } = await connect([
    { table: 'sys_update_xml', query: 'ORDERBYsys_created_on', rows: [{ sys_created_on: '2026-03-01 00:00:00' }] },
    { table: 'sys_update_xml', rows: many, total: 25 },
    ...routes,
  ])
  const data = await answer('sn_origin', { sysId: ID })

  assert.equal(data.evidence.customerUpdates.firstCapturedOn, '2026-03-01 00:00:00')
  assert.equal(data.created, 'here')
  assert.equal(data.verdict, 'customer_created')
  assert.ok(sentTo('sys_update_xml').some((entry) => entry.query === `name=${NAME}^ORDERBYsys_created_on`))
})

test('sn_origin abstains when the versions cannot be counted', async () => {
  // More versions than one page shows, and the Aggregate API does not answer: a customer's version cannot be ruled out.
  const many = [version('current', 'sys_upgrade_history', '2026-03-01 00:00:00'), ...Array.from({ length: 13 }, () => version('previous', 'sys_upgrade_history', '2025-03-01 00:00:00'))]
  const { answer } = await connect([
    { table: 'sys_metadata', rows: [file('sys_plugins')] },
    { table: 'sys_update_xml', rows: [] },
    { table: 'sys_update_version', rows: many },
    { table: 'sys_update_version', api: 'stats', status: 403 },
  ])
  const data = await answer('sn_origin', { sysId: ID })
  assert.deepEqual({ verdict: data.verdict, divergence: data.divergence, bySource: data.evidence.versions.bySource }, { verdict: 'unknown', divergence: 'unknown', bySource: null })
  assert.match(data.warnings.join(' '), /Aggregate API/)

  // A changed record of a platform package, created at its first capture: without the count "created here" cannot be
  // ruled out, and that such records are rare is no argument.
  const changed = await connect([
    { table: 'sys_metadata', rows: [file('sys_plugins', { sys_created_on: '2026-03-01 10:00:00' })] },
    { table: 'sys_update_xml', rows: [change()] },
    { table: 'sys_update_version', rows: many },
    { table: 'sys_update_version', api: 'stats', status: 403 },
  ])
  assert.equal((await changed.answer('sn_origin', { sysId: ID })).verdict, 'unknown')
})

test('sn_origin counts the versions itself when one page holds them all', async () => {
  const { answer } = await connect([
    { table: 'sys_metadata', rows: [file('sys_plugins')] },
    { table: 'sys_update_xml', rows: [] },
    { table: 'sys_update_version', rows: [version('current', 'sys_upgrade_history', '2026-03-01 00:00:00')] },
    { table: 'sys_update_version', api: 'stats', status: 403 },
  ])
  const data = await answer('sn_origin', { sysId: ID })
  assert.deepEqual({ verdict: data.verdict, bySource: data.evidence.versions.bySource }, { verdict: 'out_of_box_as_captured', bySource: { sys_upgrade_history: 1 } })
  assert.deepEqual(data.warnings, [])
})

test('sn_origin: a record created inside an installed application is customer-created, not customized', async () => {
  const createdAtCapture = { sys_created_on: '2026-03-01 10:00:00', sys_created_by: 'abel' }
  const { answer } = await connect(origin('sys_store_app', [change()], [version('current', 'sys_update_set', '2026-03-01 10:00:00', 'abel')], createdAtCapture))
  const data = await answer('sn_origin', { sysId: ID })
  assert.equal(data.provenance, 'installed_application')
  assert.equal(data.created, 'here')
  assert.equal(data.verdict, 'customer_created')

  // The same record, but older than its first captured change: it was delivered and then changed.
  const older = await connect(origin('sys_store_app', [change()], [version('current', 'sys_update_set', '2026-03-01 10:00:00', 'abel')]))
  const delivered = await older.answer('sn_origin', { sysId: ID })
  assert.equal(delivered.created, 'delivered')
  assert.equal(delivered.verdict, 'customized')
})

test('sn_origin: an earlier change that an upgrade replaced does not count as customized', async () => {
  const versions = [version('current', 'sys_upgrade_history', '2026-09-25 17:11:41'), version('previous', 'sys_update_set', '2026-06-05 22:06:12', 'someone@snc.maint')]
  const { answer } = await connect(origin('sys_plugins', [], versions))
  const data = await answer('sn_origin', { sysId: ID })

  assert.equal(data.verdict, 'out_of_box_as_captured')
  assert.equal(data.divergence, 'no_customer_changes_captured')
  assert.match(data.warnings.join(' '), /1 earlier version\(s\) came from update sets/)
})

test('sn_origin: a current version from an update set counts, even without an update row', async () => {
  const { answer } = await connect(origin('sys_plugins', [], [version('current', 'sys_update_set', '2026-03-01 10:00:00', 'abel')]))
  const data = await answer('sn_origin', { sysId: ID })
  assert.equal(data.divergence, 'customer_changes_captured')
  assert.equal(data.verdict, 'customized')
  assert.match(data.warnings.join(' '), /no customer update row exists/)
})

test('sn_origin abstains inside an installed application when it cannot tell "created here" from "delivered"', async () => {
  // A current version from an update set, no update row to date the first change, no vendor version.
  const undecided = await connect(origin('sys_store_app', [], [version('current', 'sys_update_set', '2026-03-01 10:00:00', 'abel')]))
  const data = await undecided.answer('sn_origin', { sysId: ID })
  assert.deepEqual({ divergence: data.divergence, created: data.created, verdict: data.verdict }, { divergence: 'customer_changes_captured', created: 'unknown', verdict: 'unknown' })

  // Versions that cannot be counted: a vendor version of a global record cannot be ruled out.
  const uncounted = await connect([
    { table: 'sys_metadata', rows: [file('sys_scope', { sys_created_on: '2026-03-01 10:00:00' })] },
    { table: 'sys_update_xml', rows: [change()] },
    { table: 'sys_update_version', rows: Array.from({ length: 14 }, () => version('previous', 'sys_update_set', '2026-03-01 10:00:00', 'abel')) },
    { table: 'sys_update_version', api: 'stats', status: 403 },
  ])
  assert.equal((await uncounted.answer('sn_origin', { sysId: ID })).verdict, 'unknown')
})

test('sn_origin says so when rows of the evidence are hidden from the account', async () => {
  const hiddenUpdates = await connect([
    { table: 'sys_metadata', rows: [file('sys_plugins')] },
    { table: 'sys_update_xml', rows: [], total: 3 },
    { table: 'sys_update_version', rows: [] },
    stats('sys_update_version', {}),
  ])
  const data = await hiddenUpdates.answer('sn_origin', { sysId: ID })
  assert.deepEqual({ divergence: data.divergence, capturedBy: data.capturedBy }, { divergence: 'customer_changes_captured', capturedBy: 'unknown' })
  assert.match(data.warnings.join(' '), /Customer updates: 3 matching row\(s\) were not returned/)

  const hiddenSkip = await connect([...origin('sys_plugins', [], []).slice(0, 4), { table: 'upgrade_history_task', rows: [], total: 1 }])
  const skipped = await hiddenSkip.answer('sn_origin', { sysId: ID })
  assert.deepEqual({ divergence: skipped.divergence, verdict: skipped.verdict }, { divergence: 'unknown', verdict: 'unknown' })

  // A deleted record cannot be told from an unknown one when the update rows are not readable.
  const blind = await connect([{ table: 'sys_metadata', rows: [] }, { table: 'sys_update_xml', status: 403 }])
  assert.equal((await blind.answer('sn_origin', { sysId: ID })).verdict, 'unknown')
})

test('sn_origin: a reverted record keeps its update row, and the answer says so', async () => {
  const versions = [version('current', 'sys_store_app', '2026-03-01 10:00:00', 'abel'), version('previous', 'sys_update_set', '2026-03-01 09:00:00', 'abel')]
  const { answer } = await connect(origin('sys_store_app', [change({ sys_created_on: '2026-03-01 09:00:00' })], versions))
  const data = await answer('sn_origin', { sysId: ID })
  assert.equal(data.verdict, 'customized')
  assert.match(data.warnings.join(' '), /reverted to the vendor version/)
})

test('sn_origin: records in the global scope', async () => {
  const created = await connect(origin('sys_scope', [change()], [version('current', 'sys_update_set', '2026-03-01 10:00:00', 'abel')], { sys_created_on: '2026-03-01 10:00:00' }))
  assert.equal((await created.answer('sn_origin', { updateName: NAME })).verdict, 'customer_created')

  // A vendor version exists: the record was delivered with the platform although it belongs to no plugin.
  const delivered = await connect(origin('sys_scope', [change()], [version('current', 'sys_update_set', '2026-03-01 10:00:00', 'abel'), version('previous', 'sys_upgrade_history', '2026-03-01 09:59:59')]))
  assert.equal((await delivered.answer('sn_origin', { sysId: ID })).verdict, 'customized')

  const untouched = await connect(origin('sys_scope', [], []))
  assert.equal((await untouched.answer('sn_origin', { sysId: ID })).verdict, 'unknown')
})

test('sn_origin: an old record of the global scope without a vendor version is the customer\'s own', async () => {
  // Created in 2020, captured in 2026, no version from an upgrade: nothing says the vendor delivered it.
  const { answer } = await connect(origin('sys_scope', [change()], [version('current', 'sys_update_set', '2026-03-01 10:00:00', 'abel')]))
  const data = await answer('sn_origin', { sysId: ID })
  assert.deepEqual({ created: data.created, verdict: data.verdict }, { created: 'here', verdict: 'customer_created' })
})

test('sn_origin: an application developed here', async () => {
  const { answer } = await connect(origin('sys_app', [change()], []))
  assert.equal((await answer('sn_origin', { sysId: ID })).verdict, 'custom_application_file')
})

test('sn_origin: changes captured under system accounts are named as such', async () => {
  const bySystem = change({ sys_created_by: 'system', sys_updated_by: 'system' })
  const { answer } = await connect(origin('sys_plugins', [bySystem], []))
  const data = await answer('sn_origin', { sysId: ID })
  assert.equal(data.verdict, 'customized')
  assert.equal(data.capturedBy, 'system_accounts')
  assert.match(data.warnings.join(' '), /not an edit by a person/)
})

test('sn_origin abstains when the evidence does not decide', async () => {
  const hidden = await connect([{ table: 'sys_metadata', rows: [], total: 1 }])
  const unseen = await hidden.answer('sn_origin', { sysId: ID })
  assert.equal(unseen.verdict, 'unknown')
  assert.match(unseen.warnings.join(' '), /may not read it/)
  assert.equal(hidden.calls.length, 1)

  const unreadable = await connect([{ table: 'sys_metadata', rows: [file('sys_plugins')] }, { table: 'sys_update_xml', status: 403 }, { table: 'sys_update_version', rows: [] }, stats('sys_update_version', {})])
  const data = await unreadable.answer('sn_origin', { sysId: ID })
  assert.equal(data.verdict, 'unknown')
  assert.equal(data.divergence, 'unknown')
  assert.equal(data.capturedBy, 'unknown')
  assert.equal(data.evidence.customerUpdates.readable, false)
  assert.match(data.warnings.join(' '), /sys_update_xml could not be read \(acl\)/)

  const noPackage = await connect(origin('', [], []))
  assert.equal((await noPackage.answer('sn_origin', { sysId: ID })).provenance, 'unknown')
})

test('sn_origin: the entry of a system field is judged by the table it belongs to', async () => {
  // Measured: such entries belong to no package, and nine in ten entries without a package are of this kind.
  const entry = (kind: string) => ({ sys_update_name: '', sys_class_name: kind, sys_package: '' })
  const routes = (kind: string, element: string, tablePackage: string): Route[] => [
    { table: kind, rows: [{ sys_id: ID, name: 'x_acme_case', element, language: 'en' }] },
    { table: 'sys_db_object', query: 'name=x_acme_case', rows: [{ sys_package: tablePackage ? labelled('p9', 'Example app') : '', 'sys_package.sys_class_name': tablePackage }] },
    ...origin('', [], [], entry(kind)),
  ]

  const field = await connect(routes('sys_dictionary', 'sys_id', 'sys_store_app'))
  const data = await field.answer('sn_origin', { sysId: ID })
  assert.deepEqual({ verdict: data.verdict, provenance: data.provenance, from: data.record.package }, { verdict: 'out_of_box_as_captured', provenance: 'installed_application', from: 'Example app' })
  assert.match(data.warnings.join(' '), /belongs to no package itself.*that of the table "x_acme_case" \(sys_db_object, name=x_acme_case\)/)
  assert.equal(field.sentTo('sys_dictionary').length, 1, 'the row that names the table is read once')

  const label = await connect(routes('sys_documentation', 'sys_created_on', 'sys_plugins'))
  assert.equal((await label.answer('sn_origin', { sysId: ID })).verdict, 'out_of_box_as_captured')

  // The table of an application developed here: its system fields are part of that application.
  const own = await connect(routes('sys_dictionary', 'sys_updated_by', 'sys_app'))
  assert.equal((await own.answer('sn_origin', { sysId: ID })).verdict, 'custom_application_file')

  // Not a system field, or a table without a package: nothing says who delivered the entry.
  const other = await connect(routes('sys_dictionary', 'word', 'sys_plugins'))
  assert.equal((await other.answer('sn_origin', { sysId: ID })).verdict, 'unknown')
  assert.equal(other.sentTo('sys_db_object').length, 0)
  const bare = await connect(routes('sys_dictionary', 'sys_id', ''))
  const undecided = await bare.answer('sn_origin', { sysId: ID })
  assert.equal(undecided.verdict, 'unknown')
  assert.match(undecided.explanation, /belongs to no package/)
})

test('sn_origin says why, whenever it does not decide', async () => {
  const cases: Array<[string, Route[], RegExp]> = [
    // Measured: one application file in nine belongs to no package, and almost none of those was ever captured.
    ['no package', origin('', [], []), /belongs to no package.*Nothing on the instance says who delivered it/],
    ['global scope, untouched', origin('sys_scope', [], []), /belongs to the global scope and not to a package/],
    ['changed inside an installed application', origin('sys_store_app', [], [version('current', 'sys_update_set', '2026-03-01 10:00:00', 'abel')]), /delivered and then changed, or created here/],
    ['hidden from the account', [{ table: 'sys_metadata', rows: [null] }], /could not be established whether the record exists/],
    ['a part of another record', origin('sys_plugins', [], [], { sys_update_name: '', sys_class_name: 'sys_hub_action_input' }), /no update name of its own/],
    ['evidence not readable', [{ table: 'sys_metadata', rows: [file('sys_plugins')] }, { table: 'sys_update_xml', status: 403 }, { table: 'sys_update_version', rows: [] }, stats('sys_update_version', {})], /part of the evidence is missing or hidden/],
    ['known to an upgrade only', origin(null, [], [], {}, [skip('Skipped Manual Merge')]), /no record answers to it/],
  ]
  for (const [label, routes, reason] of cases) {
    const { answer } = await connect(routes)
    const data = await answer('sn_origin', label === 'known to an upgrade only' ? { updateName: NAME } : { sysId: ID })
    assert.equal(data.verdict, 'unknown', label)
    assert.match(data.explanation, reason, label)
  }
})

test('sn_origin: a record that is gone', async () => {
  const deleted = await connect(origin(null, [change({ action: 'DELETE' })], []))
  const bySysId = await deleted.answer('sn_origin', { sysId: ID })
  assert.equal(bySysId.verdict, 'deleted_here')
  assert.equal(deleted.sentTo('sys_update_xml')[0].query, `nameENDSWITH_${ID}^ORDERBYDESCsys_updated_on`)
  assert.equal((await deleted.answer('sn_origin', { updateName: NAME })).verdict, 'deleted_here')

  const missing = await connect(origin(null, [], []))
  assert.equal((await missing.answer('sn_origin', { sysId: ID })).verdict, 'not_found')
})

test('sn_origin: a file an upgrade skipped, held here under another sys_id, is not reported as missing', async () => {
  // Measured: the file of a system property carries the vendor's sys_id, the instance holds the property under its own.
  const { answer } = await connect(origin(null, [], [], {}, [skip('Skipped Manual Merge')]))
  const data = await answer('sn_origin', { updateName: NAME })

  assert.equal(data.verdict, 'unknown')
  assert.equal(data.record, null)
  assert.equal(data.evidence.upgradeSkips.rows[0].target, 'Example rule')
  assert.match(data.warnings.join(' '), /An upgrade has an entry for a file of this name, but no record answers to it/)

  // The same holds where the entry of the upgrade exists but cannot be seen.
  const unseen = await connect([...origin(null, [], []).slice(0, 4), { table: 'upgrade_history_task', rows: [], total: 1 }])
  assert.equal((await unseen.answer('sn_origin', { updateName: NAME })).verdict, 'unknown')

  // A version alone says the name is known here, although no record answers to it.
  const versioned = await connect(origin(null, [], [version('history', 'sys_upgrade_history', '2026-09-25 17:00:00')]))
  const known = await versioned.answer('sn_origin', { updateName: NAME })
  assert.equal(known.verdict, 'unknown')
  assert.match(known.warnings.join(' '), /Update rows or versions exist under this name, but the record itself is not readable/)
})

test('sn_origin: a dictionary entry or label that was never captured has no stored name, and is still judged', async () => {
  const unnamed = { sys_update_name: '', sys_class_name: 'sys_dictionary' }
  const field = await connect([{ table: 'sys_dictionary', rows: [{ sys_id: ID, name: 'incident', element: 'category' }] }, ...origin('sys_plugins', [], [], unnamed)])
  const data = await field.answer('sn_origin', { sysId: ID })
  assert.equal(data.record.updateName, 'sys_dictionary_incident_category')
  assert.equal(data.verdict, 'out_of_box_as_captured')
  assert.equal(field.sentTo('sys_update_xml')[0].query, 'name=sys_dictionary_incident_category^ORDERBYDESCsys_updated_on')

  const whole = await connect([{ table: 'sys_dictionary', rows: [{ sys_id: ID, name: 'incident', element: '' }] }, ...origin('sys_plugins', [change({ name: 'sys_dictionary_incident_null' })], [], unnamed)])
  assert.equal((await whole.answer('sn_origin', { sysId: ID })).record.updateName, 'sys_dictionary_incident_null')

  const label = await connect([{ table: 'sys_documentation', rows: [{ sys_id: ID, name: 'incident', element: '', language: 'en' }] }, ...origin('sys_plugins', [], [], { sys_update_name: '', sys_class_name: 'sys_documentation' })])
  assert.equal((await label.answer('sn_origin', { sysId: ID })).record.updateName, 'sys_documentation_incident__en')

  // Other kinds of record without a name are parts of another record: nothing can be looked up.
  const part = await connect(origin('sys_plugins', [], [], { sys_update_name: '', sys_class_name: 'sys_hub_action_input' }))
  const unknown = await part.answer('sn_origin', { sysId: ID })
  assert.equal(unknown.verdict, 'unknown')
  assert.match(unknown.warnings.join(' '), /carries no update name/)
})

test('sn_origin finds a never-captured field or label by the update name it would get', async () => {
  // Measured: two in three dictionary entries store no update name, so no record answers to the name itself.
  const unnamed = (kind: string) => file('sys_plugins', { sys_update_name: '', sys_class_name: kind })
  const lookup = (kind: string, rows: Data[]): Route[] => [
    { table: 'sys_metadata', query: 'sys_update_name=', rows: [] },
    { table: kind, rows },
    { table: 'sys_metadata', query: `sys_id=${ID}`, rows: [unnamed(kind)] },
    ...origin(null, [], []).slice(1),
  ]

  const field = await connect(lookup('sys_dictionary', [{ sys_id: 'f'.repeat(32), name: 'cmdb_ci', element: 'name' }, { sys_id: ID, name: 'cmdb_ci_server', element: 'host_name' }]))
  const data = await field.answer('sn_origin', { updateName: 'sys_dictionary_cmdb_ci_server_host_name' })
  assert.equal(data.verdict, 'out_of_box_as_captured')
  assert.equal(data.record.updateName, 'sys_dictionary_cmdb_ci_server_host_name')
  // The name does not say where the table ends and the field begins: every split is asked for, and the row that gives the same name is taken.
  assert.equal(field.sentTo('sys_dictionary')[0].query, 'nameINcmdb,cmdb_ci,cmdb_ci_server,cmdb_ci_server_host^elementINci_server_host_name,server_host_name,host_name,name')
  assert.equal(field.sentTo('sys_metadata')[1].query, `sys_id=${ID}`)
  assert.equal(field.sentTo('sys_update_xml')[0].query, 'name=sys_dictionary_cmdb_ci_server_host_name^ORDERBYDESCsys_updated_on')

  const label = await connect(lookup('sys_documentation', [{ sys_id: ID, name: 'incident', element: 'category', language: 'en' }]))
  assert.equal((await label.answer('sn_origin', { updateName: 'sys_documentation_incident_category_en' })).verdict, 'out_of_box_as_captured')

  // No such field: that is established, because the dictionary was readable.
  const none = await connect(lookup('sys_dictionary', []))
  assert.equal((await none.answer('sn_origin', { updateName: 'sys_dictionary_incident_no_such_field' })).verdict, 'not_found')

  // The dictionary is not readable, or hides rows: then nothing is established.
  for (const route of [{ table: 'sys_dictionary', status: 403 }, { table: 'sys_dictionary', rows: [null] }]) {
    const blind = await connect([{ table: 'sys_metadata', rows: [] }, route, ...origin(null, [], []).slice(1)])
    const unknown = await blind.answer('sn_origin', { updateName: 'sys_dictionary_incident_category' })
    assert.equal(unknown.verdict, 'unknown')
    assert.match(unknown.warnings.join(' '), /sys_dictionary could not be read completely/)
  }

  // The entry exists, but the file behind it may not be read.
  const hiddenFile = await connect([{ table: 'sys_metadata', rows: [] }, { table: 'sys_dictionary', rows: [{ sys_id: ID, name: 'incident', element: 'category' }] }])
  const hidden = await hiddenFile.answer('sn_origin', { updateName: 'sys_dictionary_incident_category' })
  assert.equal(hidden.verdict, 'unknown')
  assert.match(hidden.warnings.join(' '), /may not read it/)
})

test('the query that finds a record by the name built from its content', () => {
  assert.deepEqual(queryByContent('sys_dictionary_incident_category'), { table: 'sys_dictionary', query: 'nameINincident^elementINcategory' })
  // The entry of a table itself is named "..._null" and has no element. "u_null" would be a field of that name too.
  assert.deepEqual(queryByContent('sys_dictionary_incident_null'), { table: 'sys_dictionary', query: 'nameINincident^elementISEMPTY' })
  assert.deepEqual(queryByContent('sys_dictionary_incident_u_null'), { table: 'sys_dictionary', query: 'nameINincident,incident_u^elementINu_null^ORelementISEMPTY' })
  assert.deepEqual(queryByContent('sys_documentation_incident_category_en'), { table: 'sys_documentation', query: 'nameINincident^elementINcategory^language=en' })
  // The label of a table has an empty element, which leaves two underscores in the name.
  assert.deepEqual(queryByContent('sys_documentation_incident__en'), { table: 'sys_documentation', query: 'nameINincident^elementISEMPTY^language=en' })
  for (const name of ['sys_script_0123456789abcdef0123456789abcdef', 'sys_dictionary_incident', 'sys_dictionary_Incident_category', 'sys_documentation_incident', 'sys_dictionary_']) {
    assert.equal(queryByContent(name), null, name)
  }
})

test('sn_origin does not decide on evidence it sees only part of', async () => {
  // The version marked current is hidden, an older vendor version is visible.
  const hiddenCurrent = await connect([
    { table: 'sys_metadata', rows: [file('sys_plugins')] },
    { table: 'sys_update_xml', rows: [] },
    { table: 'sys_update_version', rows: [null, version('previous', 'sys_upgrade_history', '2025-03-01 00:00:00')] },
    stats('sys_update_version', { sys_upgrade_history: 1, sys_update_set: 1 }),
  ])
  assert.equal((await hiddenCurrent.answer('sn_origin', { sysId: ID })).verdict, 'unknown')

  // The newest entry of an upgrade is hidden, an older one that says nothing is visible.
  const hiddenSkip = await connect([...origin('sys_plugins', [], []).slice(0, 4), { table: 'upgrade_history_task', rows: [null, skip('Skipped Error')] }])
  const skipped = await hiddenSkip.answer('sn_origin', { sysId: ID })
  assert.deepEqual({ divergence: skipped.divergence, verdict: skipped.verdict }, { divergence: 'unknown', verdict: 'unknown' })

  // One visible update row by a system account, two hidden: who else is on them is not known.
  const bySystem = change({ sys_created_by: 'system', sys_updated_by: 'system' })
  const hiddenAuthors = await connect(origin('sys_plugins', [bySystem, null as unknown as Data, null as unknown as Data], []))
  assert.equal((await hiddenAuthors.answer('sn_origin', { sysId: ID })).capturedBy, 'unknown')

  // The record is hidden in its own table, and an old update row deleted it once: it cannot be called deleted.
  const name = `sys_choice_${ID}`
  const hiddenRecord = await connect([{ table: 'sys_metadata', rows: [] }, { table: 'sys_choice', rows: [null] }, { table: 'sys_update_xml', rows: [change({ name, action: 'DELETE' })] }, { table: 'sys_update_version', rows: [] }, stats('sys_update_version', {})])
  assert.equal((await hiddenRecord.answer('sn_origin', { updateName: name })).verdict, 'unknown')
})

test('sn_origin: with more update rows than one page, it asks whether a person is on any of them', async () => {
  const bySystem = change({ sys_created_by: 'system', sys_updated_by: 'system' })
  const many = Array.from({ length: 25 }, () => bySystem)
  const routes = (people: Data[]): Route[] => [
    { table: 'sys_metadata', rows: [file('sys_plugins')] },
    { table: 'sys_update_xml', query: 'sys_created_byNOT IN', rows: people },
    ...origin('sys_plugins', many, []).slice(1),
  ]

  const onlySystem = await connect(routes([]))
  const data = await onlySystem.answer('sn_origin', { sysId: ID })
  assert.equal(data.capturedBy, 'system_accounts')
  assert.equal(onlySystem.sentTo('sys_update_xml').at(-1)?.query, `name=${NAME}^sys_created_byNOT INsystem,guest^sys_created_byNOT LIKE@snc.^NQname=${NAME}^sys_updated_byNOT INsystem,guest^sys_updated_byNOT LIKE@snc.`)

  // The person is on a row the first page does not show.
  const withPerson = await connect(routes([change()]))
  assert.equal((await withPerson.answer('sn_origin', { sysId: ID })).capturedBy, 'people')
})

test('sn_origin: an upgrade that applied the record since an older skip means it no longer differs', async () => {
  // Skipped in September, and a vendor version became current in October: a later upgrade applied the record.
  const applied = await connect(origin('sys_plugins', [], [version('current', 'sys_upgrade_history', '2026-10-01 00:00:00')], {}, [skip('Skipped')]))
  const data = await applied.answer('sn_origin', { sysId: ID })
  assert.deepEqual({ divergence: data.divergence, verdict: data.verdict }, { divergence: 'no_customer_changes_captured', verdict: 'out_of_box_as_captured' })

  // The vendor version of the same upgrade is written before its skip entry: that one still counts.
  const same = await connect(origin('sys_plugins', [], [version('current', 'sys_upgrade_history', '2026-09-25 16:00:00')], {}, [skip('Skipped')]))
  assert.equal((await same.answer('sn_origin', { sysId: ID })).verdict, 'customized')
})

test('sn_origin does not search update rows by a sys_id that is a plain word', async () => {
  // "category" at the end of a name would match the update rows of other records.
  const { answer, sentTo } = await connect(origin(null, [change({ name: 'sys_dictionary_incident_category' })], []))
  const data = await answer('sn_origin', { sysId: 'category' })
  assert.equal(data.verdict, 'unknown')
  assert.match(data.warnings.join(' '), /not of the generated form/)
  assert.equal(sentTo('sys_update_xml').length, 0)
})

test('sn_origin says why it could not build the update name of a dictionary entry', async () => {
  const unnamed = { sys_update_name: '', sys_class_name: 'sys_dictionary' }
  const unreadable = await connect([{ table: 'sys_dictionary', status: 403 }, ...origin('sys_plugins', [], [], unnamed)])
  const data = await unreadable.answer('sn_origin', { sysId: ID })
  assert.equal(data.verdict, 'unknown')
  assert.match(data.warnings.join(' '), /could not be read from sys_dictionary \(acl\)/)

  // The row comes back without the name of its table: no name is made up from what is missing.
  const nameless = await connect([{ table: 'sys_dictionary', rows: [{ sys_id: ID, element: 'category' }] }, ...origin('sys_plugins', [], [], unnamed)])
  const other = await nameless.answer('sn_origin', { sysId: ID })
  assert.equal(other.verdict, 'unknown')
  assert.equal(nameless.sentTo('sys_update_xml').length, 0)
})

test('sn_origin: a tracked record outside sys_metadata is read from its own table', async () => {
  const name = `sys_choice_${ID}`
  const { answer } = await connect([
    { table: 'sys_metadata', rows: [] },
    { table: 'sys_choice', rows: [{ sys_id: ID, sys_created_on: '2026-03-01 10:00:00', sys_created_by: 'abel', sys_updated_on: '2026-03-01 10:00:00', sys_updated_by: 'abel' }] },
    { table: 'sys_update_xml', rows: [change({ name })] },
    { table: 'sys_update_version', rows: [version('current', 'sys_update_set', '2026-03-01 10:00:00', 'abel')] },
    stats('sys_update_version', { sys_update_set: 1 }),
  ])
  const data = await answer('sn_origin', { updateName: name })
  assert.equal(data.record.table, 'sys_choice')
  assert.equal(data.provenance, 'unknown')
  assert.equal(data.verdict, 'customer_created')
})

test('sn_origin refuses input it cannot use, and never puts an unchecked name into a query', async () => {
  const empty = await connect([])
  assert.equal((await empty.call('sn_origin', {})).data.error, 'validation')
  assert.equal((await empty.call('sn_origin', { sysId: ID, updateName: NAME })).data.error, 'validation')
  assert.equal((await empty.call('sn_origin', { updateName: 'x^ORname=y' })).data.error, 'validation')
  assert.equal((await empty.call('sn_origin', {})).data.table, undefined)

  const hostile = await connect(origin('sys_plugins', [change()], [], { sys_update_name: `${NAME}^ORaction=DELETE` }))
  const data = await hostile.answer('sn_origin', { sysId: ID })
  assert.match(data.warnings.join(' '), /cannot be placed into a query/)
  assert.equal(hostile.sentTo('sys_update_xml').length, 0)
  assert.equal(data.verdict, 'unknown')
})

// ---------------------------------------------------------------- sn_delta

test('sn_delta lists updates, exact counts per type, system accounts, and its own gaps', async () => {
  const filter = 'sys_created_by=abel^ORsys_updated_by=abel^sys_updated_on>=2026-01-01 00:00:00^type=Business Rule'
  const { answer, call, sentTo } = await connect([
    { table: 'sys_update_xml', query: 'sys_created_byINsystem', rows: [], total: 4 },
    { table: 'sys_update_xml', rows: [{ name: 'sys_script_1', type: 'Business Rule', action: 'INSERT_OR_UPDATE', sys_updated_on: '2026-02-01 00:00:00' }], total: 9 },
    stats('sys_update_xml', { 'Business Rule': 9 }, filter, 'type'),
  ])
  const data = await answer('sn_delta', { type: 'Business Rule', since: '2026-01-01', changedBy: 'abel', limit: 1 })

  assert.equal(data.total, 9)
  assert.equal(data.truncated, true)
  assert.deepEqual(data.byType, [{ type: 'Business Rule', count: 9 }])
  // Both counts are taken under the same filter as the list.
  assert.equal(sentTo('sys_update_xml', 'stats')[0].query, filter)
  assert.equal(sentTo('sys_update_xml')[1].query, `${filter}^sys_created_byINsystem,guest^ORsys_created_byLIKE@snc.^ORsys_created_byISEMPTY^sys_updated_byINsystem,guest^ORsys_updated_byLIKE@snc.^ORsys_updated_byISEMPTY`)
  assert.equal(data.capturedBySystemAccounts, 4)
  assert.match(data.warnings.join(' '), /4 of the 9 rows were captured under system accounts/)
  assert.ok(data.notCaptured.length >= 5)
  // A change is found by when it was last made, not by when the row was first written.
  assert.equal(sentTo('sys_update_xml')[0].query, `${filter}^ORDERBYDESCsys_updated_on`)
  assert.equal((await call('sn_delta', { nameContains: 'a^ORb=c' })).data.error, 'validation')
})

test('sn_delta can leave out system accounts, and explains a type nobody uses', async () => {
  const people = await connect([{ table: 'sys_update_xml', rows: [{ name: 'a' }] }, stats('sys_update_xml', { Report: 1 })])
  const data = await people.answer('sn_delta', { peopleOnly: true, type: 'Report' })
  // A row counts as a person's if a person captured it first or changed it last: a union of two queries, each with the whole filter.
  const union = 'type=Report^sys_created_byNOT INsystem,guest^sys_created_byNOT LIKE@snc.^NQtype=Report^sys_updated_byNOT INsystem,guest^sys_updated_byNOT LIKE@snc.'
  assert.equal(people.sentTo('sys_update_xml')[0].query, `${union}^ORDERBYDESCsys_updated_on`)
  assert.equal(people.sentTo('sys_update_xml', 'stats')[0].query, union)
  assert.equal(data.capturedBySystemAccounts, 0)

  const guessed = await connect([{ table: 'sys_update_xml', rows: [] }, stats('sys_update_xml', {}, 'type=ACL'), stats('sys_update_xml', { 'Access Control': 3, Report: 1 })])
  const none = await guessed.answer('sn_delta', { type: 'ACL' })
  assert.equal(none.total, 0)
  assert.match(none.warnings.join(' '), /No row has the type "ACL".*Access Control, Report/)
})

// -------------------------------------------------------------- sn_plugins

test('sn_plugins matches name, plugin id and scope, and falls back to sys_scope', async () => {
  const { answer, sentTo } = await connect([
    { table: 'v_plugin', rows: [{ id: 'com.example', name: 'Example', active: 'active', version: '1.0.0' }] },
    { table: 'sys_store_app', status: 403 },
    { table: 'sys_scope', rows: [{ name: 'Example app', scope: 'x_example', version: '2.0.0', active: 'true', vendor: 'Example Inc' }] },
  ])
  const data = await answer('sn_plugins', { filter: 'example' })

  assert.equal(data.plugins.returned, 1)
  assert.equal(data.plugins.table, 'v_plugin')
  assert.equal(data.storeApps.table, 'sys_scope')
  assert.equal(data.storeApps.items[0].scope, 'x_example')
  assert.equal(sentTo('v_plugin')[0].query, 'nameLIKEexample^ORidLIKEexample^active=active')
  assert.equal(sentTo('sys_scope')[0].query, 'sys_class_name=sys_store_app^nameLIKEexample^ORscopeLIKEexample^active=true')
  assert.equal(data.storeApps.query, sentTo('sys_scope')[0].query)
})

test('sn_plugins answers with what it can read, and fails only when it can read nothing', async () => {
  const half = await connect([{ table: 'v_plugin', status: 403 }, { table: 'sys_store_app', rows: [{ name: 'App', scope: 'sn_app', active: 'true' }] }])
  const data = await half.answer('sn_plugins')
  assert.equal(data.plugins.table, null)
  assert.equal(data.storeApps.returned, 1)
  assert.match(data.warnings.join(' '), /plugin list could not be read \(acl\)/)

  const hidden = await connect([{ table: 'v_plugin', rows: [] }, { table: 'sys_store_app', rows: [], total: 20 }, { table: 'sys_scope', rows: [{ name: 'App', scope: 'sn_app', active: 'true' }] }])
  assert.equal((await hidden.answer('sn_plugins')).storeApps.table, 'sys_scope')

  const nothing = await connect([{ table: 'v_plugin', status: 403 }, { table: 'sys_store_app', status: 403 }, { table: 'sys_scope', status: 403 }])
  assert.equal((await nothing.call('sn_plugins')).data.error, 'acl')
})

// -------------------------------------------------------- sn_upgrade_skips

const UP = { family: 'a'.repeat(32), patch: 'b'.repeat(32) }
const upgradeRoutes: Route[] = [
  {
    table: 'sys_upgrade_history',
    rows: [
      { sys_id: UP.patch, from_version: 'glide-australia-02-11-2026__patch1.zip', to_version: 'glide-australia-02-11-2026__patch2.zip', upgrade_finished: '2026-10-10 12:00:00' },
      { sys_id: UP.family, from_version: 'glide-zurich-07-01-2025__patch10.zip', to_version: 'glide-australia-02-11-2026__patch1.zip', upgrade_finished: '2026-09-25 17:41:09' },
    ],
  },
  { table: 'sys_choice', rows: [{ value: '4', label: 'Skipped' }, { value: '9', label: 'Skipped Error' }, { value: '10', label: 'Skipped Manual Merge' }, { value: '2', label: 'Updated' }] },
  {
    table: 'upgrade_history_task',
    rows: [
      {
        'upgrade_detail.file_name': 'sys_script_1',
        'upgrade_detail.target_name': 'Example rule',
        'upgrade_detail.type': 'Business Rule',
        'upgrade_detail.disposition': labelled('10', 'Skipped Manual Merge'),
        'upgrade_detail.upgrade_history.to_version': 'glide-australia-02-11-2026__patch1.zip',
        state: labelled('1', 'Not Reviewed'),
        sys_created_on: '2026-09-25 17:00:00',
      },
    ],
    total: 110,
  },
  stats('upgrade_history_task', { '4': 42, '10': 37, '9': 31 }, undefined, 'upgrade_detail.disposition'),
  stats('upgrade_history_task', { 'System Property': 70, 'Business Rule': 40 }, undefined, 'upgrade_detail.type'),
  stats('upgrade_history_task', { '1': 60, '4': 50 }, undefined, 'state'),
  stats('upgrade_history_task', { [UP.patch]: 5, [UP.family]: 110 }, undefined, 'upgrade_detail.upgrade_history'),
]

test('sn_upgrade_skips covers the latest change of family, not the patch after it', async () => {
  const routes: Route[] = [
    ...upgradeRoutes.slice(0, 3),
    { table: 'upgrade_history_task', api: 'stats', rows: [] },
  ]
  const { answer, sentTo, calls } = await connect(routes)
  const data = await answer('sn_upgrade_skips', {})

  assert.deepEqual(data.upgrade, { from: 'glide-zurich-07-01-2025__patch10.zip', to: 'glide-australia-02-11-2026__patch1.zip', finished: '2026-09-25 17:41:09', kind: 'family' })
  assert.deepEqual(data.laterUpgrades.map((item: Data) => `${item.kind} finished ${item.finished}`), ['patch finished 2026-10-10 12:00:00'])
  assert.deepEqual(data.dispositionCodes, { skipped: { '4': 'Skipped', '9': 'Skipped Error', '10': 'Skipped Manual Merge' }, from: 'instance' })
  assert.deepEqual(data.records[0], { file: 'sys_script_1', target: 'Example rule', type: 'Business Rule', disposition: 'Skipped Manual Merge', review: 'Not Reviewed', upgrade: 'glide-australia-02-11-2026__patch1.zip', createdOn: '2026-09-25 17:00:00' })
  assert.equal(sentTo('upgrade_history_task')[0].query, `upgrade_detail.upgrade_history=${UP.family}^upgrade_detail.dispositionIN4,9,10^ORDERBYDESCsys_created_on`)
  assert.equal(calls.filter((entry) => entry.table === 'upgrade_history_task' && entry.api === 'stats').length, 4)

  const latest = await connect(routes)
  assert.equal((await latest.answer('sn_upgrade_skips', { upgrade: 'latest' })).upgrade.kind, 'patch')
})

test('sn_upgrade_skips counts the whole filter, and separates failures from customizations', async () => {
  const { answer } = await connect(upgradeRoutes)
  const data = await answer('sn_upgrade_skips', { limit: 1 })

  assert.equal(data.total, 110)
  assert.deepEqual(data.byDisposition, [{ name: 'Skipped', count: 42 }, { name: 'Skipped Manual Merge', count: 37 }, { name: 'Skipped Error', count: 31 }])
  assert.deepEqual(data.byType, [{ name: 'System Property', count: 70 }, { name: 'Business Rule', count: 40 }])
  assert.equal(data.notReviewed, 60)
  assert.match(data.notes.join(' '), /31 of the entries are "Skipped Error"/)
  assert.deepEqual(data.laterUpgrades.map((item: Data) => item.entries), [5])
})

test('sn_upgrade_skips counts each thing under the right filter', async () => {
  const { answer, sentTo } = await connect(upgradeRoutes)
  await answer('sn_upgrade_skips', { fileContains: 'sys_script', unreviewedOnly: true })
  const asked = Object.fromEntries(sentTo('upgrade_history_task', 'stats').map((entry) => [entry.params.get('sysparm_group_by'), entry.query]))
  const shared = 'upgrade_detail.dispositionIN4,9,10^upgrade_detail.file_nameLIKEsys_script^state=1'

  // The counts of the covered upgrade carry its filter. The count per upgrade must not, or every later upgrade would show 0.
  assert.equal(asked['upgrade_detail.disposition'], `upgrade_detail.upgrade_history=${UP.family}^${shared}`)
  assert.equal(asked['upgrade_detail.type'], `upgrade_detail.upgrade_history=${UP.family}^${shared}`)
  assert.equal(asked.state, `upgrade_detail.upgrade_history=${UP.family}^${shared}`)
  assert.equal(asked['upgrade_detail.upgrade_history'], shared)
})

test('sn_upgrade_skips without a change of family covers the most recent upgrade, and can be asked for one by name', async () => {
  const onlyPatch: Route = { table: 'sys_upgrade_history', rows: [upgradeRoutes[0].rows![0]] }
  const { answer, sentTo } = await connect([onlyPatch, ...upgradeRoutes.slice(1)])

  const data = await answer('sn_upgrade_skips', {})
  assert.equal(data.upgrade.kind, 'patch')
  assert.deepEqual(data.laterUpgrades, [])
  assert.match(data.warnings.join(' '), /No change of release family/)

  await answer('sn_upgrade_skips', { upgrade: 'zurich', onlySkipped: false, unreviewedOnly: true, fileContains: 'sys_script' })
  assert.equal(sentTo('upgrade_history_task').at(-1)?.query, 'upgrade_detail.upgrade_history.to_versionLIKEzurich^upgrade_detail.file_nameLIKEsys_script^state=1^ORDERBYDESCsys_created_on')
})

test('sn_upgrade_skips says what it could not establish', async () => {
  const fallback = await connect([{ table: 'sys_choice', status: 403 }, { table: 'upgrade_history_task', rows: [] }, { table: 'upgrade_history_task', api: 'stats', rows: [] }])
  const data = await fallback.answer('sn_upgrade_skips', { upgrade: 'all' })
  assert.equal(data.dispositionCodes.from, 'fallback')
  assert.ok('4' in data.dispositionCodes.skipped, 'the plain "Skipped" code is part of the built-in list')
  assert.match(data.warnings.join(' '), /built-in list/)
  assert.equal(data.upgrade, null)

  const noHistory = await connect([{ table: 'sys_upgrade_history', status: 403 }, ...upgradeRoutes.slice(1)])
  const all = await noHistory.answer('sn_upgrade_skips', {})
  assert.equal(all.upgrade, null)
  assert.match(all.warnings.join(' '), /sys_upgrade_history could not be read \(acl\)/)

  const blank = await connect([...upgradeRoutes.slice(0, 2), { table: 'upgrade_history_task', rows: [{ state: '1', sys_created_on: '2026-09-25 17:00:00' }] }, { table: 'upgrade_history_task', api: 'stats', rows: [] }])
  assert.match((await blank.answer('sn_upgrade_skips', {})).warnings.join(' '), /came back without file names/)
})

// --------------------------------------------------------- sn_dependencies

const rule = (id: string, collection: string, extra: Data = {}) => ({ sys_id: id, sys_name: `Rule on ${collection}`, sys_update_name: `sys_script_${id}`, collection, active: 'true', when: 'before', ...extra })

test('sn_dependencies lists what is attached, with the query behind every category', async () => {
  const { answer, sentTo } = await connect([
    { table: 'sys_db_object', query: 'super_class.name=incident^ORsuper_class', rows: [{ sys_id: 'x' }], total: 3 },
    { table: 'sys_db_object', query: 'super_class.name=incident', rows: [{ name: 'incident_child' }] },
    ...dictionaryRoutes,
    { table: 'sys_script', rows: [rule('a1', 'task'), rule('a2', 'incident')], total: 12 },
    { table: 'sys_script_client', rows: [{ sys_id: 'c1', sys_name: 'On load', sys_update_name: 'sys_script_client_c1', table: 'incident', active: 'true', type: 'onLoad', applies_extended: 'false' }] },
    { table: 'sys_security_acl', rows: [{ sys_id: 'acl1', sys_update_name: 'sys_security_acl_acl1', name: 'incident.number', active: 'true', operation: labelled('op1', 'read'), type: labelled('t1', 'record'), decision_type: labelled('allow', 'Allow If') }] },
    stats('sys_update_xml', { sys_script_a2: 2 }),
  ])
  const data = await answer('sn_dependencies', { table: 'incident', limit: 2, categories: ['businessRules', 'clientScripts', 'accessControls'] })
  const rules = data.categories.businessRules

  assert.deepEqual(data.tablesCovered, ['incident', 'task'])
  assert.deepEqual(Object.keys(data.categories), ['businessRules', 'clientScripts', 'accessControls'])
  assert.deepEqual({ status: rules.status, table: rules.table, query: rules.query, total: rules.total, truncated: rules.truncated }, { status: 'checked', table: 'sys_script', query: 'collectionINincident,task^active=true', total: 12, truncated: true })
  assert.deepEqual(rules.items[0], { name: 'Rule on task', sysId: 'a1', definedOn: 'task', active: true, customerUpdate: false, details: { when: 'before' } })
  assert.equal(rules.items[1].customerUpdate, true)
  // A client script of a parent table applies only if it is marked as inherited.
  assert.equal(data.categories.clientScripts.query, 'table=incident^active=true^NQtableINtask^applies_extended=true^active=true')
  assert.deepEqual(data.categories.accessControls.items[0], { name: 'incident.number', sysId: 'acl1', definedOn: 'incident', active: true, customerUpdate: false, details: { operation: 'read', type: 'record', decision_type: 'Allow If' } })
  assert.deepEqual(data.childTables, { direct: 1, descendants: 3, names: ['incident_child'], truncated: false })
  assert.ok(data.notCovered.length > 0)
  assert.equal(sentTo('sys_update_xml', 'stats').length, 1, 'one grouped lookup for all items')
  assert.equal(sentTo('sys_update_xml', 'stats')[0].query, 'nameINsys_script_a1,sys_script_a2,sys_script_client_c1,sys_security_acl_acl1')
})

test('sn_dependencies follows how each kind of configuration reaches a child table', async () => {
  const { answer } = await connect(dictionaryRoutes)
  const data = await answer('sn_dependencies', { table: 'incident' })
  const query = (key: string) => data.categories[key].query

  // Always: logic on the parent runs for the child.
  assert.equal(query('businessRules'), 'collectionINincident,task^active=true')
  assert.equal(query('uiActions'), 'tableINincident,task^active=true')
  // Only when the item says so.
  assert.equal(query('uiPolicies'), 'table=incident^active=true^NQtableINtask^inherit=true^active=true')
  assert.equal(query('dataPolicies'), 'model_table=incident^active=true^NQmodel_tableINtask^inherit=true^active=true')
  assert.equal(query('flowRecordTriggers'), 'table=incident^active=true^NQtableINtask^run_on_extended=true^active=true')
  // Never: these create or fill records of exactly the table they name.
  assert.equal(query('transformMaps'), 'target_table=incident^active=true')
  assert.equal(query('inboundEmailActions'), 'table=incident^active=true')
  assert.equal(query('recordProducers'), 'table_name=incident^active=true')
  assert.equal(query('databaseViews'), 'table=incident^active=true')
  assert.equal(query('workflows'), 'tableINincident,task^published=true^active=true')
  assert.equal(query('referencedBy'), 'referenceINincident,task^internal_typeINreference,glide_list^active=true')
  assert.equal(Object.keys(data.categories).length, 21)
})

test('sn_dependencies looks up customer updates in chunks, and never with a name it cannot trust', async () => {
  const { answer, call, sentTo } = await connect([
    { table: 'sys_db_object', query: 'name=incident_sla', rows: [] },
    { table: 'sys_db_view', query: 'name=incident_sla', rows: [{ sys_id: 'a'.repeat(32), name: 'incident_sla', label: 'Incident SLA' }] },
    { table: 'sys_db_view_table', rows: [{ table: 'incident', variable_prefix: 'inc' }] },
    ...dictionaryRoutes,
    { table: 'sys_script', rows: Array.from({ length: 50 }, (_, index) => rule(`r${index}`, 'incident')) },
    {
      table: 'sys_ui_action',
      rows: [
        { sys_id: 'u1', sys_name: 'Odd', sys_update_name: 'a^ORb=1', table: 'incident', active: 'true' },
        { sys_id: 'u2', sys_name: 'Fine', sys_update_name: 'sys_ui_action_u2', table: 'incident', active: 'true' },
      ],
    },
    stats('sys_update_xml', { sys_script_r0: 1, sys_ui_action_u2: 1 }),
  ])
  const data = await answer('sn_dependencies', { table: 'incident', categories: ['businessRules', 'uiActions'], limit: 50 })

  const lookups = sentTo('sys_update_xml', 'stats').map((entry) => entry.query)
  assert.equal(lookups.length, 2, '51 names in chunks of 50')
  assert.ok(lookups.every((query) => !query.includes('a^ORb=1')))
  const [odd, fine] = data.categories.uiActions.items
  assert.equal('customerUpdate' in odd, false)
  assert.equal(fine.customerUpdate, true)

  assert.equal((await call('sn_dependencies', { table: 'incident_sla' })).data.error, 'validation')
})

test('sn_dependencies marks a category it cannot vouch for, instead of listing unfiltered rows', async () => {
  const { answer } = await connect([
    ...dictionaryRoutes,
    // This instance has no "collection" field on the table: it would have ignored the condition.
    { table: 'sys_script', rows: [{ sys_id: 'a1', sys_name: 'Unrelated rule', active: 'true' }], total: 900 },
    { table: 'sys_ui_action', rows: [], total: 4 },
    { table: 'sys_ui_policy', status: 403 },
    { table: 'contract_sla', rows: [] },
  ])
  const data = await answer('sn_dependencies', { table: 'incident', categories: ['businessRules', 'uiActions', 'uiPolicies', 'slaDefinitions', 'workflows'] })

  assert.equal(data.categories.businessRules.status, 'not_checked')
  assert.match(data.categories.businessRules.reason, /no field collection on this instance/)
  assert.deepEqual(data.categories.businessRules.items, [])
  assert.match(data.categories.uiActions.reason, /4 row\(s\) match, but none is visible/)
  assert.match(data.categories.uiPolicies.reason, /could not be read \(acl\)/)
  assert.deepEqual({ status: data.categories.slaDefinitions.status, total: data.categories.slaDefinitions.total }, { status: 'checked', total: 0 })
  assert.match(data.categories.workflows.reason, /could not be read \(not_found\)/)
  assert.match(data.warnings.join(' '), /Not checked: businessRules, uiPolicies, uiActions, workflows/)
})

test('sn_dependencies leaves the customer-update flag out when it cannot tell', async () => {
  const { answer } = await connect([...dictionaryRoutes, { table: 'sys_script', rows: [rule('a1', 'incident')] }, { table: 'sys_update_xml', api: 'stats', status: 403 }])
  const data = await answer('sn_dependencies', { table: 'incident', categories: ['businessRules'], includeParents: false })

  assert.equal(data.categories.businessRules.query, 'collectionINincident^active=true')
  assert.equal('customerUpdate' in data.categories.businessRules.items[0], false)
  assert.match(data.warnings.join(' '), /Customer updates could not be looked up \(acl\)/)
})

test('sn_dependencies with a field lists what is tied to that one field', async () => {
  const { answer, call } = await connect([
    { table: 'sys_ui_policy_action', rows: [{ sys_id: 'p1', sys_update_name: 'sys_ui_policy_action_p1', table: 'incident', field: 'category', ui_policy: labelled('u1', 'Lock on close'), 'ui_policy.active': 'true', 'ui_policy.inherit': 'false', mandatory: labelled('ignore', 'Leave alone'), disabled: labelled('true', 'True') }] },
    { table: 'sys_script_client', rows: [] },
    { table: 'sys_security_acl', rows: [] },
    { table: 'sys_choice', query: 'element=category', rows: [{ sys_id: 'c1', name: 'incident', element: 'category', label: 'Hardware', value: 'hardware', inactive: 'false', language: 'en' }], total: 7 },
    { table: 'sys_ui_element', rows: [{ sys_id: 'e1', element: 'category', 'sys_ui_section.name': 'incident', 'sys_ui_section.view_name': '', 'sys_ui_section.caption': 'Notes' }] },
    { table: 'sys_dictionary', query: 'dependent_on_field=category', rows: [{ sys_id: 'd1', name: 'incident', element: 'subcategory', dependent_on_field: 'category', active: 'true' }] },
    stats('sys_update_xml', {}),
    ...dictionaryRoutes,
  ])
  const data = await answer('sn_dependencies', { table: 'incident', field: 'category', limit: 1 })

  assert.equal(data.field, 'category')
  assert.deepEqual(Object.keys(data.categories), ['uiPolicyActions', 'clientScripts', 'dataPolicyRules', 'accessControls', 'dictionaryOverrides', 'choices', 'formSections', 'listLayouts', 'dependentFields'])
  // The action of a policy on a parent table counts only if that policy is passed down to child tables.
  assert.equal(data.categories.uiPolicyActions.query, 'table=incident^field=category^ui_policy.active=true^NQtableINtask^ui_policy.inherit=true^field=category^ui_policy.active=true')
  assert.deepEqual(data.categories.uiPolicyActions.items[0], { name: 'Lock on close', sysId: 'p1', definedOn: 'incident', customerUpdate: false, details: { mandatory: 'Leave alone', disabled: 'True' } })
  assert.equal(data.categories.clientScripts.query, 'table=incident^field=category^active=true^NQtableINtask^applies_extended=true^field=category^active=true')
  assert.equal(data.categories.accessControls.query, 'nameINincident.category,task.category^active=true')
  assert.deepEqual({ total: data.categories.choices.total, truncated: data.categories.choices.truncated, item: data.categories.choices.items[0].name }, { total: 7, truncated: true, item: 'Hardware' })
  assert.equal(data.categories.formSections.items[0].name, 'default view')
  assert.equal(data.categories.dependentFields.items[0].name, 'incident.subcategory')
  // A table this instance does not have is "could not be checked".
  assert.equal(data.categories.dataPolicyRules.status, 'not_checked')
  assert.match(data.notCovered.join(' '), /conditions and scripts that mention the field/)

  assert.match((await call('sn_dependencies', { table: 'incident', field: 'categry' })).data.message, /similar: category/)
  assert.equal((await call('sn_dependencies', { table: 'incident', field: 'caller_id.email' })).data.error, 'validation')
  assert.match((await call('sn_dependencies', { table: 'incident', field: 'category', categories: ['businessRules'] })).data.message, /not available for a field/)
  assert.match((await call('sn_dependencies', { table: 'incident', categories: ['choices'] })).data.message, /not available without "field"/)
})

test('sn_dependencies with a field says what it could not verify, and makes up no names', async () => {
  // The dictionary hides rows from the account: a field that is not among the visible ones may still exist.
  const partial = await connect([
    { table: 'sys_dictionary', query: 'nameINincident,task', rows: [column('task', 'number')], total: 9 },
    // The instance does not know the field the forms are named by: the row comes back without it.
    { table: 'sys_ui_element', rows: [{ sys_id: 'e1', element: 'u_made_up', 'sys_ui_section.name': 'incident', 'sys_ui_section.caption': 'Notes' }] },
    stats('sys_update_xml', {}),
    ...dictionaryRoutes,
  ])
  const data = await partial.answer('sn_dependencies', { table: 'incident', field: 'u_made_up', categories: ['formSections'] })
  assert.match(data.warnings.join(' '), /could not be verified that "u_made_up" is a field of "incident"/)
  assert.equal(data.categories.formSections.items[0].name, 'e1', 'not "default view": the view could not be read')
})

test('sn_dependencies needs a real table', async () => {
  const { call } = await connect(dictionaryRoutes)
  assert.equal((await call('sn_dependencies', { table: 'no_such_table' })).data.error, 'not_found')
  assert.equal((await call('sn_dependencies', { table: 'incident', categories: ['everything'] })).isError, true)
})

// ------------------------------------------------------------- sn_instance

const sourceTables = ['sys_db_object', 'sys_dictionary', 'sys_dictionary_override', 'sys_choice', 'sys_db_view', 'sys_user_has_role', 'v_plugin', 'sys_scope', 'sys_app', 'sys_update_version', 'sys_metadata', 'upgrade_history_task']

test('sn_instance names the release, the account and what cannot be read', async () => {
  const { answer } = await connect([
    { table: 'sys_properties', rows: [{ name: 'glide.war', value: 'glide-zurich-07-01-2025__patch1.zip' }, { name: 'glide.script.use.sandbox', value: 'true' }] },
    { table: 'sys_update_xml', rows: [{ sys_id: '1' }], total: 321 },
    { table: 'sys_store_app', status: 403 },
    { table: 'sys_script', rows: [], total: 12 },
    { table: 'sys_user_has_role', rows: [{ 'role.name': 'admin' }, { 'role.name': 'itil' }] },
    upgradeRoutes[0],
    ...sourceTables.filter((table) => table !== 'sys_user_has_role').map((table) => ({ table, rows: [{ sys_id: '1' }] })),
  ])
  const data = await answer('sn_instance')

  assert.deepEqual(data.release, { build: 'glide-zurich-07-01-2025__patch1.zip', family: 'zurich' })
  assert.equal(data.scriptSandbox, 'true')
  assert.equal(data.counts.customerUpdates, 321)
  assert.equal(data.lastUpgrade.kind, 'patch')
  assert.equal(data.lastFamilyUpgrade.finished, '2026-09-25 17:41:09')
  assert.deepEqual(data.account, { roles: 2, admin: true, readOnlyRole: false })
  assert.equal(data.sources.sys_store_app, 'acl')
  assert.equal(data.sources.sys_script, 'row_restricted')
  assert.equal(data.sources.sys_dictionary, 'readable')
  assert.equal(data.sources.contract_sla, 'not_found')
  const warnings = data.warnings.join(' ')
  assert.match(warnings, /sys_store_app \(acl; used by sn_plugins\)/)
  assert.match(warnings, /admin role and not snc_read_only/)
  // No table "domain", and the property that changes what an unusable query returns is not set.
  assert.deepEqual({ domains: data.domains, invalid: data.invalidQueryReturnsNoRows }, { domains: null, invalid: null })
  assert.doesNotMatch(warnings, /domains|returns_no_rows/)
})

test('sn_instance names two settings that change what every answer means', async () => {
  const { answer } = await connect([
    { table: 'sys_properties', rows: [{ name: 'glide.war', value: 'glide-zurich-07-01-2025__patch1.zip' }, { name: 'glide.invalid_query.returns_no_rows', value: 'true' }] },
    // The table exists only where domain separation is installed.
    { table: 'domain', rows: [{ sys_id: '1' }], total: 7 },
    ...sourceTables.map((table) => ({ table, rows: [{ sys_id: '1' }] })),
  ])
  const data = await answer('sn_instance')
  assert.deepEqual({ domains: data.domains, invalid: data.invalidQueryReturnsNoRows }, { domains: 7, invalid: 'true' })
  const warnings = data.warnings.join(' ')
  assert.match(warnings, /separates its data into domains \(7 in the table "domain"\).*not a count over the whole instance/)
  assert.match(warnings, /answers a condition it cannot use with no rows, not with all rows/)
})

test('sn_instance says so when the release property is hidden', async () => {
  const { answer } = await connect([{ table: 'sys_properties', rows: [], total: 2 }, ...sourceTables.map((table) => ({ table, rows: [{ sys_id: '1' }] }))])
  const data = await answer('sn_instance')
  assert.equal(data.release.build, null)
  assert.match(data.warnings.join(' '), /glide\.war was not returned/)
  // Role rows that come back without a role name: the roles are not known, which is different from "none".
  assert.equal(data.account, null)

  const none = await connect([{ table: 'sys_user_has_role', rows: [] }, ...sourceTables.filter((table) => table !== 'sys_user_has_role').map((table) => ({ table, rows: [{ sys_id: '1' }] }))])
  assert.deepEqual((await none.answer('sn_instance')).account, { roles: 0, admin: false, readOnlyRole: false })

  // One name is visible, one is hidden: the hidden one could be "admin", so nothing is claimed.
  const some = await connect([{ table: 'sys_user_has_role', rows: [{ 'role.name': 'snc_read_only' }, { 'role.name': '' }] }, ...sourceTables.filter((table) => table !== 'sys_user_has_role').map((table) => ({ table, rows: [{ sys_id: '1' }] }))])
  assert.equal((await some.answer('sn_instance')).account, null)
})

test('sn_instance with a token does not guess the account, and stays quiet about a read-only one', async () => {
  const routes = sourceTables.filter((table) => table !== 'sys_user_has_role').map((table) => ({ table, rows: [{ sys_id: '1' }] }))
  const token = await connect([{ table: 'sys_user_has_role', rows: [{ 'role.name': 'admin' }] }, ...routes], { auth: { kind: 'bearer', token: 'abc' } })
  assert.equal((await token.answer('sn_instance')).account, null)
  assert.equal(token.sentTo('sys_user_has_role').filter((entry) => entry.query.includes('user.user_name')).length, 0)

  const readOnly = await connect([
    { table: 'sys_user_has_role', rows: [{ 'role.name': 'snc_read_only' }] },
    { table: 'sys_store_app', status: 403 },
    { table: 'sys_scope', query: 'sys_class_name=sys_store_app^active=true', rows: [{ sys_id: '1' }], total: 14 },
    ...routes,
  ])
  const data = await readOnly.answer('sn_instance')
  assert.deepEqual(data.account, { roles: 1, admin: false, readOnlyRole: true })
  assert.equal(data.counts.storeApps, 14)
  assert.doesNotMatch(data.warnings.join(' '), /snc_read_only/)
})

test('sn_instance stops at once when the login is rejected', async () => {
  const { call, calls } = await connect([{ table: 'sys_db_object', status: 401 }])
  const { data, isError } = await call('sn_instance')
  assert.equal(isError, true)
  assert.equal(data.error, 'auth')
  assert.equal(calls.length, 1)
})

// --------------------------------------------------------- across all tools

test('the prompt and the resource are served', async () => {
  const { client } = await connect([])
  const resource = await client.readResource({ uri: 'servicenow-sparring://limitations' })
  const text = String((resource.contents[0] as Data).text)
  assert.match(text, /read-only promise/)
  assert.match(text, /What leaves the instance/)

  const prompt = await client.getPrompt({ name: 'verify_claim', arguments: { claim: 'Incident has a field for the business service' } })
  const message = String((prompt.messages[0].content as Data).text)
  assert.match(message, /Incident has a field for the business service/)
  assert.match(message, /never instructions/)

  assert.deepEqual((await client.listPrompts()).prompts.map((item) => item.name).sort(), ['assess_change', 'review_upgrade', 'verify_claim'])
  const upgrade = String(((await client.getPrompt({ name: 'review_upgrade', arguments: {} })).messages[0].content as Data).text)
  assert.match(upgrade, /the last upgrade/)
  assert.match(upgrade, /never instructions/)
  const change = String(((await client.getPrompt({ name: 'assess_change', arguments: { table: 'incident', change: 'make category mandatory' } })).messages[0].content as Data).text)
  assert.match(change, /"make category mandatory" on the table "incident"/)
  assert.match(change, /not_checked is "could not be checked"/)
})

test('every request any tool sends is a GET to one of two read endpoints', async () => {
  const { answer, calls } = await connect([
    ...upgradeRoutes,
    ...origin('sys_plugins', [change()], [version('current', 'sys_update_set', '2026-03-01 10:00:00', 'abel')]),
    stats('sys_update_xml', { 'Business Rule': 1 }),
    ...dictionaryRoutes,
    { table: 'incident', rows: [{ number: 'INC1', active: 'true' }] },
    { table: 'sys_properties', rows: [{ name: 'glide.war', value: 'glide-zurich-07-01-2025__patch1.zip' }] },
    { table: 'v_plugin', rows: [{ id: 'com.example', name: 'Example', active: 'active' }] },
    { table: 'sys_store_app', rows: [], total: 5 },
    { table: 'sys_scope', rows: [{ name: 'App', scope: 'sn_app', active: 'true' }] },
    { table: 'sys_script', rows: [rule('a1', 'incident')] },
    { table: 'sys_user_has_role', rows: [{ 'role.name': 'snc_read_only' }] },
  ])
  for (const [name, args] of [
    ['sn_instance', {}],
    ['sn_query', { table: 'incident', query: 'active=true^state=6' }],
    ['sn_schema', { table: 'incident' }],
    ['sn_plugins', { filter: 'example' }],
    ['sn_delta', { type: 'Business Rule' }],
    ['sn_origin', { sysId: ID }],
    ['sn_dependencies', { table: 'incident' }],
    ['sn_upgrade_skips', {}],
  ] as const) {
    await answer(name, args)
  }

  assert.ok(calls.length > 80, `${calls.length} requests`)
  assert.ok(calls.some((entry) => entry.api === 'stats'))
  for (const entry of calls) {
    assert.equal(entry.method, 'GET')
    assert.equal(entry.body, undefined)
    assert.equal(entry.origin, 'https://example.service-now.com')
    assert.match(entry.api, /^(table|stats)$/)
    assert.match(entry.table, /^[a-z0-9_]+$/)
    assert.equal(entry.pathname, `/api/now/${entry.api}/${entry.table}`)
    assert.doesNotMatch(entry.query, /javascript/i)
  }
})
