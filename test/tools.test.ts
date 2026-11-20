import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { AuditEntry } from '../src/client.js'
import type { InstanceConfig } from '../src/config.js'
import { buildServer, createContext } from '../src/server.js'
import { accountRoles } from '../src/tools/instance.js'
import { queryByContent } from '../src/tools/origin.js'
import { capturedByName, isClosedRecord, LOOKS_SECRET, payloadTables, scrubSecrets } from '../src/tools/shared.js'
import { closedTables, column, dictionaryRoutes, fakeInstance, isProof, knownTables, labelled, tableRow, type Route } from './fake.js'

type Data = Record<string, any>

async function connect(routes: Route[], overrides: Partial<InstanceConfig> = {}, audit?: (entry: AuditEntry) => void) {
  const { sn, calls } = fakeInstance(routes, overrides, audit)
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
  // The question that has to match nothing, which the server asks before it relies on a condition on a class field,
  // is listed apart: a test that counts the requests to a table means the ones that read it.
  const sentTo = (table: string, api = 'table') => calls.filter((entry) => entry.table === table && entry.api === api && !isProof(entry))
  const proofsFrom = (table: string) => calls.filter((entry) => entry.table === table && isProof(entry)).map((entry) => entry.query)
  return { client, call, answer, calls, sentTo, proofsFrom }
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
  // Four to check the names, three to ask what stands between the table and its answer (rules that run on every
  // read, archive rules, a rotation), one for the rows.
  assert.equal(data.requests, 8)
})

test('sn_query says when a table archives its records or drops old rows', async () => {
  // Measured: 40 active archive rules and 49 rotated tables on one instance. syslog keeps 8 parts of 7 days.
  const { answer, sentTo } = await connect([
    { table: 'sys_db_object', query: 'name=syslog', rows: [tableRow('syslog', 'Log')] },
    { table: 'sys_dictionary', query: 'nameINsyslog', rows: [column('syslog', 'source'), column('syslog', 'sys_created_on', 'glide_date_time')] },
    { table: 'sys_archive', query: 'tableINincident,task', rows: [{ sys_id: 'a1', table: 'incident', active: 'true' }] },
    { table: 'sys_archive', rows: [] },
    { table: 'sys_table_rotation', query: 'name=syslog', rows: [{ name: 'syslog', type: 'rotate', duration: '1970-01-08 00:00:00', rotations: '8' }] },
    { table: 'sys_table_rotation', rows: [] },
    ...dictionaryRoutes,
    { table: 'incident', rows: [{ number: 'INC1' }] },
    { table: 'syslog', rows: [] },
  ])
  const incident = await answer('sn_query', { table: 'incident', query: 'active=false', fields: ['number'] })
  assert.match(incident.warnings.join(' '), /1 archive rule moves records of this table into an archive table \(ar_incident\).*sys_archive, tableINincident,task\^active=true/)

  const log = await answer('sn_query', { table: 'syslog', query: 'source=my_integration^sys_created_on<2026-01-01', fields: ['source'] })
  assert.match(log.warnings.join(' '), /This table is rotated: it keeps about 56 days \(8 parts of 7 days\), and older rows are gone/)
  assert.doesNotMatch(log.warnings.join(' '), /archive rule/)
  // Asked once per table, not with every query.
  await answer('sn_query', { table: 'syslog', fields: ['source'] })
  assert.equal(sentTo('sys_table_rotation').length, 2)

  // Where the tables that would say so cannot be read, the answer says what it did not check: that is not "none".
  const blind = await connect([{ table: 'sys_archive', status: 403 }, { table: 'sys_table_rotation', status: 403 }, ...dictionaryRoutes, { table: 'incident', rows: [] }])
  const unsure = await blind.answer('sn_query', { table: 'incident', fields: ['number'] })
  assert.deepEqual(unsure.warnings, [
    'Not checked: whether records of this table are moved to an archive (sys_archive: acl); whether old rows of this table are dropped by rotation (sys_table_rotation: acl). Rows and total can be fewer than what was once there.',
  ])

  // A rotation shorter than a day is not rounded to nothing: eight parts of six hours are two days.
  const short = await connect([
    { table: 'sys_db_object', query: 'name=syslog', rows: [tableRow('syslog', 'Log')] },
    { table: 'sys_dictionary', query: 'nameINsyslog', rows: [column('syslog', 'source')] },
    { table: 'sys_table_rotation', rows: [{ name: 'syslog', type: 'rotate', duration: '1970-01-01 06:00:00', rotations: '8' }] },
    ...dictionaryRoutes,
    { table: 'syslog', rows: [] },
  ])
  assert.match((await short.answer('sn_query', { table: 'syslog', fields: ['source'] })).warnings.join(' '), /keeps about 2 days \(8 parts of 0\.25 days\)/)
})

test('sn_query says when business rules run on every read of the table', async () => {
  // Measured: 183 such rules on one instance. They add conditions that depend on who asks.
  const rules = (rows: Array<Record<string, string>>, total = rows.length): Route => ({ table: 'sys_script', query: 'action_query=true', rows, total })
  const incident = { table: 'incident', rows: [{ number: 'INC1' }] }

  const { answer, sentTo } = await connect([rules([{ sys_id: 'r1', action_query: 'true' }], 2), ...dictionaryRoutes, incident, stats('incident', { '1': 1 })])
  const data = await answer('sn_query', { table: 'incident', fields: ['number'] })
  assert.match(data.warnings.join(' '), /2 business rules run on every read of this table.*what they let this account see.*sys_script, collectionINincident,task\^action_query=true\^active=true/)
  // Counting is a read too. The rules of a table are asked for once, not with every query.
  assert.match((await answer('sn_query', { table: 'incident', groupBy: 'state' })).warnings.join(' '), /2 business rules run on every read/)
  assert.equal(sentTo('sys_script').length, 1)

  const none = await connect([rules([]), ...dictionaryRoutes, incident])
  assert.deepEqual((await none.answer('sn_query', { table: 'incident', fields: ['number'] })).warnings, [])

  // Not readable, or the instance does not know the field that marks such a rule: nothing is claimed, and the answer
  // says that it was not checked. "Could not be checked" is not "there are none".
  for (const [route, kind] of [[{ table: 'sys_script', status: 403 }, 'acl'], [rules([{ sys_id: 'r1' }], 500), 'invalid_response']] as Array<[Route, string]>) {
    const blind = await connect([route, ...dictionaryRoutes, incident])
    assert.deepEqual((await blind.answer('sn_query', { table: 'incident', fields: ['number'] })).warnings, [
      `Not checked: whether business rules hide rows on every read (sys_script: ${kind}). Rows and total can be fewer than what was once there.`,
    ])
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

})

test('a choice field reached by a dot-walk is checked against the list of the table the walk ends on', async () => {
  const problem: Route[] = [
    { table: 'sys_db_object', query: 'name=problem', rows: [tableRow('problem', 'Problem', 'task')] },
    { table: 'sys_dictionary', query: 'nameINproblem,task', rows: [column('problem', 'first_incident', 'reference', 'incident')] },
    { table: 'sys_dictionary', query: 'nameINincident,task', rows: [column('task', 'state', 'integer', '', { choice: '3' }), column('task', 'contact_type', 'string', '', { choice: '1' })] },
  ]
  const contactTypes = { table: 'sys_choice', query: 'element=contact_type', rows: [{ name: 'task', value: 'phone', label: 'By phone', language: 'en' }, { name: 'task', value: 'email', label: 'By mail', language: 'en' }] }
  const walked = await connect([...problem, contactTypes, ...dictionaryRoutes, { table: 'problem', rows: [] }])

  const refused = await walked.call('sn_query', { table: 'problem', query: 'first_incident.contact_type=By phone' })
  assert.equal(refused.data.error, 'validation')
  assert.match(refused.data.message, /"first_incident.contact_type" stores the value of a choice, not its label: "By phone" is the label of "phone"/)
  assert.equal(walked.sentTo('problem').length, 0)
  // The list asked for is the one of the table the reference points to, not of the queried table.
  assert.match(walked.sentTo('sys_choice').at(-1)!.query, /^nameINincident,task\^element=contact_type/)

  // A stored value passes without a warning, and an unknown one is explained when nothing matches.
  assert.deepEqual((await walked.answer('sn_query', { table: 'problem', query: 'first_incident.contact_typeINphone,email^first_incident.state=6' })).warnings, [])
  const odd = await walked.answer('sn_query', { table: 'problem', query: 'first_incident.contact_type=fax' })
  assert.match(odd.warnings.join(' '), /"fax" is not among the choice values of "first_incident.contact_type".*phone \(By phone\), email \(By mail\)/)
  // The list of incident, where the walk ends, and not the one of task, where "state" is defined.
  assert.match((await walked.call('sn_query', { table: 'problem', query: 'first_incident.state=Resolved' })).data.message, /"Resolved" is the label of "6"/)

  // Where the list cannot be read, the answer says that the values were not checked.
  const hidden = await connect([...problem, { table: 'sys_choice', status: 403 }, ...dictionaryRoutes, { table: 'problem', rows: [] }])
  const unchecked = await hidden.answer('sn_query', { table: 'problem', query: 'first_incident.contact_type=By phone' })
  assert.match(unchecked.warnings.join(' '), /"first_incident.contact_type" is a choice field, and its values could not be checked/)
  // On a number field a label is refused also where the choices could not be looked up: a word is not a number.
  assert.match((await hidden.call('sn_query', { table: 'problem', query: 'first_incident.state=Resolved' })).data.message, /holds a number, and "Resolved" is not one/)
})

test('the label of a choice is recognised in any language the instance has one in', async () => {
  // An account that reads German is shown "Gelöst", and an agent copies that into a query.
  const { call } = await connect([...dictionaryRoutes, { table: 'incident', rows: [] }])
  const { data } = await call('sn_query', { table: 'incident', query: 'state=Gelöst' })
  assert.equal(data.error, 'validation')
  assert.match(data.message, /"Gelöst" is the label of "6"/)
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

  // "How many different values" is answered whatever the page holds, the rows without a value forming one group.
  assert.equal(data.totalGroups, 3)
  assert.equal(data.nextOffset, 2)
  const rest = await answer('sn_query', { table: 'incident', query: 'active=true', groupBy: 'state', limit: 2, offset: 2 })
  assert.deepEqual({ groups: rest.groups, returned: rest.returned, offset: rest.offset, truncated: rest.truncated, totalGroups: rest.totalGroups, next: rest.nextOffset }, { groups: [{ value: '', count: 3 }], returned: 1, offset: 2, truncated: false, totalGroups: 3, next: undefined })

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
  assert.match((await noUsers.answer('sn_query', { table: 'incident', groupBy: 'watch_list' })).warnings.join(' '), /"watch_list" is a list\. It is counted by its whole content/)

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

test('a value of the wrong kind is refused: the instance would not reject it', async () => {
  // Measured on a table of 82 rows, 53 of them active and 12 created in 2026.
  const typed: Route[] = [
    {
      table: 'sys_dictionary',
      query: 'nameINincident,task',
      rows: [column('task', 'number'), column('task', 'active', 'boolean'), column('task', 'sys_created_on', 'glide_date_time'), column('task', 'due_date', 'glide_date'), column('task', 'reassignment_count', 'integer'), column('task', 'short_description'), column('task', 'business_duration', 'glide_duration'), column('task', 'u_cost', 'currency'), column('task', 'u_start', 'glide_time')],
    },
    ...dictionaryRoutes,
    { table: 'incident', rows: [{ number: 'INC1' }] },
  ]
  const { answer, call, sentTo } = await connect(typed)

  const refused: Array<[query: string, why: RegExp]> = [
    // ">" with a date the instance cannot read matched all 82 rows, "<" none.
    ['sys_created_on>01.01.2026', /holds a date.*YYYY-MM-DD/],
    ['sys_created_on>=01/01/2026', /holds a date/],
    ['sys_created_on>yesterday', /holds a date/],
    ['sys_created_on>2026', /holds a date/],
    ['sys_created_on<Jan 1 2026', /holds a date/],
    ['sys_created_on>2026-13-45 00:00:00', /holds a date/],
    ['sys_created_onBETWEEN01.01.2026@31.12.2026', /holds a date/],
    ['due_date=1.6.2026', /holds a date/],
    ['sys_created_onON2026-01-15@15.01.2026 00:00:00@2026-01-15 23:59:59', /holds a date/],
    // "active=yes" returned the 29 inactive rows.
    ['active=yes', /true\/false field.*"yes" would be compared as false/],
    ['active=on', /true\/false field/],
    ['activeINyes', /true\/false field/],
    ['active!=maybe', /true\/false field/],
    // "reassignment_count!=abc" returned no row at all.
    ['reassignment_count=abc', /holds a number, and "abc" is not one/],
    ['reassignment_count!=abc', /holds a number/],
    ['reassignment_count>abc', /holds a number/],
    ['reassignment_countIN1;2;3', /holds a number/],
    ['reassignment_countBETWEEN1@many', /holds a number/],
    // "priorityLIKE1" gave no row where "priority=1" gave 27, and "activeLIKEtrue" gave the 29 inactive rows.
    ['reassignment_countLIKE1', /LIKE matches nothing on a number field/],
    ['reassignment_countSTARTSWITH1', /STARTSWITH matches nothing on a number field/],
    ['reassignment_countNOT LIKE1', /NOT LIKE matches nothing on a number field/],
    ['activeLIKEtrue', /true\/false field, and LIKE does not compare text/],
    ['activeSTARTSWITHt', /true\/false field/],
    // "business_duration>3600" matched all 39 filled rows; the stored form is a date counted from 1970.
    ['business_duration>3600', /holds a duration.*One hour is 1970-01-01 01:00:00/],
    ['business_duration>01:00:00', /holds a duration/],
    // Measured as numbers too: currency, price, percent complete, order index, integer time, auto increment.
    ['u_cost=abc', /holds a number, and "abc" is not one/],
    ['u_costLIKE1', /LIKE matches nothing on a number field/],
    // A time of day is stored on 1970-01-01. "=08:00:00" and ">12:00:00" matched nothing, "<12:00:00" every row.
    ['u_start=08:00:00', /holds a time of day.*1970-01-01 08:00:00/],
    ['u_start>12:00:00', /holds a time of day/],
    // A day that does not exist.
    ['sys_created_on>2026-02-31', /holds a date/],
    // Nor a time of day that does not exist.
    ['sys_created_on>2026-02-01 25:00:00', /holds a date/],
    ['sys_created_on>2026-02-01 10:61:00', /holds a date/],
    ['sys_created_on>2026-04-31 10:00:00', /holds a date/],
    // "activeBETWEENfoo@bar" and "activeONa@b@c" returned the 29 inactive rows, "reassignment_countONfoo@bar@baz" none.
    ['activeBETWEENfoo@bar', /BETWEEN is for dates, and "active" is a true\/false field/],
    ['activeONa@b@c', /ON is for dates/],
    ['activeBETWEENtrue@false', /BETWEEN is for dates/],
    ['reassignment_countONfoo@bar@baz', /ON is for dates, and "reassignment_count" holds a number/],
    // NULL means "empty" only behind = and !=. "sys_created_on>NULL", "<NULL" and "BETWEENNULL@NULL" matched none of 82 rows.
    ['sys_created_on>NULL', /NULL stands for "empty" only behind = and !=.*sys_created_onISEMPTY/],
    ['sys_created_onBETWEENNULL@NULL', /NULL stands for "empty"/],
    ['reassignment_countIN1,NULL', /NULL stands for "empty"/],
    ['short_descriptionINNULL', /NULL stands for "empty"/],
    // A list of nothing: "reassignment_countIN," matched none.
    ['reassignment_countIN,', /needs at least one value in its list/],
    ['short_descriptionNOT IN, ,', /needs at least one value in its list/],
  ]
  for (const [query, why] of refused) {
    const { data } = await call('sn_query', { table: 'incident', query, fields: ['number'] })
    assert.equal(data.error, 'validation', query)
    assert.match(data.message, why, query)
  }
  assert.equal(sentTo('incident').length, 0)

  // Every one of these was applied as written when measured.
  const accepted = [
    'sys_created_on>=2026-01-01 00:00:00', 'sys_created_on>=2026-01-01', 'sys_created_on>=2026-1-1', 'sys_created_on>=2026-01-01T00:00:00Z', 'sys_created_on>=2026-01-01 00:00',
    'sys_created_onBETWEEN2026-01-01@2026-12-31', 'sys_created_on=', 'due_date!=', 'sys_created_onON2026-01-15@2026-01-15 00:00:00@2026-01-15 23:59:59',
    'active=true', 'active=TRUE', 'active=1', 'active=0', 'active!=false', 'activeINtrue,false',
    'reassignment_count=1', 'reassignment_count= 1', 'reassignment_count>=0', 'reassignment_countIN1, 2', 'reassignment_count=1.0', 'reassignment_countBETWEEN2@4', 'reassignment_count=NULL',
    // Measured: "=NULL" and "!=NULL" are "is empty" and "is not empty" on every kind of field, an empty entry in a list is
    // skipped ("priorityIN1," matched what "priorityIN1" did), and a blank around a value is ignored.
    'sys_created_on=NULL', 'sys_created_on!=NULL', 'active!=NULL', 'reassignment_countIN1,', 'sys_created_on> 2026-03-03', 'active= true', 'sys_created_on>2024-02-29',
    'business_duration>1970-01-01 01:00:00', 'business_durationISNOTEMPTY', 'u_cost>100', 'u_cost=12.50', 'u_start>1970-01-01 12:00:00', 'u_start=NULL',
    // Measured: LIKE and STARTSWITH on a date work on its stored text.
    'sys_created_onSTARTSWITH2026-0', 'sys_created_onLIKE2026',
    // On a text field any value is a value.
    'short_description=yes', 'short_descriptionLIKE01.01.2026',
  ]
  for (const query of accepted) assert.equal((await answer('sn_query', { table: 'incident', query, fields: ['number'] })).returned, 1, query)
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

  // Without a list of fields the row carries the journal field too, and it is as empty.
  const whole = await answer('sn_query', { table: 'incident' })
  assert.match(whole.warnings.join(' '), /work_notes: a journal field comes back empty unless displayValue is true/)
  // Nothing to count by: the field itself holds nothing.
  const counted = await call('sn_query', { table: 'incident', groupBy: 'work_notes' })
  assert.equal(counted.data.error, 'validation')
  assert.match(counted.data.message, /is a journal field.*Count there instead: element=work_notes/)
  assert.equal(sentTo('incident', 'stats').length, 0)
})

test('a closed table is reached neither through its child tables nor through its parent', async () => {
  const family: Route[] = [
    { table: 'sys_db_object', query: 'name=customer_contact', rows: [tableRow('customer_contact', 'Contact', 'sys_user')] },
    { table: 'sys_dictionary', query: 'nameINcustomer_contact,sys_user', rows: [column('sys_user', 'name'), column('customer_contact', 'account')] },
    { table: 'sys_dictionary', query: 'nameINincident,task', rows: [column('task', 'number'), column('task', 'sys_class_name', 'sys_class_name'), column('incident', 'u_contact', 'reference', 'customer_contact')] },
    { table: 'sys_dictionary', query: 'nameINtask', rows: [column('task', 'number'), column('task', 'sys_class_name', 'sys_class_name')] },
    ...dictionaryRoutes,
    { table: 'customer_contact', rows: [{ name: 'Abel Tuter' }] },
    { table: 'incident', rows: [{ number: 'INC1' }] },
    { table: 'task', rows: [{ number: 'TASK1' }] },
    stats('task', { '1': 1 }),
  ]

  // A contact is a user: the rows of the child table are rows of the closed one.
  const noUsers = await connect(family, { tables: { allow: [], deny: ['sys_user'] } })
  for (const args of [{ table: 'customer_contact', fields: ['name'] }, { table: 'incident', fields: ['number', 'u_contact.account'] }]) {
    const { data } = await noUsers.call('sn_query', args)
    assert.equal(data.error, 'blocked', JSON.stringify(args))
    assert.match(data.message, /"customer_contact" is a child table of sys_user/)
  }
  assert.equal(noUsers.sentTo('customer_contact').length + noUsers.sentTo('incident').length, 0)
  // No closed table is below task, so its answer is not filtered and carries no note about closed tables.
  const plain = await noUsers.answer('sn_query', { table: 'task', query: 'numberSTARTSWITHTASK', fields: ['number'] })
  assert.equal(noUsers.sentTo('task')[0].query, 'numberSTARTSWITHTASK')
  assert.deepEqual(plain.warnings, [])

  // And "task" holds every incident: with incident closed, its rows are kept out of what the parent answers. So are
  // the rows of the tables below a closed one, which are closed under whatever name, and those a pattern matches.
  const below = closedTables(
    tableRow('incident', 'Incident', 'task'),
    tableRow('u_major_incident', 'Major incident', 'incident', 'task'),
    tableRow('sc_req_item', 'Requested item', 'task'),
    tableRow('u_special_request', 'Special request', 'sc_req_item', 'task'),
    tableRow('sc_cat_item', 'Catalog item', 'sys_metadata'),
  )
  const noIncidents = await connect([below, ...family], { tables: { allow: [], deny: ['incident', 'sc_*'] } })
  const LEFT_OUT = 'sys_class_nameNOT INincident,sc_req_item,u_major_incident,u_special_request^ORsys_class_nameISEMPTY'
  const data = await noIncidents.answer('sn_query', { table: 'task', query: 'numberSTARTSWITHTASK^NQnumberSTARTSWITHINC', fields: ['number'] })
  assert.equal(noIncidents.sentTo('task')[0].query, `numberSTARTSWITHTASK^${LEFT_OUT}^NQnumberSTARTSWITHINC^${LEFT_OUT}`)
  assert.match(data.warnings.join(' '), /Rows that belong to a closed child table of this one were left out/)
  await noIncidents.answer('sn_query', { table: 'task', groupBy: 'sys_class_name' })
  assert.equal(noIncidents.sentTo('task', 'stats')[0].query, LEFT_OUT)
  // The list of closed tables is asked for once, by every level of parents, and for the table of tables as proof.
  const asked = noIncidents.sentTo('sys_db_object').filter((call) => call.query.includes('^ORname=sys_db_object'))
  assert.equal(asked.length, 1)
  assert.match(asked[0].query, /^nameINincident\^ORnameSTARTSWITHsc_\^ORsuper_class\.nameINincident\^ORsuper_class\.nameSTARTSWITHsc_\^ORsuper_class\.super_class\.nameINincident/)

  // With a list of the only tables that may be read, the rows of every other child table are left out.
  const children: Route = { table: 'sys_db_object', query: '^ORname=task', rows: [tableRow('task', 'Task'), tableRow('incident', 'Incident', 'task')] }
  const onlyTasks = await connect([children, ...family], { tables: { allow: ['task', 'sys_*'], deny: [] } })
  const some = await onlyTasks.answer('sn_query', { table: 'task', fields: ['number'] })
  assert.equal(onlyTasks.sentTo('task')[0].query, 'sys_class_nameINtask^ORsys_class_nameSTARTSWITHsys_^ORsys_class_nameISEMPTY')
  assert.equal(some.query, onlyTasks.sentTo('task')[0].query, 'the answer names the query that was sent')
  // Where the tables below cannot be listed, it cannot be told which rows belong to a closed one: a class that is
  // on the list can still be closed by a parent between it and this table. Nothing is sent.
  const unlisted = await connect([{ table: 'sys_db_object', exact: 'name=task', rows: [tableRow('task', 'Task')] }, ...family.filter((route) => route.query !== 'name=task')], { tables: { allow: ['task', 'sys_*'], deny: [] } })
  const unsure = await unlisted.call('sn_query', { table: 'task', fields: ['number'] })
  assert.equal(unsure.data.error, 'blocked')
  assert.match(unsure.data.message, /the tables below "task" could not be listed/)
  assert.equal(unlisted.sentTo('task').length, 0)

  // A class that is on the list, below a table that is not: its rows are rows of that table, and they are left out
  // by name, because the list alone would let them through.
  const between: Route = { table: 'sys_db_object', query: '^ORname=task', rows: [tableRow('task', 'Task'), tableRow('incident', 'Incident', 'task'), tableRow('u_major_incident', 'Major incident', 'incident', 'task')] }
  const skipping = await connect([between, ...family], { tables: { allow: ['task', 'u_*', 'sys_*'], deny: [] } })
  await skipping.answer('sn_query', { table: 'task', fields: ['number'] })
  assert.equal(skipping.sentTo('task')[0].query, 'sys_class_nameNOT INu_major_incident^ORsys_class_nameISEMPTY^sys_class_nameINtask^ORsys_class_nameSTARTSWITHu_^ORsys_class_nameSTARTSWITHsys_^ORsys_class_nameISEMPTY')
  // And where every table below is on the list, nothing is left out and nothing is said.
  const everything = await connect([children, ...family], { tables: { allow: ['task', 'incident', 'sys_*'], deny: [] } })
  const all = await everything.answer('sn_query', { table: 'task', fields: ['number'] })
  assert.equal(everything.sentTo('task')[0].query, '')
  assert.deepEqual(all.warnings, [])
})

test('where the child tables of a closed table cannot be listed, nothing is sent', async () => {
  const world = (answer: Route): Route[] => [
    answer,
    { table: 'sys_dictionary', query: 'nameINtask', rows: [column('task', 'number'), column('task', 'sys_class_name', 'sys_class_name')] },
    ...dictionaryRoutes,
    { table: 'task', rows: [{ number: 'TASK1' }] },
  ]
  const cases: Array<[string, Route, RegExp]> = [
    // An instance that answers a query it cannot use with no rows would show no closed table at all.
    ['no row at all', { table: 'sys_db_object', query: '^ORname=sys_db_object', rows: [] }, /did not answer the query as written/],
    // An instance that drops the conditions answers with tables that match none of them.
    ['a row that matches nothing', closedTables(tableRow('problem', 'Problem', 'task')), /ignored the conditions/],
    ['rows hidden from the account', { ...closedTables(tableRow('incident', 'Incident', 'task')), total: 9 }, /could not be read completely/],
    ['not readable', { table: 'sys_db_object', query: '^ORname=sys_db_object', status: 403 }, /could not be read: acl/],
  ]
  for (const [name, route, why] of cases) {
    const { call, sentTo } = await connect(world(route), { tables: { allow: [], deny: ['incident'] } })
    const { data } = await call('sn_query', { table: 'task', fields: ['number'] })
    assert.equal(data.error, 'blocked', name)
    assert.match(data.message, /the list of their child tables could not be established/, name)
    assert.match(data.message, why, name)
    assert.equal(sentTo('task').length, 0, name)
  }
})

/** A small world with a family of tables on each side of a reference: contacts are users, incidents are tasks. */
function familyWorld(extra: Route[] = []): Route[] {
  const one = (name: string, ...parents: string[]): Route => ({ table: 'sys_db_object', exact: `name=${name}`, rows: [tableRow(name, name, ...parents)] })
  return [
    ...extra,
    one('customer_contact', 'sys_user'),
    one('task_sla'),
    one('sys_update_xml'),
    one('sys_script', 'sys_metadata'),
    one('sys_ui_section'),
    { table: 'sys_dictionary', query: 'nameINcustomer_contact,sys_user', rows: [column('sys_user', 'name'), column('customer_contact', 'account')] },
    {
      table: 'sys_dictionary',
      query: 'nameINincident,task',
      rows: [
        column('task', 'number'),
        column('task', 'sys_class_name', 'sys_class_name'),
        column('task', 'parent', 'reference', 'task'),
        column('incident', 'caller_id', 'reference', 'sys_user'),
        column('incident', 'u_contact', 'reference', 'customer_contact'),
        column('incident', 'u_owner', 'reference', ''),
        column('incident', 'u_watchers', 'glide_list', ''),
      ],
    },
    // The longer name first: a route matches by a part of the query.
    { table: 'sys_dictionary', query: 'nameINtask_sla', rows: [column('task_sla', 'task', 'reference', 'task'), column('task_sla', 'stage')] },
    { table: 'sys_dictionary', query: 'nameINtask', rows: [column('task', 'number'), column('task', 'sys_class_name', 'sys_class_name'), column('task', 'parent', 'reference', 'task')] },
    { table: 'sys_dictionary', query: 'nameINsys_update_xml', rows: [column('sys_update_xml', 'name'), column('sys_update_xml', 'target_name'), column('sys_update_xml', 'type'), column('sys_update_xml', 'payload')] },
    ...dictionaryRoutes,
  ]
}

test('the name behind a reference is left out where the record can be a row of a closed table', async () => {
  const noUsers = { tables: { allow: [], deny: ['sys_user'] } }
  const users = closedTables(tableRow('sys_user', 'User'), tableRow('customer_contact', 'Contact', 'sys_user'))
  const row = { number: 'INC1', u_contact: labelled(ID, 'Abel Tuter'), u_owner: labelled(ID, 'Beth Anglin'), u_watchers: labelled(ID, 'Carol Coughlin') }
  const group = { table: 'incident', api: 'stats' as const, rows: [{ stats: { count: '3' }, groupby_fields: [{ field: 'u_contact', value: ID, display_value: 'Abel Tuter' }] }] }
  const world = familyWorld([users, { table: 'incident', rows: [row] }, group])

  // A contact is a user. The reference points to the child table, which no list names: the name is left out all the same.
  const { answer, call, sentTo } = await connect(world, noUsers)
  const read = await answer('sn_query', { table: 'incident', fields: ['number', 'u_contact', 'u_owner', 'u_watchers'], displayValue: true })
  assert.deepEqual(read.records, [{ number: 'INC1', u_contact: ID, u_owner: ID, u_watchers: ID }])
  assert.match(read.warnings.join(' '), /closed on this machine were left out: u_contact\./)
  // A reference or a list whose target did not come back can point anywhere.
  assert.match(read.warnings.join(' '), /could not be told which table these fields point to, so their display values were left out: u_owner, u_watchers/)
  assert.doesNotMatch(JSON.stringify(read), /Abel|Beth|Carol/)

  const counted = await answer('sn_query', { table: 'incident', groupBy: 'u_contact' })
  assert.deepEqual(counted.groups, [{ value: ID, count: 3 }])
  assert.equal(sentTo('incident', 'stats')[0].params.get('sysparm_display_value'), null)
  assert.match(counted.warnings.join(' '), /were left out: u_contact/)

  // Comparing with text or sorting works on those names.
  for (const query of ['u_contactSTARTSWITHAbel', 'ORDERBYu_contact', 'u_ownerLIKEBeth', 'ORDERBYDESCu_watchers']) {
    const { data } = await call('sn_query', { table: 'incident', query, fields: ['number'] })
    assert.equal(data.error, 'blocked', query)
    assert.match(data.message, /Comparing it with text or sorting by it works on the names/, query)
  }
  assert.equal((await answer('sn_query', { table: 'incident', query: `u_contact=${ID}^u_ownerISNOTEMPTY`, fields: ['number'] })).returned, 1)
})

test('with a list of the only tables that may be read, a name is left out where the record can be of a table that is not on it', async () => {
  // Users may be read, contacts may not: a contact is a row of the user table too, and a caller can be one.
  const listed = { tables: { allow: ['incident', 'task', 'sys_*'], deny: [] } }
  const usersAndContacts: Route = { table: 'sys_db_object', query: '^ORname=sys_user', rows: [tableRow('sys_user', 'User'), tableRow('customer_contact', 'Contact', 'sys_user')] }
  const row = { number: 'INC1', caller_id: labelled(ID, 'Abel Tuter'), parent: labelled(ID, 'TASK0000001') }
  const { answer, call, sentTo } = await connect(familyWorld([usersAndContacts, { table: 'incident', rows: [row] }, { table: 'sys_user', rows: [{ name: 'Abel Tuter' }] }]), listed)

  const read = await answer('sn_query', { table: 'incident', fields: ['number', 'caller_id', 'parent'], displayValue: true })
  // No table below task is missing from the list, so the name behind "parent" stays.
  assert.deepEqual(read.records, [{ number: 'INC1', caller_id: ID, parent: { value: ID, display: 'TASK0000001' } }])
  assert.match(read.warnings.join(' '), /were left out: caller_id\./)
  assert.equal((await call('sn_query', { table: 'incident', query: 'caller_idSTARTSWITHAbel', fields: ['number'] })).data.error, 'blocked')

  // The user table itself answers without the rows of the classes that are not on the list.
  await answer('sn_query', { table: 'sys_user', fields: ['name'] })
  assert.equal(sentTo('sys_user')[0].query, 'sys_class_nameINincident,task^ORsys_class_nameSTARTSWITHsys_^ORsys_class_nameISEMPTY')
})

test('a reference into a parent table does not give away the rows of its closed child tables', async () => {
  const noIncidents = { tables: { allow: [], deny: ['incident'] } }
  const below = closedTables(tableRow('incident', 'Incident', 'task'), tableRow('u_major_incident', 'Major incident', 'incident', 'task'))
  const LEFT_OUT = 'task.sys_class_nameNOT INincident,u_major_incident^ORtask.sys_class_nameISEMPTY'
  const sla = { table: 'task_sla', rows: [{ stage: 'in_progress', task: labelled(ID, 'INC0010001'), 'task.number': 'INC0010001' }] }
  const group = { table: 'task_sla', api: 'stats' as const, rows: [{ stats: { count: '2' }, groupby_fields: [{ field: 'task', value: ID, display_value: 'INC0010001' }] }] }
  const { answer, call, sentTo } = await connect(familyWorld([below, sla, group, { table: 'task', rows: [{ number: 'TASK1' }] }]), noIncidents)

  // The task behind the reference can be an incident: its number is the name of a record of the closed table.
  const read = await answer('sn_query', { table: 'task_sla', fields: ['stage', 'task'], displayValue: true })
  assert.deepEqual(read.records, [{ stage: 'in_progress', task: ID }])
  assert.match(read.warnings.join(' '), /were left out: task\./)
  assert.deepEqual((await answer('sn_query', { table: 'task_sla', groupBy: 'task' })).groups, [{ value: ID, count: 2 }])
  assert.equal((await call('sn_query', { table: 'task_sla', query: 'taskSTARTSWITHINC', fields: ['stage'] })).data.error, 'blocked')

  // Walking the reference reads fields of the task. The rows whose task is of a closed class are left out.
  const walked = await answer('sn_query', { table: 'task_sla', query: 'stage=in_progress^NQstage=paused', fields: ['stage', 'task.number'] })
  assert.equal(sentTo('task_sla').at(-1)!.query, `stage=in_progress^${LEFT_OUT}^NQstage=paused^${LEFT_OUT}`)
  assert.equal(walked.query, sentTo('task_sla').at(-1)!.query)
  assert.match(walked.warnings.join(' '), /Rows that belong to a closed child table of this one were left out/)
  // A reference from a task to its parent task is such a walk as well, on top of the condition for the table itself.
  await answer('sn_query', { table: 'task', fields: ['number', 'parent.number'] })
  assert.equal(
    sentTo('task').at(-1)!.query,
    'parent.sys_class_nameNOT INincident,u_major_incident^ORparent.sys_class_nameISEMPTY^sys_class_nameNOT INincident,u_major_incident^ORsys_class_nameISEMPTY',
  )
})

test('a database view that joins a parent table leaves out the rows of its closed child tables', async () => {
  const view: Route[] = [
    { table: 'sys_db_object', exact: 'name=task_with_sla', rows: [] },
    { table: 'sys_db_view', query: 'name=task_with_sla', rows: [{ sys_id: 'd'.repeat(32), name: 'task_with_sla', label: 'Tasks with SLA' }] },
    { table: 'sys_db_view_table', rows: [{ table: 'task', variable_prefix: 'tsk' }, { table: 'task_sla', variable_prefix: 'sla' }] },
    { table: 'task_with_sla', rows: [{ tsk_number: 'TASK1' }] },
  ]
  // The questions that have to match nothing: the class empty and filled at once, and one of two names at once.
  // Beside them one row is asked for, to see that the view has rows at all.
  const PROOF = 'tsk_sys_class_nameISEMPTY^tsk_sys_class_nameISNOTEMPTY'
  const PROOFS = ['', PROOF, 'tsk_sys_class_nameINzz__no_such_class_a^tsk_sys_class_nameINzz__no_such_class_b']
  const below = closedTables(tableRow('incident', 'Incident', 'task'))
  const { answer, sentTo, proofsFrom } = await connect(familyWorld([below, ...view]), { tables: { allow: [], deny: ['incident'] } })
  const data = await answer('sn_query', { table: 'task_with_sla', fields: ['tsk_number'] })
  assert.deepEqual(sentTo('task_with_sla').map((sent) => sent.query), ['tsk_sys_class_nameNOT INincident^ORtsk_sys_class_nameISEMPTY'])
  assert.match(data.warnings.join(' '), /Rows that belong to a closed child table of this one were left out/)
  // Asked once per view, not with every query.
  await answer('sn_query', { table: 'task_with_sla', fields: ['tsk_number'] })
  assert.deepEqual(proofsFrom('task_with_sla'), PROOFS)

  // A view can list the fields it shows. Where the instance drops a condition on the class, the question matches
  // rows, and then nothing is read: the rows of the closed table could not be left out.
  const dropping = await connect(familyWorld([below, { table: 'task_with_sla', exact: PROOF, rows: [{ tsk_number: 'INC1' }] }, ...view]), { tables: { allow: [], deny: ['incident'] } })
  const dropped = await dropping.call('sn_query', { table: 'task_with_sla', fields: ['tsk_number'] })
  assert.equal(dropped.data.error, 'blocked')
  assert.match(dropped.data.message, /could not be established that the instance applies a condition on "tsk_sys_class_name"/)
  assert.equal(dropping.sentTo('task_with_sla').length, 0)

  // A view that joins another view is not followed one level down, so whose rows it holds is not established.
  const nested: Route[] = [
    { table: 'sys_db_object', exact: 'name=outer_view', rows: [] },
    { table: 'sys_db_view', query: 'name=outer_view', rows: [{ sys_id: 'e'.repeat(32), name: 'outer_view', label: 'Outer' }] },
    { table: 'sys_db_view_table', query: `view=${'e'.repeat(32)}`, rows: [{ table: 'task_with_sla', variable_prefix: 'in' }] },
    { table: 'outer_view', rows: [{ in_tsk_number: 'INC1' }] },
  ]
  const outer = await connect(familyWorld([below, ...nested, ...view]), { tables: { allow: [], deny: ['incident'] } })
  const refused = await outer.call('sn_query', { table: 'outer_view' })
  assert.equal(refused.data.error, 'blocked')
  assert.match(refused.data.message, /"outer_view" is a database view that joins "task_with_sla", which is a view itself/)
  assert.equal(outer.sentTo('outer_view').length, 0)
})

test('rows of closed child tables are left out only after the instance showed that it applies the condition', async () => {
  const below = closedTables(tableRow('incident', 'Incident', 'task'))
  const world = (extra: Route[] = []) => familyWorld([below, ...extra, { table: 'task', rows: [{ number: 'TASK1' }] }, { table: 'task_sla', rows: [{ stage: 'x' }] }])
  const closed = { tables: { allow: [], deny: ['incident'] } }
  // Asked once per table and field: rows whose class is empty and filled at once, and rows whose class is one
  // of two names at once. No row is either. Beside them one row is asked for, to see that the table has rows.
  const questions = (field: string) => ['', `${field}ISEMPTY^${field}ISNOTEMPTY`, `${field}INzz__no_such_class_a^${field}INzz__no_such_class_b`]
  const fine = await connect(world(), closed)
  await fine.answer('sn_query', { table: 'task', fields: ['number'] })
  await fine.answer('sn_query', { table: 'task', fields: ['number'] })
  assert.deepEqual(fine.proofsFrom('task'), questions('sys_class_name'))
  await fine.answer('sn_query', { table: 'task_sla', fields: ['task.number'] })
  assert.deepEqual(fine.proofsFrom('task_sla'), questions('task.sys_class_name'))
  assert.equal(fine.sentTo('task_sla')[0].query, 'task.sys_class_nameNOT INincident^ORtask.sys_class_nameISEMPTY')

  // An instance that drops the condition for this account answers the question with a row, and one that gives no
  // total leaves it open. Either way nothing is read: the rows of the closed table could not be left out.
  const dropping = await connect(
    world([
      { table: 'task', exact: 'sys_class_nameISEMPTY^sys_class_nameISNOTEMPTY', rows: [{ sys_id: '1' }] },
      { table: 'task_sla', exact: 'task.sys_class_nameISEMPTY^task.sys_class_nameISNOTEMPTY', rows: [], noTotal: true },
    ]),
    closed,
  )
  for (const [table, fields, field] of [
    ['task', ['number'], 'sys_class_name'],
    ['task_sla', ['task.number'], 'task\\.sys_class_name'],
  ] as const) {
    const refused = await dropping.call('sn_query', { table, fields: [...fields] })
    assert.equal(refused.data.error, 'blocked', table)
    assert.match(refused.data.message, new RegExp(`could not be established that the instance applies a condition on "${field}" for this account`))
    assert.equal(dropping.sentTo(table).length, 0, table)
  }

  // "Is empty" applied and "is one of" dropped: an instance can allow the one and not the other.
  const half = await connect(world([{ table: 'task', exact: 'sys_class_nameINzz__no_such_class_a^sys_class_nameINzz__no_such_class_b', rows: [{ sys_id: '1' }] }]), closed)
  assert.equal((await half.call('sn_query', { table: 'task', fields: ['number'] })).data.error, 'blocked')
  assert.equal(half.sentTo('task').length, 0)

  // A list with a pattern leaves rows out by "starts with", which is asked as well, and a refusal there counts.
  const pattern = { tables: { allow: ['task', 'task_sla', 'sys_*', 'u_*'], deny: [] } }
  const starts = 'sys_class_nameSTARTSWITHzz__no_such_class_a^sys_class_nameSTARTSWITHzz__no_such_class_b'
  const allowing = (extra: Route[] = []) => familyWorld([...extra, { table: 'sys_db_object', query: '^ORname=task', rows: [tableRow('task', 'Task'), tableRow('incident', 'Incident', 'task')] }, { table: 'task', rows: [{ number: 'TASK1' }] }])
  const listed = await connect(allowing(), pattern)
  await listed.answer('sn_query', { table: 'task', fields: ['number'] })
  assert.deepEqual(listed.proofsFrom('task'), [...questions('sys_class_name'), starts])
  assert.equal(listed.sentTo('task')[0].query, 'sys_class_nameINtask,task_sla^ORsys_class_nameSTARTSWITHsys_^ORsys_class_nameSTARTSWITHu_^ORsys_class_nameISEMPTY')
  const refusing = await connect(allowing([{ table: 'task', exact: starts, rows: [{ sys_id: '1' }] }]), pattern)
  assert.equal((await refusing.call('sn_query', { table: 'task', fields: ['number'] })).data.error, 'blocked')
  assert.equal(refusing.sentTo('task').length, 0)
})

test('a table without rows proves nothing about a condition, and its answer is not remembered', async () => {
  // Every question that has to match nothing is answered with nothing by an empty table, also by an instance that
  // would have dropped the condition. Rows that come later must not be read on the strength of that.
  const below = closedTables(tableRow('incident', 'Incident', 'task'))
  const closed = { tables: { allow: [], deny: ['incident'] } }
  const empty = await connect(familyWorld([below, { table: 'task', rows: [] }]), closed)
  await empty.answer('sn_query', { table: 'task', fields: ['number'] })
  await empty.answer('sn_query', { table: 'task', fields: ['number'] })
  assert.equal(empty.proofsFrom('task').length, 6, 'asked again for the second query')
  // With a row in the table the proof holds, and is asked for once.
  const filled = await connect(familyWorld([below, { table: 'task', rows: [{ number: 'TASK1' }] }]), closed)
  await filled.answer('sn_query', { table: 'task', fields: ['number'] })
  await filled.answer('sn_query', { table: 'task', fields: ['number'] })
  assert.equal(filled.proofsFrom('task').length, 3)

  // An answer that says "no row matches" and carries a row all the same is no proof.
  const odd = await connect(familyWorld([below, { table: 'task', exact: 'sys_class_nameISEMPTY^sys_class_nameISNOTEMPTY', rows: [{ sys_id: '1' }], total: 0 }, { table: 'task', rows: [{ number: 'TASK1' }] }]), closed)
  assert.equal((await odd.call('sn_query', { table: 'task', fields: ['number'] })).data.error, 'blocked')
  assert.equal(odd.sentTo('task').length, 0)
})

test('a proof that the instance applies a condition is kept for ten minutes, not for good', async (t) => {
  // An access rule can be added while the server runs. What was proven is asked for again after a while.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-20T10:00:00Z') })
  const below = closedTables(tableRow('incident', 'Incident', 'task'))
  const { answer, proofsFrom } = await connect(familyWorld([below, { table: 'task', rows: [{ number: 'TASK1' }] }]), { tables: { allow: [], deny: ['incident'] } })
  await answer('sn_query', { table: 'task', fields: ['number'] })
  t.mock.timers.tick(9 * 60_000)
  await answer('sn_query', { table: 'task', fields: ['number'] })
  assert.equal(proofsFrom('task').length, 3)
  t.mock.timers.tick(2 * 60_000)
  await answer('sn_query', { table: 'task', fields: ['number'] })
  assert.equal(proofsFrom('task').length, 6)
})

test('the name and the payload of a captured change are kept back where its record is in a closed table', async () => {
  const noUsers = { tables: { allow: [], deny: ['sys_user'] } }
  const users = closedTables(tableRow('sys_user', 'User'), tableRow('customer_contact', 'Contact', 'sys_user'))
  const payload = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?><record_update>${inner}</record_update>`
  const rows = [
    { name: `sys_user_${ID}`, target_name: 'Abel Tuter', type: 'User', payload: payload('<sys_user action="INSERT_OR_UPDATE"><name>Abel Tuter</name></sys_user>') },
    { name: `customer_contact_${ID}`, target_name: 'Beth Anglin', type: 'Contact', payload: payload('<customer_contact action="INSERT_OR_UPDATE"><name>Beth Anglin</name></customer_contact>') },
    // The record of an open table first, then one of a closed table: measured, most payloads carry more than one element.
    { name: `sys_ui_section_${ID}`, target_name: 'Incident form', type: 'Form section', payload: payload('<sys_ui_section action="INSERT_OR_UPDATE"><caption/></sys_ui_section><sys_user action="DELETE"><name>Carol Coughlin</name></sys_user>') },
    { name: NAME, target_name: 'Example rule', type: 'Business Rule', payload: payload('<sys_script action="INSERT_OR_UPDATE"><name>Example rule</name><sys_created_by display_value="Dan Smith">dan</sys_created_by></sys_script>') },
    // Nothing in it names a table the instance knows.
    { name: 'u_odd_thing', target_name: 'Odd', type: 'Other', payload: '<something>else</something>' },
    // Nothing in it names a table at all.
    { name: 'u_plain_text', target_name: 'Plain', type: 'Other', payload: 'no record in here, only a line of text' },
  ]
  const { answer, call, sentTo } = await connect(familyWorld([users, { table: 'sys_update_xml', rows }]), noUsers)
  const WITHHELD = '[withheld: the record is in a table closed on this machine]'

  // The update name is read along, because it says which table the record is in. It is not added to the answer.
  const names = await answer('sn_query', { table: 'sys_update_xml', fields: ['target_name'] })
  assert.equal(sentTo('sys_update_xml')[0].params.get('sysparm_fields'), 'target_name,name')
  assert.deepEqual(names.records, [{ target_name: WITHHELD }, { target_name: WITHHELD }, { target_name: 'Incident form' }, { target_name: 'Example rule' }, { target_name: 'Odd' }, { target_name: 'Plain' }])
  assert.match(names.warnings.join(' '), /2 record name\(s\) were withheld/)

  const payloads = await answer('sn_query', { table: 'sys_update_xml', fields: ['name', 'payload'] })
  assert.deepEqual(payloads.records.map((item: Data) => item.payload === WITHHELD), [true, true, true, false, true, true])
  // What is passed on names nobody: a payload carries the name behind every reference of its record.
  assert.match(payloads.records[3].payload, /<sys_created_by display_value="\[withheld\]">dan<\/sys_created_by>/)
  assert.doesNotMatch(JSON.stringify(payloads), /Abel|Beth|Carol|Dan Smith/)
  assert.match(payloads.warnings.join(' '), /5 payload\(s\) were withheld/)

  // The names could be found out by trying, so they are not compared, sorted by or counted.
  for (const args of [{ query: 'target_nameSTARTSWITHAbel' }, { query: 'ORDERBYtarget_name' }, { groupBy: 'target_name' }]) {
    const { data } = await call('sn_query', { table: 'sys_update_xml', fields: ['name'], ...args })
    assert.equal(data.error, 'blocked', JSON.stringify(args))
    assert.match(data.message, /holds the readable names of records of other tables/)
  }

  // Without closed tables nothing of this applies.
  const open = await connect(familyWorld([{ table: 'sys_update_xml', rows }]))
  assert.equal((await open.answer('sn_query', { table: 'sys_update_xml', fields: ['target_name'] })).records[0].target_name, 'Abel Tuter')
  assert.equal((await open.answer('sn_query', { table: 'sys_update_xml', query: 'target_nameSTARTSWITHAbel', fields: ['name'] })).returned, 6)
})

test('the rules for closed tables hold for the request of any tool, not only for a query the agent wrote', async () => {
  // Asked through the client, as a tool does that builds a query of its own. Nothing here passes a check of sn_query.
  const view = 'd'.repeat(32)
  const routes: Route[] = [
    closedTables(tableRow('customer_contact', 'Contact', 'sys_user')),
    { table: 'sys_db_object', exact: 'name=customer_contact', rows: [tableRow('customer_contact', 'Contact', 'sys_user')] },
    { table: 'sys_db_view', query: 'name=user_view', rows: [{ sys_id: view, name: 'user_view', label: 'Users' }] },
    { table: 'sys_db_view_table', query: `view=${view}`, rows: [{ table: 'sys_user', variable_prefix: 'usr' }] },
    ...dictionaryRoutes,
    { table: 'customer_contact', rows: [{ name: 'Beth Anglin' }] },
    { table: 'user_view', rows: [{ usr_name: 'Abel Tuter' }] },
    { table: 'u_ghost', rows: [{ name: 'Carol Coughlin' }] },
    { table: 'incident', rows: [{ number: 'INC1' }] },
  ]
  const { sn, calls } = fakeInstance(routes, { tables: { allow: [], deny: ['sys_user'] } })
  createContext(sn)
  const outcome = (run: () => Promise<unknown>) => run().then(() => 'sent', (error) => `${error.kind}: ${error.message}`)
  // A child table of a closed table, as rows and as counts.
  assert.match(await outcome(() => sn.query({ table: 'customer_contact' })), /^blocked: "customer_contact" is a child table of sys_user/)
  assert.match(await outcome(() => sn.groupCount('customer_contact', 'name')), /^blocked: "customer_contact" is a child table of sys_user/)
  // A database view that joins a closed table. Its fields carry no dot, so no path gives it away.
  assert.match(await outcome(() => sn.query({ table: 'user_view', fields: ['usr_name'] })), /^blocked: "user_view" is a database view, and "sys_user" is closed on this machine/)
  // What the instance lists neither as a table nor as a view: nothing says whose rows it holds.
  assert.match(await outcome(() => sn.query({ table: 'u_ghost' })), /^blocked: It could not be established what "u_ghost" is/)
  // A path the dictionary cannot follow: which tables the request reads from is not established.
  assert.match(await outcome(() => sn.query({ table: 'incident', fields: ['u_nowhere.name'] })), /^blocked: .*could not be established which tables this request reads from/)
  for (const table of ['customer_contact', 'user_view', 'u_ghost', 'incident']) assert.equal(calls.filter((call) => call.table === table).length, 0, table)
})

test('a table with more closed child tables than a query can name is not read', async () => {
  // Each closed table below has to be named in the condition that leaves its rows out. A URL carries only so much.
  const children = Array.from({ length: 300 }, (_, index) => tableRow(`u_closed_child_with_a_long_name_${String(index).padStart(4, '0')}`, 'Child', 'u_closed_parent', 'task'))
  const routes: Route[] = [closedTables(tableRow('u_closed_parent', 'Parent', 'task'), ...children), ...dictionaryRoutes, { table: 'task', rows: [{ number: 'TASK1' }] }]
  const { call, sentTo } = await connect(routes, { tables: { allow: [], deny: ['u_closed_parent'] } })
  const { data } = await call('sn_query', { table: 'task', fields: ['number'] })
  assert.equal(data.error, 'blocked')
  assert.match(data.message, /"task" has more closed child tables below it than a query can leave out/)
  assert.equal(sentTo('task').length, 0)
})

test('a part of a rotated table, and the archive of a table, are closed with the table whose rows they hold', async () => {
  // Measured: "syslog0003" has no parent, is read like any table, and holds rows of syslog and of its child tables.
  // An archive table, "ar_<table>", has no parent either.
  const one = (name: string, ...parents: string[]): Route => ({ table: 'sys_db_object', exact: `name=${name}`, rows: [tableRow(name, name, ...parents)] })
  const tables = [one('syslog'), one('syslog0003'), one('fm_log0003', 'syslog0003'), one('ar_syslog'), one('u_report2024'), one('incident0001'), one('ar_task')]
  const rows = ['syslog', 'syslog0003', 'fm_log0003', 'ar_syslog', 'u_report2024', 'incident0001', 'ar_task'].map((table): Route => ({ table, rows: [{ sys_id: '1' }] }))
  const dictionary = ['syslog', 'syslog0003', 'fm_log0003,syslog0003', 'ar_syslog', 'u_report2024', 'incident0001', 'ar_task'].map((names): Route => ({ table: 'sys_dictionary', query: `nameIN${names}^`, rows: [column(names.split(',')[0], 'sys_id', 'GUID')] }))

  const closed = await connect([closedTables(tableRow('syslog', 'Log')), ...tables, ...dictionary, ...rows, ...dictionaryRoutes], { tables: { allow: [], deny: ['syslog'] } })
  for (const table of ['syslog0003', 'fm_log0003', 'ar_syslog']) {
    const { data } = await closed.call('sn_query', { table, fields: ['sys_id'] })
    assert.equal(data.error, 'blocked', table)
    assert.match(data.message, /holds rows of syslog \(a part of a rotated table, or its archive\), and "syslog" is closed on this machine/, table)
    assert.equal(closed.sentTo(table).length, 0, table)
    // Not described either.
    assert.equal((await closed.call('sn_schema', { table })).data.error, 'blocked', table)
  }
  // A name that only looks like a part: no table "u_report" exists.
  assert.equal((await closed.answer('sn_query', { table: 'u_report2024', fields: ['sys_id'] })).returned, 1)

  // A table that is open and has a closed table below it: its parts would answer with the rows of that table, and
  // only the table itself leaves them out.
  const below = await connect([closedTables(tableRow('incident', 'Incident', 'task')), ...tables, one('task0001'), { table: 'task0001', rows: [{ sys_id: '1' }] }, ...dictionary, ...rows, ...dictionaryRoutes], { tables: { allow: [], deny: ['incident'] } })
  for (const table of ['task0001', 'ar_task']) {
    const { data } = await below.call('sn_query', { table, fields: ['sys_id'] })
    assert.equal(data.error, 'blocked', table)
    assert.match(data.message, /holds rows of task .*, which has closed tables below it: ask "task" itself/, table)
  }
  assert.equal((await below.call('sn_query', { table: 'incident0001', fields: ['sys_id'] })).data.error, 'blocked')
  // The parts of a table that is open, with nothing closed below it, are read.
  assert.equal((await below.answer('sn_query', { table: 'syslog0003', fields: ['sys_id'] })).returned, 1)
  assert.equal((await below.answer('sn_query', { table: 'ar_syslog', fields: ['sys_id'] })).returned, 1)

  // Without closed tables nothing of this is asked.
  const open = await connect([...tables, ...dictionary, ...rows, ...dictionaryRoutes])
  await open.answer('sn_query', { table: 'syslog0003', fields: ['sys_id'] })
  assert.equal(open.calls.filter((call) => call.query === 'name=syslog').length, 0)
})

test('a database view that joins another view is not described either while tables are closed', async () => {
  const views: Route[] = [
    { table: 'sys_db_object', exact: 'name=outer_view', rows: [] },
    { table: 'sys_db_object', exact: 'name=inner_view', rows: [] },
    { table: 'sys_db_view', query: 'name=outer_view', rows: [{ sys_id: 'e'.repeat(32), name: 'outer_view', label: 'Outer' }] },
    { table: 'sys_db_view', query: 'name=inner_view', rows: [{ sys_id: 'f'.repeat(32), name: 'inner_view', label: 'Inner' }] },
    { table: 'sys_db_view_table', query: `view=${'e'.repeat(32)}`, rows: [{ table: 'inner_view', variable_prefix: 'in' }] },
    { table: 'sys_db_view_table', query: `view=${'f'.repeat(32)}`, rows: [{ table: 'incident', variable_prefix: 'inc' }] },
  ]
  const closed = await connect([...views, ...dictionaryRoutes], { tables: { allow: [], deny: ['sys_user'] } })
  for (const tool of ['sn_schema', 'sn_dependencies', 'sn_query']) {
    const { data } = await closed.call(tool, { table: 'outer_view' })
    assert.equal(data.error, 'blocked', tool)
    assert.match(data.message, /"outer_view" is a database view that joins "inner_view", which is a view itself/, tool)
  }
  // The inner view joins tables only, and none of them is closed.
  assert.equal((await closed.answer('sn_schema', { table: 'inner_view' })).table.name, 'inner_view')
})

test('a query of many parts is refused before the conditions for closed tables are written into each of them', async () => {
  // Each part joined by ^NQ takes the conditions once. Five hundred parts and a long list of closed tables would
  // be megabytes of text before the length was looked at.
  const children = Array.from({ length: 60 }, (_, index) => tableRow(`u_closed_child_${String(index).padStart(3, '0')}`, 'Child', 'u_closed_parent', 'task'))
  const routes: Route[] = [closedTables(tableRow('u_closed_parent', 'Parent', 'task'), ...children), ...dictionaryRoutes, { table: 'task', rows: [{ number: 'TASK1' }] }]
  const { call, sentTo } = await connect(routes, { tables: { allow: [], deny: ['u_closed_parent'] } })
  const started = Date.now()
  const { data } = await call('sn_query', { table: 'task', query: Array.from({ length: 500 }, () => 'number=1').join('^NQ'), fields: ['number'] })
  assert.equal(data.error, 'blocked')
  assert.match(data.message, /more closed child tables below it than a query can leave out/)
  assert.equal(sentTo('task').length, 0)
  assert.ok(Date.now() - started < 2_000, `${Date.now() - started} ms`)
})

test('a call that is refused because of a closed table is written to the audit log, whichever check refused it', async () => {
  // A person who reads the log wants to see what an agent tried, not only what was sent. Most refusals happen
  // before any request is made for the table that was asked for.
  const entries: AuditEntry[] = []
  const world: Route[] = [closedTables(tableRow('sys_user', 'User'), tableRow('sys_script', 'Business Rule', 'sys_metadata')), { table: 'sys_db_object', exact: 'name=sys_script', rows: [tableRow('sys_script', 'Business Rule', 'sys_metadata')] }, ...dictionaryRoutes, { table: 'incident', rows: [{ number: 'INC1' }] }]
  const { call } = await connect(world, { tables: { allow: [], deny: ['sys_user', 'sys_script'] } }, (entry) => entries.push(entry))
  const refusals = () => entries.filter((entry) => entry.status === 'blocked')

  const tried: Array<[string, Data, Partial<AuditEntry>]> = [
    ['sn_query', { table: 'sys_user', query: 'active=true', fields: ['name'] }, { tool: 'sn_query', table: 'sys_user', query: 'active=true', fields: ['name'] }],
    // The line names the table that was asked for, and what was asked of it.
    ['sn_query', { table: 'incident', fields: ['caller_id.name'] }, { tool: 'sn_query', table: 'incident', fields: ['caller_id.name'] }],
    ['sn_query', { table: 'incident', query: 'caller_idSTARTSWITHAbel' }, { tool: 'sn_query', table: 'incident', query: 'caller_idSTARTSWITHAbel' }],
    ['sn_query', { table: 'incident', groupBy: 'caller_id.name' }, { tool: 'sn_query', table: 'incident', fields: ['caller_id.name'] }],
    ['sn_schema', { table: 'sys_user' }, { tool: 'sn_schema', table: 'sys_user' }],
    ['sn_dependencies', { table: 'sys_user' }, { tool: 'sn_dependencies', table: 'sys_user' }],
    ['sn_origin', { updateName: NAME }, { tool: 'sn_origin', table: 'sys_metadata' }],
  ]
  for (const [index, [tool, args, line]] of tried.entries()) {
    const { data } = await call(tool, args)
    assert.equal(data.error, 'blocked', `${tool} ${JSON.stringify(args)}`)
    // One line for each refusal, not two where the client had written it down already.
    assert.equal(refusals().length, index + 1, `${tool} ${JSON.stringify(args)}`)
    const written = refusals().at(-1)!
    assert.equal(written.sent, 0)
    for (const [key, value] of Object.entries(line)) assert.deepEqual(written[key as keyof AuditEntry], value, `${tool} ${JSON.stringify(args)}: ${key}`)
  }
  // A call that was refused for another reason asked nothing of a closed table.
  await call('sn_query', { table: 'incident', query: 'no_such_field=1' })
  assert.equal(refusals().length, tried.length)

  // A request that the gate of the client refuses is written down there. The call it belongs to gets no second
  // line: here the instance drops the condition that would leave the rows of the closed table out.
  const once: AuditEntry[] = []
  const dropping: Route[] = [closedTables(tableRow('incident', 'Incident', 'task')), { table: 'task', exact: 'sys_class_nameISEMPTY^sys_class_nameISNOTEMPTY', rows: [{ sys_id: '1' }] }, ...dictionaryRoutes, { table: 'task', rows: [{ number: 'TASK1' }] }]
  const gated = await connect(dropping, { tables: { allow: [], deny: ['incident'] } }, (entry) => once.push(entry))
  assert.equal((await gated.call('sn_query', { table: 'task', fields: ['number'] })).data.error, 'blocked')
  assert.equal(once.filter((entry) => entry.status === 'blocked').length, 1)
})

test('one call does not send hundreds of requests, whatever it names', async () => {
  // Every "ref_<table>." in a query is looked up, twice where no such table exists: 730 of them were 1,460
  // requests before the query was refused.
  const lookups = await connect([...dictionaryRoutes, { table: 'incident', rows: [{ number: 'INC1' }] }])
  const many = await lookups.call('sn_query', { table: 'incident', query: Array.from({ length: 730 }, (_, index) => `ref_x${index.toString(36)}.a=`).join('^') })
  assert.equal(many.data.error, 'too_large')
  assert.match(many.data.message, /This call was stopped after 500 requests to the instance/)
  assert.equal(lookups.calls.length, 500)
  // The next call starts at nothing.
  assert.equal((await lookups.answer('sn_query', { table: 'incident', fields: ['number'] })).returned, 1)

  // The same condition a hundred and fifty times is one look-up, and a choice list that cannot be read is asked for once.
  const users: Route = { table: 'sys_user', rows: [{ sys_id: 'abel' }] }
  const same = await connect([{ table: 'sys_choice', status: 403 }, users, ...dictionaryRoutes, { table: 'incident', rows: [{ number: 'INC1' }] }])
  const data = await same.answer('sn_query', { table: 'incident', query: Array.from({ length: 150 }, () => 'assigned_to!=abel^state=1').join('^'), fields: ['number'] })
  assert.equal(same.sentTo('sys_user').length, 1)
  assert.equal(same.sentTo('sys_choice').length, 1)
  assert.equal(data.warnings.filter((warning: string) => /choice list could not be read/.test(warning)).length, 1)
})

test('a request longer than an instance takes is not sent', async () => {
  // Measured: an address of 8,218 characters was taken and one of 8,223 answered with HTTP 414. A caret and an
  // equals sign take three characters each, so a query of 6,000 characters can be one of 9,000 in the address.
  const { call, sentTo } = await connect([...dictionaryRoutes, { table: 'incident', rows: [{ number: 'INC1' }] }])
  const { data } = await call('sn_query', { table: 'incident', query: Array.from({ length: 700 }, () => 'number=1').join('^'), fields: ['number'] })
  assert.equal(data.error, 'validation')
  assert.match(data.message, /This request would be \d,\d{3}|This request would be \d{4,5} characters long/)
  assert.equal(sentTo('incident').length, 0)
  // An instance, or what stands in front of it, that takes less says so with HTTP 414.
  const short = await connect([...dictionaryRoutes, { table: 'incident', status: 414 }])
  assert.equal((await short.call('sn_query', { table: 'incident', fields: ['number'] })).data.error, 'bad_request')
})

test('rows nested deeper than a row of a table are an answer that cannot be used, not an error of the runtime', async () => {
  const deep = `{"result":[{"x":${'{"a":'.repeat(3_000)}"v"${'}'.repeat(3_000)}}]}`
  const { call } = await connect([...dictionaryRoutes, { table: 'incident', body: deep }])
  const { data } = await call('sn_query', { table: 'incident' })
  assert.equal(data.error, 'invalid_response')
  assert.match(data.message, /nested deeper than a row of a table is/)
})

test('with a list of the only tables that may be read, the tables the server decides from have to be open with their parents', async () => {
  // sys_db_object and sys_dictionary extend sys_metadata. A list that names the two and not their parent closes
  // them as child tables of a closed one, and then nothing can be established without reading a closed table.
  const foundation: Route[] = ['sys_db_object', 'sys_dictionary'].map((name) => ({ table: 'sys_db_object', exact: `name=${name}`, rows: [tableRow(name, name, 'sys_metadata')] }))
  const world = [...foundation, ...dictionaryRoutes, { table: 'incident', rows: [{ number: 'INC1' }] }]
  const narrow = await connect(world, { tables: { allow: ['sys_db_object', 'sys_dictionary', 'sys_db_view', 'sys_db_view_table', 'task', 'incident'], deny: [] } })
  const { data } = await narrow.call('sn_query', { table: 'incident', fields: ['number'] })
  assert.equal(data.error, 'blocked')
  assert.match(data.message, /"sys_db_object", which this server reads for every check, is a child table of sys_metadata, which is not on SERVICENOW_TABLE_ALLOW/)
  assert.equal(narrow.sentTo('incident').length, 0)
  // With the parent on the list, the same query is answered.
  const wide = await connect(world, { tables: { allow: ['sys_db_object', 'sys_dictionary', 'sys_db_view', 'sys_db_view_table', 'sys_metadata', 'task', 'incident'], deny: [] } })
  assert.equal((await wide.answer('sn_query', { table: 'incident', fields: ['number'] })).returned, 1)
})

test('the conditions for closed tables are measured as they stand in the address of the request', async () => {
  // Measured: a comma takes three characters there. 270 names of twenty characters are a query of 5,700 characters
  // and one of 6,300 in the address, which with the fields of a request is more than an instance takes.
  const children = Array.from({ length: 270 }, (_, index) => tableRow(`u_closed_child_t_${String(index).padStart(3, '0')}`, 'Child', 'u_closed_parent', 'task'))
  const routes: Route[] = [closedTables(tableRow('u_closed_parent', 'Parent', 'task'), ...children), ...dictionaryRoutes, { table: 'task', rows: [{ number: 'TASK1' }] }]
  const { call, sentTo } = await connect(routes, { tables: { allow: [], deny: ['u_closed_parent'] } })
  const { data } = await call('sn_query', { table: 'task', fields: ['number'] })
  assert.equal(data.error, 'blocked')
  assert.match(data.message, /more closed child tables below it than a query can leave out/)
  assert.equal(sentTo('task').length, 0)
})

test('sn_schema judges a table by what it extends now, not by what was read before', async () => {
  // Read once as a table of its own. Then it is made a child table of the closed one: asked for its structure,
  // the server reads what the table is anew, and that reading decides whether it is closed.
  const routes: Route[] = [
    { table: 'sys_db_object', exact: 'name=u_notes', rows: [tableRow('u_notes', 'Notes')] },
    { table: 'sys_dictionary', query: 'nameINu_notes', rows: [column('u_notes', 'u_text')] },
    ...dictionaryRoutes,
    { table: 'u_notes', rows: [{ u_text: 'x' }] },
  ]
  const { answer, call } = await connect(routes, { tables: { allow: [], deny: ['sys_user'] } })
  assert.equal((await answer('sn_query', { table: 'u_notes', fields: ['u_text'] })).returned, 1)
  routes.unshift({ table: 'sys_db_object', exact: 'name=u_notes', rows: [tableRow('u_notes', 'Notes', 'sys_user')] })
  const { data } = await call('sn_schema', { table: 'u_notes' })
  assert.equal(data.error, 'blocked')
  assert.match(data.message, /"u_notes" is a child table of sys_user/)
})

test('a text search is refused on a table that points into a table named after records of other tables', async () => {
  // Measured: a text search finds a record by the name behind one of its references. A captured change is named
  // after the record it changed, so a search on a table that points to captured changes would try out those names.
  const routes: Route[] = [
    { table: 'sys_db_object', exact: 'name=u_review', rows: [tableRow('u_review', 'Review')] },
    { table: 'sys_db_object', exact: 'name=sys_update_xml', rows: [tableRow('sys_update_xml', 'Customer Update')] },
    { table: 'sys_dictionary', query: 'nameINu_review', rows: [column('u_review', 'u_note'), column('u_review', 'u_change', 'reference', 'sys_update_xml')] },
    ...dictionaryRoutes,
    { table: 'u_review', rows: [{ u_note: 'x' }] },
  ]
  const closed = await connect(routes, { tables: { allow: [], deny: ['sys_user'] } })
  const { data } = await closed.call('sn_query', { table: 'u_review', query: '123TEXTQUERY321=Abel' })
  assert.equal(data.error, 'validation')
  assert.match(data.message, /"u_change" points into sys_update_xml, whose rows carry the names of records of other tables/)
  // With nothing closed, no name has to be kept back.
  const open = await connect(routes)
  assert.equal((await open.answer('sn_query', { table: 'u_review', query: '123TEXTQUERY321=Abel' })).returned, 1)
})

test('the text of comments and work notes is left out where the table of journal entries is closed', async () => {
  const fields: Route = { table: 'sys_dictionary', query: 'nameINincident,task', rows: [column('task', 'number'), column('task', 'work_notes', 'journal_input'), column('task', 'short_description')] }
  const row = { number: 'INC1', work_notes: labelled('', '2026-11-20 10:00:00 - Abel Tuter (Work notes)\nthe customer called again'), short_description: 'Printer' }
  const { answer } = await connect([fields, ...dictionaryRoutes, { table: 'incident', rows: [row] }], { tables: { allow: [], deny: ['sys_journal_field'] } })
  const data = await answer('sn_query', { table: 'incident', fields: ['number', 'work_notes', 'short_description'], displayValue: true })
  // The display value of a journal field is the text of its entries, and those are rows of the closed table.
  assert.deepEqual(data.records, [{ number: 'INC1', work_notes: '', short_description: 'Printer' }])
  assert.match(data.warnings.join(' '), /left out: work_notes/)
  // With the table open, the text comes.
  const open = await connect([fields, ...dictionaryRoutes, { table: 'incident', rows: [row] }])
  assert.match(JSON.stringify((await open.answer('sn_query', { table: 'incident', fields: ['work_notes'], displayValue: true })).records), /the customer called again/)
})

test('a closed table is not described either: not its fields, not what is attached to it, not the names a typo is close to', async () => {
  const closed = { tables: { allow: [], deny: ['sys_user'] } }
  const world = familyWorld([closedTables(tableRow('customer_contact', 'Contact', 'sys_user')), { table: 'customer_contact', rows: [{ name: 'Beth Anglin' }] }])
  const { call, sentTo, calls } = await connect(world, closed)
  // The table itself, and a child table of it, which no list names.
  for (const table of ['sys_user', 'customer_contact']) {
    for (const tool of ['sn_schema', 'sn_dependencies']) {
      const { data } = await call(tool, { table })
      assert.equal(data.error, 'blocked', `${tool} ${table}`)
      assert.match(data.message, /closed on this machine/, `${tool} ${table}`)
    }
  }
  // Nothing was asked about what is attached to it.
  assert.equal(calls.filter((entry) => ['sys_script', 'sys_security_acl', 'sys_documentation', 'sys_dictionary_override'].includes(entry.table)).length, 0)
  // A misspelled field of a child table is answered with the refusal, not with the names of fields that are close.
  const typo = await call('sn_query', { table: 'customer_contact', fields: ['acount'] })
  assert.equal(typo.data.error, 'blocked')
  assert.doesNotMatch(typo.data.message, /account/)
  assert.equal(sentTo('customer_contact').length, 0)
})

test('a tool that walks a reference of its own is held to the closed tables like a query', async () => {
  // sn_upgrade_skips reads the entries of an upgrade through a reference. With that table closed, nothing is sent.
  const world: Route[] = [
    closedTables(tableRow('sys_upgrade_history_log', 'Upgrade History Log')),
    { table: 'sys_db_object', exact: 'name=upgrade_history_task', rows: [tableRow('upgrade_history_task', 'Skipped change')] },
    { table: 'sys_dictionary', query: 'nameINupgrade_history_task', rows: [column('upgrade_history_task', 'upgrade_detail', 'reference', 'sys_upgrade_history_log'), column('upgrade_history_task', 'state', 'integer')] },
    ...dictionaryRoutes,
    { table: 'sys_upgrade_history', rows: [{ sys_id: ID, from_version: 'glide-zurich-07-01-2025__patch1.zip', to_version: 'glide-australia-02-11-2026__patch1.zip', upgrade_finished: '2026-09-25 17:00:00' }] },
    { table: 'upgrade_history_task', rows: [{ 'upgrade_detail.file_name': NAME, 'upgrade_detail.target_name': 'Example rule' }] },
    { table: 'upgrade_history_task', api: 'stats', rows: [] },
  ]
  const { call, sentTo } = await connect(world, { tables: { allow: [], deny: ['sys_upgrade_history_log'] } })
  const { data } = await call('sn_upgrade_skips', { upgrade: 'all' })
  assert.equal(data.error, 'blocked')
  assert.match(data.message, /reads from sys_upgrade_history_log through a dot-walk/)
  assert.equal(sentTo('upgrade_history_task').length + sentTo('upgrade_history_task', 'stats').length, 0)
})

test('the tables of a page of update names are asked for together, not name by name', async () => {
  // With a list of the only tables that may be read, the table of each record has to be found. Two hundred names
  // of dictionary entries share their beginnings: a handful of requests, where asking for each cut of each name
  // was hundreds.
  const rows = Array.from({ length: 200 }, (_, index) => ({ name: `sys_dictionary_incident_u_field_${index}`, type: 'Dictionary', target_name: `Field ${index}`, sys_created_by: 'abel', sys_updated_by: 'abel' }))
  const world: Route[] = [
    knownTables('sys_dictionary', 'incident'),
    { table: 'sys_db_object', exact: 'name=sys_update_xml', rows: [tableRow('sys_update_xml', 'Update')] },
    { table: 'sys_db_object', exact: 'name=sys_dictionary', rows: [tableRow('sys_dictionary', 'Dictionary')] },
    { table: 'sys_db_object', query: '^ORname=sys_update_xml', rows: [tableRow('sys_update_xml', 'Update')] },
    { table: 'sys_dictionary', query: 'nameINsys_update_xml', rows: [column('sys_update_xml', 'name'), column('sys_update_xml', 'target_name'), column('sys_update_xml', 'type'), column('sys_update_xml', 'sys_created_by'), column('sys_update_xml', 'sys_updated_by')] },
    ...dictionaryRoutes,
    { table: 'sys_update_xml', rows },
    stats('sys_update_xml', { Dictionary: 200 }),
  ]
  const { answer, calls } = await connect(world, { tables: { allow: ['sys_*', 'incident', 'task'], deny: [] } })
  const data = await answer('sn_delta', { limit: 200 })
  assert.equal(data.updates.length, 200)
  // The table is found and open, so the names stay.
  assert.equal(data.updates[7].target_name, 'Field 7')
  const asked = calls.filter((call) => call.table === 'sys_db_object' && /^nameIN[^^]*$/.test(call.query))
  assert.ok(asked.length >= 1 && asked.length <= 3, `${asked.length} requests for the tables of 200 names`)
  assert.ok(calls.length < 40, `${calls.length} requests in all`)
})

test('an update name is taken for a record of a closed table in every way it can be cut', async () => {
  const deny = (list: string[], closed: Route) => createContext(fakeInstance([closed, ...dictionaryRoutes], { tables: { allow: [], deny: list } }).sn)
  // With a deny list the closed tables are known by name, their child tables included.
  const noUsers = deny(['sys_user'], closedTables(tableRow('sys_user', 'User'), tableRow('customer_contact', 'Contact', 'sys_user')))
  for (const [name, closed] of [
    [`sys_user_${ID}`, true],
    // A sys_id is not always 32 hex digits.
    ['sys_user_admin', true],
    [`customer_contact_${ID}`, true],
    [NAME, false],
    ['sys_dictionary_incident_category', false],
  ] as const) {
    assert.equal(await isClosedRecord(noUsers, name), closed, name)
  }
  // A name built from what the record describes begins with its table as well.
  const noLabels = deny(['sys_documentation'], closedTables(tableRow('sys_documentation', 'Field Label', 'sys_metadata')))
  assert.equal(await isClosedRecord(noLabels, 'sys_documentation_incident_category_en'), true)
  assert.equal(await isClosedRecord(noLabels, NAME), false)
  // A list that closes the dictionary itself leaves nothing the server could check with: every record counts as closed.
  const noDictionary = deny(['sys_dictionary'], closedTables(tableRow('sys_dictionary', 'Dictionary Entry', 'sys_metadata')))
  assert.equal(await isClosedRecord(noDictionary, NAME), true)
  // No name at all: which record it is cannot be told.
  assert.equal(await isClosedRecord(noUsers, ''), true)
  // Measured: the instance compares a name without regard to case, so capitals are no way around the check.
  assert.equal(await isClosedRecord(noUsers, `SYS_USER_${ID.toUpperCase()}`), true)
  assert.equal(await isClosedRecord(noUsers, `Customer_Contact_${ID}`), true)
  // A text that is no update name is not cut into ten thousand pieces.
  const started = Date.now()
  assert.equal(await isClosedRecord(noUsers, 'a_'.repeat(50_000)), true)
  assert.ok(Date.now() - started < 500, `${Date.now() - started} ms`)

  // With a sys_id at the end, what stands before it is the table: a script include is no business rule. Where
  // something else follows, the table cannot be told, and any cut that is closed counts.
  const noRules = deny(['sys_script'], closedTables(tableRow('sys_script', 'Business Rule', 'sys_metadata')))
  assert.equal(await isClosedRecord(noRules, NAME), true)
  assert.equal(await isClosedRecord(noRules, `sys_script_include_${ID}`), false)
  assert.equal(await isClosedRecord(noRules, 'sys_script_include_my_util'), true)
  // A name that cannot begin with a table is the record of no closed one.
  assert.equal(await isClosedRecord(noRules, `My-App_${ID}`), false)
  // Measured: a linked application file is named after the record it links to, and its update name does not say
  // which table that record is of. While any table is closed, it counts as a record of a closed one.
  assert.equal(await isClosedRecord(noRules, `sys_metadata_link_${ID}`), true)

  // A table the deny list names counts whether or not the instance still lists it: the captured changes of a
  // table that was dropped are still there, with the names of its records.
  const dropped = deny(['u_legacy_hr', 'u_old_*'], closedTables())
  assert.equal(await isClosedRecord(dropped, `u_legacy_hr_${ID}`), true)
  assert.equal(await isClosedRecord(dropped, 'u_old_bonus_schedule_x'), true)
  assert.equal(await isClosedRecord(dropped, NAME), false)

  // With a list of the only tables that may be read, the table has to be found and be open.
  const scripts: Route[] = ['sys_script', 'sys_script_include', 'sys_documentation', 'sys_dictionary'].map((name) => ({ table: 'sys_db_object', exact: `name=${name}`, rows: [tableRow(name, name, 'sys_metadata')] }))
  const world = [knownTables('incident', 'task', 'sys_script', 'sys_script_include', 'sys_documentation', 'sys_dictionary', 'customer_contact'), ...scripts, ...dictionaryRoutes]
  const only = { tables: { allow: ['incident', 'task', 'sys_script', 'sys_metadata', 'sys_d*', 'sys_c*'], deny: [] } }
  const listed = createContext(fakeInstance(world, only).sn)
  assert.equal(await isClosedRecord(listed, `incident_${ID}`), false)
  assert.equal(await isClosedRecord(listed, `customer_contact_${ID}`), true)
  assert.equal(await isClosedRecord(listed, NAME), false)
  // Where it cannot be looked up what a name begins with, the record counts as closed.
  const unreadable = createContext(fakeInstance([{ table: 'sys_db_object', query: 'nameIN', status: 403 }, ...dictionaryRoutes], { tables: { allow: ['incident', 'task', 'sys_*'], deny: [] } }).sn)
  assert.equal(await isClosedRecord(unreadable, `incident_${ID}`), true)
  assert.equal(await isClosedRecord(listed, `sys_script_include_${ID}`), true)
  assert.equal(await isClosedRecord(listed, 'sys_script_include_my_util'), true)
  // No table of that name is known to the instance: what the record is cannot be told.
  assert.equal(await isClosedRecord(listed, 'sys_no_such_table_x'), true)
  // The table is found however many words follow it: a label and a dictionary entry are named after what they describe.
  assert.equal(await isClosedRecord(listed, 'sys_documentation_incident_short_description_en'), false)
  assert.equal(await isClosedRecord(listed, 'sys_dictionary_incident_u_my_custom_field'), false)
  // A name that cannot begin with a table does not end the call with an error. It is the record of no open table.
  assert.equal(await isClosedRecord(listed, `My-App_${ID}`), true)
  assert.equal(await isClosedRecord(listed, `${'a'.repeat(81)}_${ID}`), true)
  // Where the list of closed tables cannot be established, every record counts as closed.
  const blind = createContext(fakeInstance([{ table: 'sys_db_object', status: 403 }], { tables: { allow: [], deny: ['sys_user'] } }).sn)
  assert.equal(await isClosedRecord(blind, NAME), true)
  // Nothing is closed: nothing is asked.
  const open = fakeInstance([])
  assert.equal(await isClosedRecord(createContext(open.sn), `sys_user_${ID}`), false)
  assert.equal(open.calls.length, 0)
})

test('a text search is not a way to probe a field that holds a secret', async () => {
  const LEFT_OUT = 'typeNOT INpassword,password2'
  const world: Route[] = [
    { table: 'sys_db_object', query: 'name=sys_properties', rows: [tableRow('sys_properties', 'System Property')] },
    { table: 'sys_dictionary', query: 'nameINsys_properties', rows: [column('sys_properties', 'name'), column('sys_properties', 'value'), column('sys_properties', 'type')] },
    { table: 'sys_db_object', query: 'name=sys_update_xml', rows: [tableRow('sys_update_xml', 'Customer Update')] },
    { table: 'sys_dictionary', query: 'nameINsys_update_xml', rows: [column('sys_update_xml', 'name'), column('sys_update_xml', 'payload')] },
    ...dictionaryRoutes,
    { table: 'sys_user', rows: [{ name: 'Abel' }] },
    { table: 'incident', rows: [{ number: 'INC1' }] },
    { table: 'sys_properties', rows: [{ name: 'glide.war' }] },
    { table: 'sys_update_xml', rows: [{ name: NAME }] },
  ]
  const { answer, call, sentTo } = await connect(world)
  // It looks into fields the query does not name. sys_user has one that holds a secret. With or without a list of
  // fields to return: a search names no field, so nothing else in the call has to.
  for (const fields of [['name'], undefined]) {
    const refused = await call('sn_query', { table: 'sys_user', query: '123TEXTQUERY321=hash', fields })
    assert.equal(refused.data.error, 'validation')
    assert.match(refused.data.message, /text search.*fields that hold secrets \(user_password\)/)
  }
  assert.equal(sentTo('sys_user').length, 0)
  // A field that carries whole records is searched as well.
  assert.match((await call('sn_query', { table: 'sys_update_xml', query: '123TEXTQUERY321=secret', fields: ['name'] })).data.message, /"payload" holds whole records as text/)
  assert.equal(sentTo('sys_update_xml').length, 0)

  assert.equal((await answer('sn_query', { table: 'incident', query: '123TEXTQUERY321=printer', fields: ['number'] })).returned, 1)
  // The value of a property is among the fields a text search reads: the properties that hold secrets are left out,
  // again with or without a list of fields.
  for (const fields of [['name'], undefined]) {
    await answer('sn_query', { table: 'sys_properties', query: '123TEXTQUERY321=zurich', fields })
    assert.equal(sentTo('sys_properties').at(-1)!.query, `123TEXTQUERY321=zurich^${LEFT_OUT}`)
  }

  // Where the fields of the table cannot be read completely, there is no telling what the search looks into.
  const unreadable = dictionaryRoutes.map((route) => (route.table === 'sys_dictionary' && route.query === 'nameINincident,task' ? { table: 'sys_dictionary', query: route.query, status: 403 } : route))
  const blind = await connect([...unreadable, { table: 'incident', rows: [{ number: 'INC1' }] }])
  assert.match((await blind.call('sn_query', { table: 'incident', query: '123TEXTQUERY321=printer' })).data.message, /could not be read completely/)
  assert.equal(blind.sentTo('incident').length, 0)
  // The same where some of its fields are hidden from this account: one of those can be the one with the secret.
  const hiding = dictionaryRoutes.map((route) => (route.table === 'sys_dictionary' && route.query === 'nameINincident,task' ? { ...route, total: (route.rows?.length ?? 0) + 2 } : route))
  const halfBlind = await connect([...hiding, { table: 'incident', rows: [{ number: 'INC1' }] }])
  assert.match((await halfBlind.call('sn_query', { table: 'incident', query: '123TEXTQUERY321=printer' })).data.message, /could not be read completely/)
  assert.equal(halfBlind.sentTo('incident').length, 0)
  // A field whose type did not come back is judged by its name.
  const untyped = dictionaryRoutes.map((route) => (route.query === 'nameINsys_user' ? { ...route, rows: [column('sys_user', 'name'), column('sys_user', 'user_password', '')] } : route))
  const byName = await connect([...untyped, { table: 'sys_user', rows: [{ name: 'Abel' }] }])
  assert.match((await byName.call('sn_query', { table: 'sys_user', query: '123TEXTQUERY321=hash', fields: ['name'] })).data.message, /fields that hold secrets \(user_password\)/)

  // The table of properties is held to the same checks. Leaving out the properties of a password type covers
  // their values, not a field of the table that cannot be read or that points into a closed table.
  const properties = (fields: Route): Route[] => [{ table: 'sys_db_object', query: 'name=sys_properties', rows: [tableRow('sys_properties', 'System Property')] }, fields, ...dictionaryRoutes, { table: 'sys_properties', rows: [{ name: 'glide.war' }] }]
  const noFields = await connect(properties({ table: 'sys_dictionary', query: 'nameINsys_properties', status: 403 }))
  assert.match((await noFields.call('sn_query', { table: 'sys_properties', query: '123TEXTQUERY321=zurich' })).data.message, /could not be read completely/)
  assert.equal(noFields.sentTo('sys_properties').length, 0)
  const owned = { table: 'sys_dictionary', query: 'nameINsys_properties', rows: [column('sys_properties', 'name'), column('sys_properties', 'value'), column('sys_properties', 'type'), column('sys_properties', 'u_owner', 'reference', 'sys_user')] }
  const pointing = await connect(properties(owned), { tables: { allow: [], deny: ['sys_user'] } })
  assert.match((await pointing.call('sn_query', { table: 'sys_properties', query: '123TEXTQUERY321=Abel' })).data.message, /"u_owner" points into a table that is closed/)
  assert.equal(pointing.sentTo('sys_properties').length, 0)

  // Measured: a text search finds a record by the name behind one of its references. With the table of those records
  // closed, it would be a way to try out their names.
  const closed = await connect([...dictionaryRoutes, { table: 'incident', rows: [{ number: 'INC1' }] }], { tables: { allow: [], deny: ['sys_user'] } })
  const probing = await closed.call('sn_query', { table: 'incident', query: '123TEXTQUERY321=Abel', fields: ['number'] })
  assert.equal(probing.data.error, 'validation')
  assert.match(probing.data.message, /finds records by the names behind their references: "assigned_to" points into a table that is closed/)
  assert.equal(closed.sentTo('incident').length, 0)
})

test('a record in a closed table is not read by the other tools either, and its readable name is not passed on', async () => {
  const closed = { tables: { allow: [], deny: ['sys_script'] } }
  // The dictionary of the tables the tools read: without it, no request that walks a reference is sent while tables are closed.
  const world: Route[] = [
    closedTables(tableRow('sys_script', 'Business Rule', 'sys_metadata')),
    ...['sys_metadata', 'sys_package', 'sys_scope', 'sys_update_xml', 'sys_update_version', 'upgrade_history_task', 'sys_upgrade_history_log', 'sys_upgrade_history'].map((name) => ({
      table: 'sys_db_object',
      query: `name=${name}`,
      exact: `name=${name}`,
      rows: [tableRow(name, name)],
    })),
    { table: 'sys_dictionary', query: 'nameINsys_metadata', rows: [column('sys_metadata', 'sys_package', 'reference', 'sys_package'), column('sys_metadata', 'sys_scope', 'reference', 'sys_scope'), column('sys_metadata', 'sys_class_name', 'sys_class_name'), column('sys_metadata', 'sys_name')] },
    { table: 'sys_dictionary', query: 'nameINsys_package', rows: [column('sys_package', 'sys_class_name', 'sys_class_name'), column('sys_package', 'name')] },
    { table: 'sys_dictionary', query: 'nameINsys_scope', rows: [column('sys_scope', 'scope'), column('sys_scope', 'name')] },
    { table: 'sys_dictionary', query: 'nameINsys_update_xml', rows: [column('sys_update_xml', 'name'), column('sys_update_xml', 'target_name'), column('sys_update_xml', 'type')] },
    { table: 'sys_dictionary', query: 'nameINupgrade_history_task', rows: [column('upgrade_history_task', 'upgrade_detail', 'reference', 'sys_upgrade_history_log'), column('upgrade_history_task', 'state', 'integer')] },
    { table: 'sys_dictionary', query: 'nameINsys_upgrade_history_log', rows: [column('sys_upgrade_history_log', 'file_name'), column('sys_upgrade_history_log', 'target_name'), column('sys_upgrade_history_log', 'disposition', 'integer'), column('sys_upgrade_history_log', 'upgrade_history', 'reference', 'sys_upgrade_history')] },
    { table: 'sys_dictionary', query: 'nameINsys_upgrade_history', rows: [column('sys_upgrade_history', 'to_version')] },
    ...dictionaryRoutes,
  ]
  const row = { name: NAME, type: 'Business Rule', target_name: 'Example rule', sys_created_by: 'abel', sys_updated_by: 'abel' }
  const delta = await connect([...world, { table: 'sys_update_xml', rows: [row, { ...row, name: 'sys_ui_action_' + ID, target_name: 'Example action' }] }, stats('sys_update_xml', { 'Business Rule': 2 })], closed)
  const data = await delta.answer('sn_delta')
  assert.deepEqual(data.updates.map((item: Data) => item.target_name), ['[withheld: the record is in a table closed on this machine]', 'Example action'])

  // Asked for by its update name, which says where the record is, nothing is sent at all.
  const judged = await connect([...world, ...origin('sys_plugins', [], [], {}, [skip('Skipped')])], closed)
  const refused = await judged.call('sn_origin', { updateName: NAME })
  assert.equal(refused.data.error, 'blocked')
  assert.match(refused.data.message, /stands for a record in a table that is closed on this machine/)
  assert.equal(judged.sentTo('sys_metadata').length + judged.sentTo('sys_update_xml').length, 0)
  // Measured: the instance finds "sys_script_…" under "SYS_SCRIPT_…" as well. Capitals are no way around it.
  for (const name of [NAME.toUpperCase(), `Sys_Script_${ID}`]) {
    const shouted = await judged.call('sn_origin', { updateName: name })
    assert.equal(shouted.data.error, 'blocked', name)
  }
  assert.equal(judged.sentTo('sys_metadata').length + judged.sentTo('sys_update_xml').length + judged.sentTo('upgrade_history_task').length, 0)

  // Asked for by its sys_id, the table of application files is read without the rows of the closed table, so the
  // record is not found, and the answer says that rows were left out.
  const filtered = await connect(
    [...world, { table: 'sys_metadata', query: 'sys_class_nameNOT INsys_metadata_link,sys_script', rows: [] }, ...origin('sys_plugins', [], [], {}, [skip('Skipped')])],
    closed,
  )
  const answer = await filtered.answer('sn_origin', { sysId: ID })
  assert.equal(filtered.sentTo('sys_metadata')[0].query, `sys_id=${ID}^sys_class_nameNOT INsys_metadata_link,sys_script^ORsys_class_nameISEMPTY`)
  assert.equal(answer.record, null)
  assert.match(answer.warnings.join(' '), /Rows that belong to a closed child table of this one were left out/)
  assert.doesNotMatch(JSON.stringify(answer), /Example rule/)
  // Not "no such record": it can be one of the rows that were left out.
  assert.equal(answer.verdict, 'unknown')
  assert.match(answer.warnings.join(' '), /Application files of tables that are closed on this machine were left out of the look-up/)

  // A captured change gives the record away by its name. Found that way, nothing more is read of it.
  const traced = await connect(
    [...world, { table: 'sys_metadata', query: 'sys_class_nameNOT INsys_metadata_link,sys_script', rows: [] }, { table: 'sys_update_xml', query: `nameENDSWITH_${ID}`, rows: [{ name: NAME }] }, ...origin('sys_plugins', [change()], [], {}, [skip('Skipped')])],
    closed,
  )
  // The list of what an upgrade skipped names the record of a closed table by its file, not by its readable name.
  const entry = (file: string, target: string) => ({
    'upgrade_detail.file_name': file,
    'upgrade_detail.target_name': target,
    'upgrade_detail.type': 'Business Rule',
    'upgrade_detail.disposition': labelled('4', 'Skipped'),
    'upgrade_detail.upgrade_history.to_version': 'glide-australia-02-11-2026__patch1.zip',
    state: labelled('1', 'Not Reviewed'),
    sys_created_on: '2026-09-25 17:00:00',
  })
  const log = { table: 'sys_dictionary', query: 'nameINsys_upgrade_history_log', rows: ['file_name', 'target_name', 'type'].map((name) => column('sys_upgrade_history_log', name)).concat([column('sys_upgrade_history_log', 'disposition', 'integer'), column('sys_upgrade_history_log', 'upgrade_history', 'reference', 'sys_upgrade_history')]) }
  const skipped = await connect(
    [log, ...world, { table: 'upgrade_history_task', rows: [entry(NAME, 'Example rule'), entry(`sys_ui_action_${ID}`, 'Example action')] }, ...upgradeRoutes.filter((route) => !(route.table === 'upgrade_history_task' && (route.api ?? 'table') === 'table'))],
    closed,
  )
  const list = await skipped.answer('sn_upgrade_skips', {})
  assert.deepEqual(list.records.map((item: Data) => item.target), ['[withheld: the record is in a table closed on this machine]', 'Example action'])

  const stopped = await traced.call('sn_origin', { sysId: ID })
  assert.equal(stopped.data.error, 'blocked')
  assert.match(stopped.data.message, /This sys_id stands for a record in a table that is closed on this machine/)
  assert.equal(traced.sentTo('sys_update_version').length + traced.sentTo('upgrade_history_task').length, 0)
  assert.deepEqual(traced.sentTo('sys_update_xml').map((sent) => sent.query), [`nameENDSWITH_${ID}^ORDERBYDESCsys_updated_on`])
})

test('a field of an encrypted type is withheld and cannot be compared', async () => {
  const { answer, call } = await connect([
    { table: 'sys_db_object', query: 'name=u_vault', rows: [tableRow('u_vault', 'Vault')] },
    { table: 'sys_dictionary', query: 'nameINu_vault', rows: [column('u_vault', 'u_owner'), column('u_vault', 'u_blob', 'glide_encrypted')] },
    ...dictionaryRoutes,
    { table: 'u_vault', rows: [{ u_owner: 'abel', u_blob: 'encrypted-value' }] },
  ])
  assert.deepEqual((await answer('sn_query', { table: 'u_vault' })).records, [{ u_owner: 'abel', u_blob: '[withheld: this field holds a secret]' }])
  assert.equal((await call('sn_query', { table: 'u_vault', query: 'u_blobSTARTSWITHa' })).data.error, 'validation')

  // Measured: the instance takes "ref_<the table itself>.<field>" as another name for the field. With a dictionary that
  // is only partly readable, that name was checked against a row and found there, and the field under it was not known
  // to hold a secret. The name is refused whatever can be read.
  const partly = await connect([
    { table: 'sys_db_object', query: 'name=u_vault', rows: [tableRow('u_vault', 'Vault')] },
    { table: 'sys_dictionary', query: 'nameINu_vault', rows: [column('u_vault', 'u_owner'), column('u_vault', 'u_blob', 'glide_encrypted'), null] },
    ...dictionaryRoutes,
    { table: 'u_vault', rows: [{ u_owner: 'abel', u_blob: 'encrypted-value', 'ref_u_vault.u_blob': 'encrypted-value' }] },
  ])
  for (const args of [{ fields: ['ref_u_vault.u_blob'] }, { query: 'ref_u_vault.u_blobSTARTSWITHa', fields: ['u_owner'] }, { groupBy: 'ref_u_vault.u_blob' }]) {
    const { data } = await partly.call('sn_query', { table: 'u_vault', ...args })
    assert.equal(data.error, 'validation', JSON.stringify(args))
    assert.match(data.message, /"ref_u_vault\." names the table itself/)
  }
  assert.equal(partly.sentTo('u_vault').length, 0)
})

test('a field that can point to any table loses its names when tables are closed', async () => {
  const routes = [
    ...dictionaryRoutes.map((route) => (route.query === 'nameINincident,task' ? { ...route, rows: [...(route.rows ?? []), column('incident', 'u_doc', 'document_id')] } : route)),
    { table: 'incident', rows: [{ number: 'INC1', u_doc: labelled(ID, 'Abel Tuter') }] },
    { table: 'incident', api: 'stats' as const, rows: [{ stats: { count: '1' }, groupby_fields: [{ field: 'u_doc', value: ID, display_value: 'Abel Tuter' }] }] },
  ]
  const closed = await connect(routes, { tables: { allow: [], deny: ['sys_user'] } })
  assert.deepEqual((await closed.answer('sn_query', { table: 'incident', fields: ['u_doc'], displayValue: true })).records, [{ u_doc: ID }])
  assert.deepEqual((await closed.answer('sn_query', { table: 'incident', groupBy: 'u_doc' })).groups, [{ value: ID, count: 1 }])
  assert.equal((await closed.call('sn_query', { table: 'incident', query: 'u_docSTARTSWITHAbel' })).data.error, 'blocked')

  // With no table closed, the name is passed on, and the groups carry their labels.
  const open = await connect(routes)
  assert.deepEqual((await open.answer('sn_query', { table: 'incident', fields: ['u_doc'], displayValue: true })).records, [{ u_doc: { value: ID, display: 'Abel Tuter' } }])
  assert.deepEqual((await open.answer('sn_query', { table: 'incident', groupBy: 'u_doc' })).groups, [{ value: ID, count: 1, display: 'Abel Tuter' }])
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
  const partial = await connect([
    { table: 'sys_dictionary', query: 'nameINincident,task', rows: [column('task', 'number'), column('incident', 'category', 'string', '', { choice: '1' })] },
    { table: 'sys_choice', query: 'element=category', rows: [{ name: 'incident', value: 'inquiry', label: 'Inquiry / Help' }, null] },
    ...dictionaryRoutes,
    { table: 'incident', rows: [] },
  ])
  const hidden = await partial.answer('sn_query', { table: 'incident', query: 'category=Hardware' })
  assert.match(hidden.warnings.join(' '), /"category" is a choice field, and its values could not be checked/)

  // Measured: "is not" leaves out rows where the field is empty. A boolean is never empty, and "!=" without a value means "is not empty".
  const { answer } = await connect([...dictionaryRoutes, { table: 'incident', rows: [{ number: 'INC1' }] }])
  const data = await answer('sn_query', { table: 'incident', query: `assigned_to!=${ID}^active!=true^category!=^short_descriptionNOT LIKEtest` })
  assert.match(data.warnings.join(' '), /leave out rows where the field is empty \(assigned_to, short_description\)\. To count those rows too, add \^ORassigned_toISEMPTY/)
  assert.deepEqual((await answer('sn_query', { table: 'incident', query: 'active!=true^category!=' })).warnings, [])
  // A query that asks for the empty rows itself has them, and "!=NULL" asks for the rows that are not empty.
  for (const query of [`assigned_to!=${ID}^ORassigned_toISEMPTY`, `assigned_to!=${ID}^ORassigned_to=NULL`, `assigned_to.name!=Abel^ORassigned_toISEMPTY`, 'assigned_to!=NULL', 'short_description!=NULL']) {
    assert.deepEqual((await answer('sn_query', { table: 'incident', query })).warnings, [], query)
  }
  // Measured: "is different from another field" leaves the empty rows out as well, those of either field.
  assert.match((await answer('sn_query', { table: 'incident', query: 'assigned_toNSAMEAScaller_id' })).warnings.join(' '), /"NSAMEAS" leaves out rows where the field is empty \(assigned_to, caller_id\)/)
})

test('a name where a reference needs a sys_id is refused when it is to be left out', async () => {
  // Measured on 82 incidents, 40 with a group, 12 of them in one group: "assignment_group!=<its name>" matched all 40.
  const groups = (rows: Array<Record<string, string>>, total = rows.length): Route => ({ table: 'sys_user', query: 'sys_id=', rows, total })
  const { answer, call, sentTo } = await connect([groups([]), ...dictionaryRoutes, { table: 'incident', rows: [{ number: 'INC1' }] }])
  for (const query of ['assigned_to!=Abel Tuter', `assigned_toNOT IN${ID},Abel Tuter`, 'caller_id!=abel']) {
    const { data } = await call('sn_query', { table: 'incident', query, fields: ['number'] })
    assert.equal(data.error, 'validation', query)
    assert.match(data.message, /is a reference to sys_user and stores a sys_id, and no record there has the sys_id "(Abel Tuter|abel)".*leaves no row out.*\.name(!=|NOT IN)/, query)
  }
  assert.equal(sentTo('incident').length, 0)
  // Looked up by exactly that value, in the table the reference points to.
  assert.equal(sentTo('sys_user')[0].query, 'sys_id=Abel Tuter')
  // A sys_id is at most 32 characters: nothing has to be asked.
  const long = await call('sn_query', { table: 'incident', query: `assigned_to!=${'x'.repeat(40)}`, fields: ['number'] })
  assert.equal(long.data.error, 'validation')

  // A sys_id is not always 32 hex digits: "global" is the sys_id of a scope. Where a record has it, the query is sent.
  const real = await connect([groups([{ sys_id: 'global' }]), ...dictionaryRoutes, { table: 'incident', rows: [{ number: 'INC1' }] }])
  assert.deepEqual((await real.answer('sn_query', { table: 'incident', query: 'assigned_to!=global^ORassigned_toISEMPTY', fields: ['number'] })).warnings, [])
  // A 32-digit sys_id and "is" are not looked up: "is" with a name matches nothing, and the empty answer says why.
  const plain = await connect([...dictionaryRoutes, { table: 'incident', rows: [] }])
  await plain.answer('sn_query', { table: 'incident', query: `assigned_to!=${ID}^ORassigned_toISEMPTY`, fields: ['number'] })
  assert.match((await plain.answer('sn_query', { table: 'incident', query: 'assigned_to=Abel Tuter', fields: ['number'] })).warnings.join(' '), /does not look like one/)
  assert.equal(plain.sentTo('sys_user').length, 0)

  // Where the table behind the reference cannot be asked, the answer says what could not be checked.
  const hidden = await connect([{ table: 'sys_user', status: 403 }, ...dictionaryRoutes, { table: 'incident', rows: [{ number: 'INC1' }] }])
  const unsure = await hidden.answer('sn_query', { table: 'incident', query: 'assigned_to!=Abel Tuter', fields: ['number'] })
  assert.match(unsure.warnings.join(' '), /"Abel Tuter" does not look like one, and it could not be checked whether a record has it/)

  // Every value of a list is looked at, however many there are: one request for all, and the one that is no record is named.
  const many = await connect([
    { table: 'sys_user', exact: 'sys_idINglobal,admin,guest,Bad Name', rows: [{ sys_id: 'global' }, { sys_id: 'admin' }, { sys_id: 'guest' }] },
    { table: 'sys_user', exact: 'sys_id=Bad Name', rows: [] },
    ...dictionaryRoutes,
    { table: 'incident', rows: [{ number: 'INC1' }] },
  ])
  const fourth = await many.call('sn_query', { table: 'incident', query: 'assigned_toNOT INglobal, admin,guest,Bad Name', fields: ['number'] })
  assert.equal(fourth.data.error, 'validation')
  assert.match(fourth.data.message, /no record there has the sys_id "Bad Name"/)
  assert.equal(many.sentTo('incident').length, 0)
  assert.equal(many.sentTo('sys_user').length, 2)

  // Rows of the referenced table are closed on this machine, and left out of every answer about it. A look-up would
  // say "no such record" of one that is there, so none is made, and the answer says so.
  const partly = await connect(familyWorld([closedTables(tableRow('customer_contact', 'Contact', 'sys_user')), { table: 'incident', rows: [{ number: 'INC1' }] }]), { tables: { allow: [], deny: ['customer_contact'] } })
  const kept = await partly.answer('sn_query', { table: 'incident', query: 'caller_id!=vip_contact_1', fields: ['number'] })
  assert.match(kept.warnings.join(' '), /"vip_contact_1" does not look like one, and it was not looked up, because rows of that table are closed on this machine/)
  assert.equal(partly.sentTo('sys_user').length, 0)
})

test('"is empty" covers an "is not" only where the two are joined with ^OR', async () => {
  const { answer } = await connect([...dictionaryRoutes, { table: 'incident', rows: [{ number: 'INC1' }] }])
  const note = /leaves out rows where the field is empty \(assigned_to\)/
  // Joined with ^OR, the empty rows are asked for. In another part of the query they are not: the note stays.
  assert.doesNotMatch((await answer('sn_query', { table: 'incident', query: `assigned_to!=${ID}^ORassigned_toISEMPTY`, fields: ['number'] })).warnings.join(' '), note)
  assert.match((await answer('sn_query', { table: 'incident', query: `assigned_to!=${ID}^NQassigned_toISEMPTY`, fields: ['number'] })).warnings.join(' '), note)
  assert.match((await answer('sn_query', { table: 'incident', query: `assigned_to!=${ID}^active=true^ORassigned_toISEMPTY`, fields: ['number'] })).warnings.join(' '), note)
})

test('groups of the same size keep their order from page to page, and a secret in a value is taken out', async () => {
  const groups = stats('incident', { zebra: 2, apple: 2, mango: 5, '{"api_key":"sk-live-123"}': 2 }, undefined, 'short_description')
  const { answer } = await connect([groups, ...dictionaryRoutes])
  const first = await answer('sn_query', { table: 'incident', groupBy: 'short_description', limit: 2 })
  const second = await answer('sn_query', { table: 'incident', groupBy: 'short_description', limit: 2, offset: 2 })
  assert.deepEqual([...first.groups, ...second.groups].map((group: Data) => group.value), ['mango', 'apple', 'zebra', '{"api_key":"[withheld]"}'])
  assert.match(second.warnings.join(' '), /1 value\(s\) inside a text were withheld/)
  assert.equal(first.nextOffset, 2)
})

test('while tables are closed, a table whose fields cannot be read is not queried', async () => {
  // Without the dictionary nothing says which of its fields point into a closed table. With no table closed, the
  // field names are checked against a row instead, and the query is sent.
  const unreadable = dictionaryRoutes.map((route) => (route.table === 'sys_dictionary' && route.query === 'nameINincident,task' ? { table: 'sys_dictionary', query: route.query, status: 403 } : route))
  const world = [...unreadable, { table: 'incident', rows: [{ number: 'INC1' }] }]
  const closed = await connect(world, { tables: { allow: [], deny: ['sys_user'] } })
  const { data } = await closed.call('sn_query', { table: 'incident', fields: ['number'] })
  assert.equal(data.error, 'blocked')
  assert.match(data.message, /could not be established which tables this query reads from/)
  assert.equal(closed.sentTo('incident').length, 0)

  const open = await connect(world)
  assert.equal((await open.answer('sn_query', { table: 'incident', fields: ['number'] })).returned, 1)
})

test('the roles of the account are looked up only with a user name that can stand in a query', async () => {
  const roles: Route = { table: 'sys_user_has_role', rows: [{ 'role.name': 'admin', 'user.user_name': 'reader' }] }
  const fine = fakeInstance([roles])
  assert.deepEqual(await accountRoles(fine.sn), { roles: 1, admin: true, readOnlyRole: false })
  // A caret in the name would begin a second condition.
  const odd = fakeInstance([roles], { auth: { kind: 'basic', username: 'reader^ORactive=true', password: 'secret' } })
  assert.equal(await accountRoles(odd.sn), null)
  assert.equal(odd.calls.length, 0)
})

test('a login the instance rejects is reported as that, also while tables are closed', async () => {
  // Not being able to log in is not a closed table: no function turns it into "blocked".
  // With a deny list the first thing asked is which tables it closes, with a list of the only open tables what the
  // table itself is: both ways the rejected login has to come through as it is.
  for (const tables of [{ allow: [], deny: ['sys_user'] }, { allow: ['incident', 'task', 'sys_*', 'upgrade_history_task'], deny: [] }]) {
    const { call } = await connect([{ table: 'sys_db_object', status: 401 }], { tables })
    for (const [tool, args] of [['sn_query', { table: 'incident', fields: ['number'] }], ['sn_schema', { table: 'incident' }], ['sn_instance', {}], ['sn_origin', { updateName: NAME }]] as const) {
      const { data, isError } = await call(tool, args)
      assert.equal(isError, true, tool)
      assert.equal(data.error, 'auth', `${tool} with ${JSON.stringify(tables)}: ${data.message}`)
    }
  }
})

test('a day that does not exist is not sent as a date', async () => {
  const { call, calls } = await connect([])
  const { data } = await call('sn_delta', { since: '2026-02-31' })
  assert.equal(data.error, 'validation')
  assert.match(data.message, /"since" is not a day that exists/)
  assert.equal(calls.length, 0)
})

test('a word on a choice that stores numbers is refused with the list of its values', async () => {
  const priorities = { table: 'sys_choice', query: 'element=priority', rows: [
    { name: 'task', value: '1', label: '1 - Critical', language: 'en' },
    { name: 'task', value: '2', label: '2 - High', language: 'en' },
    { name: 'task', value: '2', label: '2 - Hoch', language: 'de' },
    { name: 'task', value: '3', label: '3 - Moderate', language: 'en' },
  ] }
  const typed = { table: 'sys_dictionary', query: 'nameINincident,task', rows: [column('task', 'number'), column('task', 'priority', 'integer', '', { choice: '1' })] }
  const { call, answer } = await connect([typed, priorities, ...dictionaryRoutes, { table: 'incident', rows: [{ number: 'INC1' }] }])
  const { data } = await call('sn_query', { table: 'incident', query: 'priority=High', fields: ['number'] })
  assert.equal(data.error, 'validation')
  assert.match(data.message, /"priority" stores the value of a choice, a number, and "High" is neither one of its values nor one of its labels\. The label that contains it belongs to the value 2\. Its values: 1 \(1 - Critical\), 2 \(2 - High\), 3 \(3 - Moderate\)\./)
  // A word that fits several labels, or none: the list alone.
  assert.doesNotMatch((await call('sn_query', { table: 'incident', query: 'priority=Urgent', fields: ['number'] })).data.message, /belongs to/)
  assert.equal((await answer('sn_query', { table: 'incident', query: 'priorityIN1, 2', fields: ['number'] })).returned, 1)
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
  // Asked for by name, a field without a type in view is said to be one: its name was all there was to go by.
  assert.match(named.warnings.join(' '), /The types of some fields could not be read/)
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
  // Both come back, and both are empty: an empty name is no name.
  const blank = await connect([...dictionary, { table: 'sys_properties', rows: [{ name: '', type: '', value: 'ciphertext' }] }])
  assert.deepEqual((await blank.answer('sn_query', { table: 'sys_properties', fields: ['name', 'value'] })).records, [{ name: '', value: '[withheld: this field holds a secret]' }])

  // A withheld value is not looked into: a note about what it contains would say something about it.
  const nested = await connect([...dictionary, { table: 'sys_properties', rows: [{ name: 'glide.smtp.pw', type: 'password2', value: '<x><token>abc1234567890</token></x>' }] }])
  const quiet = await nested.answer('sn_query', { table: 'sys_properties', fields: ['name', 'value', 'type'] })
  assert.doesNotMatch(quiet.warnings.join(' '), /inside a text/)
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
  // First the properties without a type are counted, so that the answer can say how many the search does not cover.
  assert.deepEqual(sentTo('sys_properties').map((entry) => entry.query), ['typeISEMPTY', sent])
  assert.equal(found.query, sent)
  assert.match(found.warnings.join(' '), /Properties that hold a secret \(type password or password2\) and properties without a type were left out.*The 1 property without a type can be read with the query typeISEMPTY/)

  // Nothing compares the value: the query goes out as written. Asking whether it is filled compares nothing, however it is written.
  await answer('sn_query', { table: 'sys_properties', query: 'name=glide.war', fields: ['name', 'value'] })
  await answer('sn_query', { table: 'sys_properties', query: 'valueISEMPTY', fields: ['name'] })
  await answer('sn_query', { table: 'sys_properties', query: 'value!=NULL', fields: ['name'] })
  assert.deepEqual(sentTo('sys_properties').slice(2).map((entry) => entry.query), ['name=glide.war', 'valueISEMPTY', 'value!=NULL'])

  // Listed as groups, every value would be in the answer.
  const grouped = await call('sn_query', { table: 'sys_properties', groupBy: 'value' })
  assert.equal(grouped.data.error, 'validation')
  assert.match(grouped.data.message, /not listed as groups/)
  // Counted by another field, a condition on the value is treated like any other.
  await answer('sn_query', { table: 'sys_properties', query: 'valueLIKEa', groupBy: 'type' })
  assert.equal(sentTo('sys_properties', 'stats')[0].query, `valueLIKEa^${LEFT_OUT}`)
})

test('the name pattern for secrets, against the names of the secret fields of one instance', () => {
  // Measured: 1,090 fields of a password or encrypted type. These are their names, as far as the pattern knows them.
  const secret = [
    'user_password', 'password', 'client_secret', 'token', 'access_token', 'api_key', 'apikey', 'private_key', 'passphrase', 'credential', 'client_state', 'clientState', 'encoded_value', 'otp',
    'property_key', 'sensitive_value', 'passcode', 'secure_notes', 'access_key', 'authentication_key', 'bluemix_key', 'code_verifier', 'encrypted_file', 'encryption_key',
    'job_data_encryption_key', 'key_id', 'mac_key', 'nonce', 'privacy_key', 'registration_key', 'sas_key', 'secure_data', 'secure_value', 'seed', 'sensitive_content', 'shared_key',
    'signing_key', 'softlayer_key', 'softpin', 'state_key', 'user_pwd', 'caller_id.user_password',
  ]
  for (const name of secret) assert.ok(LOOKS_SECRET.test(name), name)
  // A handful it does not know (the type says so where the dictionary is readable), and everyday names it must leave alone.
  const plain = ['key', 'answer', 'customer_uri', 'name', 'number', 'short_description', 'state', 'category', 'priority', 'sys_id', 'monkey', 'keyword', 'spinner', 'pinned', 'announcement', 'bypass', 'passed', 'opened_by']
  for (const name of plain) assert.ok(!LOOKS_SECRET.test(name), name)
})

test('secrets are taken out of a text that carries a record', () => {
  const xml = '<record_update table="sys_user"><sys_user action="INSERT_OR_UPDATE"><name>Abel Tuter</name><user_password>$s$hash</user_password><token><![CDATA[abc<def]]></token><email/></sys_user></record_update>'
  const cleaned = scrubSecrets(xml)
  assert.equal(cleaned.withheld, 2)
  assert.equal(cleaned.text, '<record_update table="sys_user"><sys_user action="INSERT_OR_UPDATE"><name>Abel Tuter</name><user_password>[withheld]</user_password><token>[withheld]</token><email/></sys_user></record_update>')

  // A system property says by its type whether its value is a secret.
  const property = (type: string) => `<record_update table="sys_properties"><sys_properties action="INSERT_OR_UPDATE"><name>glide.smtp.pw</name><type>${type}</type><value>ciphertext</value></sys_properties></record_update>`
  assert.match(scrubSecrets(property('password2')).text, /<value>\[withheld\]<\/value>/)
  assert.equal(scrubSecrets(property('string')).withheld, 0)

  assert.equal(scrubSecrets('{"user":"abel","api_key":"abc\\"def","nested":{"password": "x"}}').text, '{"user":"abel","api_key":"[withheld]","nested":{"password": "[withheld]"}}')
  // A switch that has "password" in its name is no secret.
  assert.equal(scrubSecrets('<pwd_reset action="INSERT_OR_UPDATE"><display_password>true</display_password></pwd_reset>').withheld, 0)
  assert.deepEqual(scrubSecrets('A short text.'), { text: 'A short text.', withheld: 0 })
  assert.deepEqual(scrubSecrets('<p>The password must be changed every 90 days.</p>'), { text: '<p>The password must be changed every 90 days.</p>', withheld: 0 })

  // An attribute on the type, an empty type with a telling name, an attribute on the value: all the same property.
  const record = (inner: string) => `<record_update><sys_properties action="INSERT_OR_UPDATE">${inner}</sys_properties><sys_choice action="INSERT_OR_UPDATE"><value>6</value></sys_choice></record_update>`
  for (const inner of [
    '<name>x.smtp</name><type display_value="Password2">password2</type><value>ENC_SECRET</value>',
    '<name>glide.smtp.password</name><type/><value>MY_PASS</value>',
    '<name>a</name><type>password</type><value display_value="********">cipher</value>',
    // Neither a type nor a name: nothing says that the value is harmless.
    '<value>cipher</value>',
  ]) {
    const scrubbed = scrubSecrets(record(inner))
    assert.match(scrubbed.text, /<sys_properties action="INSERT_OR_UPDATE">.*<value>\[withheld\]<\/value><\/sys_properties>/, inner)
    // The value of another record in the same payload is not touched.
    assert.match(scrubbed.text, /<sys_choice action="INSERT_OR_UPDATE"><value>6<\/value>/, inner)
  }
  assert.equal(scrubSecrets(record('<name>glide.ui.width</name><type/><value>120</value>')).withheld, 0)

  // A short text, blanks around a CDATA section, and an attribute that repeats the content.
  assert.equal(scrubSecrets('<pwd>s3cr3t</pwd>').text, '<pwd>[withheld]</pwd>')
  assert.equal(scrubSecrets('<r><api_key> <![CDATA[sk-999]]> </api_key></r>').text, '<r><api_key>[withheld]</api_key></r>')
  assert.equal(scrubSecrets('<u_api_key display_value="raw">raw</u_api_key>').text, '<u_api_key>[withheld]</u_api_key>')
  // JSON keys in other spellings, a number as the value, and JSON inside a JSON string.
  assert.equal(
    scrubSecrets('{"x-api-key":"sk-live","accessKey":"AKIA","otp":482913,"body":"{\\"token\\":\\"eyJ\\"}","name":"plain"}').text,
    '{"x-api-key":"[withheld]","accessKey":"[withheld]","otp":"[withheld]","body":"{\\"token\\":\\"[withheld]\\"}","name":"plain"}',
  )
  assert.equal(scrubSecrets('{"display_password":"false"}').withheld, 0)
  // Code that only names a secret is left as it is.
  assert.equal(scrubSecrets('var x = gs.getProperty("glide.smtp.password");').withheld, 0)
})

test('a secret is found in JSON inside a JSON string, and behind a type written as CDATA', () => {
  // The inner text has escapes of its own: "=" as =, "/" as \/, a quote as \".
  const nested = scrubSecrets(String.raw`{"cfg":"{\"api_key\":\"abc\\u003ddef\",\"name\":\"x\"}"}`)
  assert.equal(nested.text, String.raw`{"cfg":"{\"api_key\":\"[withheld]\",\"name\":\"x\"}"}`)
  assert.equal(scrubSecrets(String.raw`{"cfg":"{\"token\":\"a\\/b\\\"c\"}"}`).text, String.raw`{"cfg":"{\"token\":\"[withheld]\"}"}`)
  const cdata = scrubSecrets('<sys_properties><name>glide.smtp.setting</name><type><![CDATA[password2]]></type><value>topsecret</value></sys_properties>')
  assert.equal(cdata.withheld, 1)
  assert.match(cdata.text, /<value>\[withheld\]<\/value>/)
})

test('text that begins ten thousand things and ends none costs its length, not its length squared', () => {
  // Whoever can write a record can write this text. Read with a pattern that looks for an end from every
  // beginning, 60,000 beginnings took 25 seconds. A pass that never searches a stretch twice takes milliseconds.
  const hostile = [
    '<a><![CDATA['.repeat(60_000),
    `${'<password><![CDATA['.repeat(60_000)}]]>`,
    '<sys_properties><name>x</name>'.repeat(60_000),
    `<sys_properties><type>password</type>${'<value><![CDATA['.repeat(60_000)}</sys_properties>`,
    '<!-- '.repeat(60_000),
    `{"c":"{\\"api_key\\":\\"${'\\\\\\\\'.repeat(100_000)}`,
    // Many beginnings that share one end, with blanks behind it: the blanks were skipped anew from each beginning.
    `${'<password><![CDATA['.repeat(40_000)}]]>${' '.repeat(400_000)}`,
    // Wrappers that never end: each new element was held against every one that was open.
    '<xml>'.repeat(200_000),
    '<a b="1" '.repeat(60_000),
  ]
  const started = performance.now()
  for (const text of hostile) {
    scrubSecrets(text)
    payloadTables(text)
  }
  const took = performance.now() - started
  assert.ok(took < 3_000, `${Math.round(took)} ms`)
})

test('a secret is taken out of markup that sits inside a CDATA section too', () => {
  // A record inside a text inside a record: the inner one is read like the outer one.
  const nested = scrubSecrets('<record_update><sys_remote><payload><![CDATA[<sys_user><user_password>$s$hash</user_password><name>Abel</name></sys_user>]]></payload></sys_remote></record_update>')
  assert.equal(nested.withheld, 1)
  assert.match(nested.text, /<user_password>\[withheld\]<\/user_password><name>Abel<\/name>/)
  // An element that is not ended is left as it is, and so is the text behind it.
  const open = '<password><![CDATA[abc <name>x</name>'
  assert.deepEqual(scrubSecrets(open), { text: open, withheld: 0 })
  // The same property record twice: each is judged by its own type.
  const two = scrubSecrets('<sys_properties><name>a</name><type>password2</type><value>one</value></sys_properties><sys_properties><name>b</name><type>string</type><value>two</value></sys_properties>')
  assert.equal(two.withheld, 1)
  assert.match(two.text, /<value>\[withheld\]<\/value>.*<value>two<\/value>/)
})

test('the value of a system property is withheld behind a reference whose table cannot be read', async () => {
  // The dictionary of the properties is not readable, so nothing says what "u_property.value" is. A path that ends
  // in ".value" can be the value of a property, and some properties hold secrets.
  const world: Route[] = [
    { table: 'sys_db_object', query: 'name=u_setting', rows: [tableRow('u_setting', 'Setting')] },
    { table: 'sys_dictionary', query: 'nameINu_setting', rows: [column('u_setting', 'u_name'), column('u_setting', 'u_property', 'reference', 'sys_properties')] },
    { table: 'sys_db_object', query: 'name=sys_properties', rows: [tableRow('sys_properties', 'System Property')] },
    { table: 'sys_dictionary', query: 'nameINsys_properties', status: 403 },
    ...dictionaryRoutes,
    { table: 'u_setting', rows: [{ u_name: 'mail', 'u_property.value': 'ciphertext' }] },
  ]
  const { answer, call } = await connect(world)
  const data = await answer('sn_query', { table: 'u_setting', fields: ['u_name', 'u_property.value'] })
  assert.deepEqual(data.records, [{ u_name: 'mail', 'u_property.value': '[withheld: this field holds a secret]' }])
  // It cannot be compared either: the type of the property, which would say whether it is a secret, is not at hand.
  const probing = await call('sn_query', { table: 'u_setting', query: 'u_property.valueSTARTSWITHa', fields: ['u_name'] })
  assert.equal(probing.data.error, 'validation')
  assert.match(probing.data.message, /is the value of a system property/)
})

test('the comparison of two payloads is not passed on', async () => {
  const world: Route[] = [
    { table: 'sys_db_object', query: 'name=sys_update_preview_xml', rows: [tableRow('sys_update_preview_xml', 'Preview')] },
    { table: 'sys_dictionary', query: 'nameINsys_update_preview_xml', rows: [column('sys_update_preview_xml', 'name'), column('sys_update_preview_xml', 'payload_diff')] },
    ...dictionaryRoutes,
    { table: 'sys_update_preview_xml', rows: [{ name: NAME, payload_diff: '<diff><old><user_password>one</user_password></old><new><user_password>two</user_password></new></diff>' }] },
  ]
  const { answer } = await connect(world)
  const data = await answer('sn_query', { table: 'sys_update_preview_xml', fields: ['name', 'payload_diff'] })
  // It is markup around the content of both: cleaning it like a payload would not be enough to rely on.
  assert.equal(data.records[0].payload_diff, '[withheld: the comparison of two payloads is not passed on]')
  assert.match(data.warnings.join(' '), /The comparison of two payloads \(payload_diff\) is not passed on/)
})

test('only an element that holds text and is closed is taken for a field', () => {
  // A field of a record is a leaf. What holds more than text, or is never closed, is left as it stands, and so is
  // everything around it.
  for (const text of ['<password>abc<br/>def</password>', '<password>abc<b>d</b>', 'ab</password><password><![CDATA[zzz', '<token>']) {
    assert.deepEqual(scrubSecrets(text), { text, withheld: 0 }, text)
  }
})

test('the tables of the records a payload carries are all found', () => {
  assert.deepEqual(payloadTables('<record_update table="sys_user" data-action="x"><sys_user action="INSERT_OR_UPDATE"><name>A</name></sys_user></record_update>'), ['sys_user'])
  assert.deepEqual(payloadTables("<record_update><sys_metadata_link action=\"INSERT_OR_UPDATE\"/><sys_user action='DELETE'>x</sys_user></record_update>"), ['sys_metadata_link', 'sys_user'])
  // The attribute "table" of a dictionary entry names the table the field belongs to, not the table of the record.
  assert.deepEqual(payloadTables('<record_update><sys_dictionary action="INSERT_OR_UPDATE" element="x" table="incident"><active>true</active></sys_dictionary></record_update>'), ['sys_dictionary'])
  assert.deepEqual(payloadTables('no record in here'), [])
  // Measured: a deleted record is kept as XML under the name of its table, without a wrapper and without an action.
  assert.deepEqual(payloadTables('<?xml version="1.0" encoding="UTF-8"?><sys_user><name>Abel Tuter</name><sys_id>1</sys_id></sys_user>'), ['sys_user'])
  // What stands directly inside a wrapper is a record, whether it says what was done to it or not.
  assert.deepEqual(payloadTables('<record_update table="sys_metadata_link"><sys_user><name>x</name></sys_user></record_update>').sort(), ['sys_metadata_link', 'sys_user'])
  assert.deepEqual(payloadTables('<?xml version="1.0"?><unload unload_date="2026-11-20 00:00:00"><incident><number>INC1</number></incident><sys_user/></unload>').sort(), ['incident', 'sys_user'])
  // Deeper down it is a field, also where it is called like a table. Text in CDATA is no element, and a ">" in an attribute ends none.
  assert.deepEqual(payloadTables('<record_update><incident action="INSERT_OR_UPDATE"><x a="1>2"/><task>abc</task><note><![CDATA[</incident><sys_user>]]></note></incident></record_update>'), ['incident'])
})

test('a payload does not hide the table of a record behind the way it is written', () => {
  const tables = (text: string) => payloadTables(text).sort()
  // A ">" in an attribute in front of the one that names the table, or in front of the action.
  assert.deepEqual(tables('<record_update description="a > b" table="sys_user"><incident><sys_user display_value="a > b" action="INSERT_OR_UPDATE"><name>x</name></sys_user></incident></record_update>'), ['incident', 'sys_user'])
  // An element that is never ended does not move the record behind it one level down.
  assert.deepEqual(
    tables('<record_update table="sys_ui_page"><sys_ui_page action="INSERT_OR_UPDATE"><html><br>Hello</html></sys_ui_page><sys_user><user_name>abel</user_name></sys_user></record_update>'),
    ['sys_ui_page', 'sys_user'],
  )
  // Every wrapper that names a table counts, not the first one only.
  assert.deepEqual(tables('<unload><record_update table="incident"><incident/></record_update><record_update table="sys_user"><x/></record_update></unload>'), ['incident', 'sys_user', 'x'])
  // Measured: the instance compares names without regard to case. A table in capitals, or with a prefix, is the same table.
  assert.deepEqual(tables('<record_update table="SYS_USER"><SYS_USER ACTION="INSERT_OR_UPDATE"><name>x</name></SYS_USER></record_update>'), ['sys_user'])
  assert.deepEqual(tables('<record_update><x:sys_user action="DELETE"/></record_update>'), ['sys_user'])
  // Inside a CDATA section the action on an element is the only sign, in whatever case it is written.
  assert.deepEqual(tables('<record_update table="incident"><incident action="INSERT_OR_UPDATE"><note><![CDATA[<SYS_USER ACTION="DELETE"><name>x</name></SYS_USER>]]></note></incident></record_update>'), ['incident', 'sys_user'])

  // Measured: a linked application file carries the record it links to as a whole payload in a CDATA section.
  const inner = '<?xml version="1.0" encoding="UTF-8"?><record_update table="sys_user"><sys_user action="INSERT_OR_UPDATE"><name>Abel Tuter</name></sys_user></record_update>'
  const link = (payload: string) => `<record_update table="sys_metadata_link"><sys_metadata_link action="INSERT_OR_UPDATE"><tablename>sys_user</tablename><payload>${payload}</payload></sys_metadata_link></record_update>`
  assert.deepEqual(tables(link(`<![CDATA[${inner}]]>`)), ['sys_metadata_link', 'sys_user'])
  // The same written with entities, once or twice over.
  const escaped = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
  assert.deepEqual(tables(link(escaped(inner))), ['sys_metadata_link', 'sys_user'])
  assert.deepEqual(tables(link(escaped(escaped(inner)))), ['sys_metadata_link', 'sys_user'])

  // The text of a field is not the markup of the payload: a web page in a CDATA section names no tables.
  assert.deepEqual(
    tables('<record_update table="sys_ui_page"><sys_ui_page action="INSERT_OR_UPDATE"><html><![CDATA[<div><table><tr><td>x</td></tr></table><br></div>]]></html><description>a &lt;b&gt;bold&lt;/b&gt; word</description></sys_ui_page></record_update>'),
    ['sys_ui_page'],
  )
  // More tables than can be looked at one by one: such a payload cannot be judged, which an empty list says.
  const many = `<unload>${Array.from({ length: 60 }, (_, index) => `<u_table_${index}/>`).join('')}</unload>`
  assert.deepEqual(payloadTables(many), [])
})

test('a secret is taken out of a text however its element is written', () => {
  const withheld = (text: string) => {
    const cleaned = scrubSecrets(text)
    assert.doesNotMatch(cleaned.text, /TOPSECRET|abc.{0,12}def/, text)
    assert.ok(cleaned.withheld >= 1, text)
    return cleaned.text
  }
  // A ">" inside an attribute value does not end the tag.
  assert.equal(withheld('<user_password display_value="a > b"><![CDATA[TOPSECRET]]></user_password>'), '<user_password>[withheld]</user_password>')
  // A value that holds "]]>" is written as two CDATA sections.
  assert.equal(withheld('<user_password><![CDATA[abc]]]]><![CDATA[>def]]></user_password>'), '<user_password>[withheld]</user_password>')
  // JSON inside a JSON string, where the outer text escaped a character of its own: "/" as "\/", "=" as "=".
  assert.equal(withheld(String.raw`{"body": "{\"api_key\": \"abc\/def\"}"}`), String.raw`{"body": "{\"api_key\": \"[withheld]\"}"}`)
  assert.equal(withheld(String.raw`{"body": "{\"api_key\": \"abc=def\", \"name\": \"x\"}"}`), String.raw`{"body": "{\"api_key\": \"[withheld]\", \"name\": \"x\"}"}`)

  // A system property that holds a secret, with a text in front of its type that only looks like a type.
  withheld('<sys_properties><description><![CDATA[uses <type>string</type>]]></description><name>x</name><type>password2</type><value>TOPSECRET</value></sys_properties>')
  // An element that ends in itself holds no record: the property behind it is judged by its own type.
  withheld('<record_update><sys_properties action="DELETE"/><incident><type>string</type></incident><sys_properties action="INSERT_OR_UPDATE"><name>x</name><type>password2</type><value>TOPSECRET</value></sys_properties></record_update>')
  // A property of another type keeps its value.
  assert.equal(scrubSecrets('<sys_properties action="INSERT_OR_UPDATE"><name>glide.ui.width</name><type>integer</type><value>120</value></sys_properties>').withheld, 0)
  // Also where an element in front of it ends in itself: that one holds no record, and what stands between the
  // two is not part of the property behind it.
  assert.equal(scrubSecrets('<record_update><sys_properties action="DELETE"/><x><type>password</type></x><sys_properties action="INSERT_OR_UPDATE"><name>glide.ui.width</name><type>integer</type><value>120</value></sys_properties></record_update>').withheld, 0)
})

test('the payload of a captured change is passed on without its secrets, and cannot be searched', async () => {
  const payload = (table: string, inner: string) => `<?xml version="1.0"?><record_update table="${table}"><${table} action="INSERT_OR_UPDATE">${inner}</${table}></record_update>`
  const rows = [
    { name: 'sys_auth_profile_basic_1', payload: payload('sys_auth_profile_basic', '<name>Example</name><password>ciphertext</password>') },
    { name: 'sys_user_2', payload: payload('sys_user', '<name>Abel Tuter</name>') },
    {
      name: 'sys_script_3',
      payload: payload(
        'sys_script',
        '<name>Example rule</name><sys_created_by display_value="Beth Anglin">beth</sys_created_by><script><![CDATA[gs.info("x")]]></script><note>&lt;owner display_value=&quot;Carol Coughlin&quot;&gt;c&lt;/owner&gt;</note>',
      ),
    },
  ]
  const routes: Route[] = [
    { table: 'sys_db_object', query: 'name=sys_update_xml', rows: [tableRow('sys_update_xml', 'Customer Update')] },
    // The tables of the records the payloads carry: while tables are closed, a payload of a table the instance does
    // not know is not passed on.
    { table: 'sys_db_object', exact: 'name=sys_auth_profile_basic', rows: [tableRow('sys_auth_profile_basic', 'Basic Auth Configuration')] },
    { table: 'sys_db_object', exact: 'name=sys_script', rows: [tableRow('sys_script', 'Business Rule')] },
    { table: 'sys_dictionary', query: 'nameINsys_update_xml', rows: [column('sys_update_xml', 'name'), column('sys_update_xml', 'payload'), column('sys_update_xml', 'type')] },
    ...dictionaryRoutes,
    { table: 'sys_update_xml', rows },
    stats('sys_update_xml', { x: 1 }),
  ]
  const { answer, call, sentTo } = await connect(routes, { tables: { allow: [], deny: ['sys_user'] } })

  const data = await answer('sn_query', { table: 'sys_update_xml', fields: ['name', 'payload'] })
  assert.match(data.records[0].payload, /<name>Example<\/name><password>\[withheld\]<\/password>/)
  // The record of a table that is closed on this machine is not passed on inside a payload either.
  assert.equal(data.records[1].payload, '[withheld: the record is in a table closed on this machine]')
  assert.match(data.records[2].payload, /gs\.info/)
  assert.match(data.warnings.join(' '), /1 value\(s\) inside a text were withheld/)
  assert.match(data.warnings.join(' '), /1 payload\(s\) were withheld, because the record they carry is in a table that is closed/)

  // A payload that is passed on names the record behind each of its references. Those names are taken out, also
  // where the markup of a record inside it is written with entities.
  assert.doesNotMatch(JSON.stringify(data.records[2]), /Beth Anglin|Carol Coughlin/)
  assert.match(data.records[2].payload, /display_value="\[withheld\]"/)
  assert.match(data.records[2].payload, /display_value=&quot;\[withheld\]&quot;/)

  // "Contains <password>a", "contains <password>b": searching the payload would read the secret piece by piece.
  for (const args of [{ query: 'payloadLIKE<password>a' }, { query: 'ORDERBYpayload' }, { groupBy: 'payload' }]) {
    const { data: refused } = await call('sn_query', { table: 'sys_update_xml', ...args })
    assert.equal(refused.error, 'validation', JSON.stringify(args))
    assert.match(refused.message, /holds whole records as text/)
  }
  assert.equal(sentTo('sys_update_xml').length, 1)
  assert.equal((await answer('sn_query', { table: 'sys_update_xml', query: 'payloadISNOTEMPTY^nameSTARTSWITHsys_script', fields: ['name'] })).returned, 3)
})

test('a linked application file does not give away the record it links to', async () => {
  // Measured: such a file is named after the record it links to, and carries that record as its payload. Its name
  // is a field it inherits, so the dictionary says that the table of application files defines it.
  const WITHHELD = '[withheld: the record is in a table closed on this machine]'
  const inner = (table: string, name: string) => `<?xml version="1.0"?><record_update table="${table}"><${table} action="INSERT_OR_UPDATE"><name>${name}</name></${table}></record_update>`
  const links = [
    { sys_name: 'Abel Tuter', tablename: 'sys_user', sys_class_name: 'sys_metadata_link', payload: inner('sys_user', 'Abel Tuter') },
    { sys_name: 'A question', tablename: 'incident', sys_class_name: 'sys_metadata_link', payload: inner('incident', 'A question') },
  ]
  const fields = [column('sys_metadata', 'sys_name'), column('sys_metadata', 'sys_class_name', 'sys_class_name'), column('sys_metadata_link', 'tablename'), column('sys_metadata_link', 'payload')]
  const world: Route[] = [
    closedTables(tableRow('sys_user', 'User')),
    { table: 'sys_db_object', exact: 'name=sys_metadata_link', rows: [tableRow('sys_metadata_link', 'Application File Link', 'sys_metadata')] },
    { table: 'sys_db_object', exact: 'name=sys_metadata', rows: [tableRow('sys_metadata', 'Application File')] },
    { table: 'sys_dictionary', query: 'nameINsys_metadata_link,sys_metadata', rows: fields },
    { table: 'sys_dictionary', query: 'nameINsys_metadata^', rows: fields.slice(0, 2) },
    ...dictionaryRoutes,
    { table: 'sys_metadata_link', rows: links },
    { table: 'sys_metadata', rows: [{ sys_name: 'Example rule', sys_class_name: 'sys_script' }] },
    stats('sys_metadata_link', { 'Abel Tuter': 1 }),
  ]
  const closed = await connect(world, { tables: { allow: [], deny: ['sys_user'] } })

  // Read from its own table, the row says which table the record is of.
  const read = await closed.answer('sn_query', { table: 'sys_metadata_link', fields: ['sys_name', 'payload'] })
  assert.deepEqual(read.records.map((row: Data) => row.sys_name), [WITHHELD, 'A question'])
  assert.equal(read.records[0].payload, WITHHELD)
  assert.match(read.records[1].payload, /A question/)
  // The same without a list of fields.
  const whole = await closed.answer('sn_query', { table: 'sys_metadata_link' })
  assert.doesNotMatch(JSON.stringify(whole.records), /Abel Tuter/)
  // Not found out by trying either.
  for (const args of [{ query: 'sys_nameSTARTSWITHAbel' }, { query: 'ORDERBYsys_name' }, { groupBy: 'sys_name' }]) {
    const { data } = await closed.call('sn_query', { table: 'sys_metadata_link', ...args })
    assert.equal(data.error, 'blocked', JSON.stringify(args))
    assert.match(data.message, /holds the readable names of records of other tables/)
  }

  // Read as rows of the parent table, nothing says which table the record is of. The parent answers without them.
  const parent = await closed.answer('sn_query', { table: 'sys_metadata', query: 'sys_nameSTARTSWITHA', fields: ['sys_name'] })
  assert.equal(closed.sentTo('sys_metadata')[0].query, 'sys_nameSTARTSWITHA^sys_class_nameNOT INsys_metadata_link^ORsys_class_nameISEMPTY')
  assert.match(parent.warnings.join(' '), /were left out by a condition on sys_class_name/)

  // A reference into the table of application files can point to such a file, whose name is that of the record it
  // links to: the name behind the reference is left out like one behind a reference into a closed table.
  const pointing: Route[] = [
    { table: 'sys_db_object', exact: 'name=u_review', rows: [tableRow('u_review', 'Review')] },
    { table: 'sys_dictionary', query: 'nameINu_review', rows: [column('u_review', 'u_note'), column('u_review', 'u_file', 'reference', 'sys_metadata')] },
    { table: 'u_review', rows: [{ u_note: 'x', u_file: labelled(ID, 'Abel Tuter') }] },
  ]
  const reviewing = await connect([...pointing, ...world], { tables: { allow: [], deny: ['sys_user'] } })
  const shown = await reviewing.answer('sn_query', { table: 'u_review', fields: ['u_note', 'u_file'], displayValue: true })
  assert.deepEqual(shown.records, [{ u_note: 'x', u_file: ID }])
  assert.match(shown.warnings.join(' '), /were left out: u_file/)

  // Nothing is closed: the names stay, and the parent is read as it is.
  const open = await connect(world)
  assert.deepEqual((await open.answer('sn_query', { table: 'sys_metadata_link', fields: ['sys_name'] })).records.map((row: Data) => row.sys_name), ['Abel Tuter', 'A question'])
  await open.answer('sn_query', { table: 'sys_metadata', fields: ['sys_name'] })
  assert.equal(open.sentTo('sys_metadata')[0].query, '')
})

test('a field of a view is judged by the table it comes from, also where the dictionary of that table is not readable', async () => {
  const WITHHELD = '[withheld: the record is in a table closed on this machine]'
  const payload = '<record_update table="sys_user"><sys_user action="INSERT_OR_UPDATE"><name>Abel Tuter</name></sys_user></record_update>'
  const view: Route[] = [
    { table: 'sys_db_object', exact: 'name=v_updates', rows: [] },
    { table: 'sys_db_view', query: 'name=v_updates', rows: [{ sys_id: 'c'.repeat(32), name: 'v_updates', label: 'Updates' }] },
    { table: 'sys_db_view_table', rows: [{ table: 'sys_update_xml', variable_prefix: 'ux' }] },
    { table: 'sys_db_object', exact: 'name=sys_update_xml', rows: [tableRow('sys_update_xml', 'Customer Update')] },
    // The fields of the joined table are hidden from this account.
    { table: 'sys_dictionary', query: 'nameINsys_update_xml', status: 403 },
    { table: 'v_updates', rows: [{ ux_name: `sys_user_${ID}`, ux_target_name: 'Abel Tuter', ux_payload: payload, ux_type: 'User' }] },
  ]
  // Without a list of fields nothing has to be looked up before the view is read, and the row comes with everything.
  const open = await connect([...view, ...dictionaryRoutes])
  const row = (await open.answer('sn_query', { table: 'v_updates' })).records[0]
  // No table is closed: the payload is passed on. It is still a payload, which is not counted by, searched or sorted by.
  assert.match(row.ux_payload, /Abel Tuter/)
  for (const args of [{ groupBy: 'ux_payload' }, { query: 'ux_payloadLIKEAbel' }, { query: 'ORDERBYux_payload' }]) {
    const { data } = await open.call('sn_query', { table: 'v_updates', ...args })
    assert.equal(data.error, 'validation', JSON.stringify(args))
    assert.match(data.message, /holds whole records as text/, JSON.stringify(args))
  }
  assert.equal(open.sentTo('v_updates', 'stats').length, 0)

  // With the user table closed, the record of a user is not passed on, and neither is its name.
  const closed = await connect([closedTables(tableRow('sys_user', 'User')), ...view, ...dictionaryRoutes], { tables: { allow: [], deny: ['sys_user'] } })
  const kept = (await closed.answer('sn_query', { table: 'v_updates' })).records[0]
  assert.equal(kept.ux_payload, WITHHELD)
  assert.equal(kept.ux_target_name, WITHHELD)
  assert.equal(kept.ux_type, 'User')
})

test('on something that could not be read as a table or a view, a field is judged by its name', async () => {
  // The definition of the view is hidden from this account, and the view itself answers. Then it cannot be ruled
  // out that it hands out the values of system properties, or whole records.
  const hidden: Route[] = [
    { table: 'sys_db_object', exact: 'name=v_props', rows: [] },
    { table: 'sys_db_view', query: 'name=v_props', status: 403 },
    { table: 'v_props', rows: [{ prop_name: 'glide.smtp.pw', prop_value: 'ciphertext', prop_type: 'password2', u_payload: '<x><password>s3cr3t</password></x>', u_payload_diff: '<diff/>', other: 'plain' }] },
  ]
  const { answer, call } = await connect([...hidden, ...dictionaryRoutes])
  const row = (await answer('sn_query', { table: 'v_props' })).records[0]
  assert.equal(row.prop_value, '[withheld: this field holds a secret]')
  assert.equal(row.u_payload, '<x><password>[withheld]</password></x>')
  assert.match(row.u_payload_diff, /^\[withheld: the comparison of two payloads/)
  assert.equal(row.other, 'plain')
  assert.equal(row.prop_name, 'glide.smtp.pw')
  assert.equal((await call('sn_query', { table: 'v_props', groupBy: 'prop_value' })).data.error, 'validation')
  // What is named like a payload is not searched, sorted or counted by there either.
  for (const args of [{ query: 'u_payloadLIKEs3cr' }, { query: 'ORDERBYu_payload' }, { groupBy: 'u_payload' }]) {
    const { data } = await call('sn_query', { table: 'v_props', ...args })
    assert.equal(data.error, 'validation', JSON.stringify(args))
    assert.match(data.message, /holds whole records as text/, JSON.stringify(args))
  }
})

test('names of records of other tables are kept back on the tables that are known to hold them', async () => {
  const WITHHELD = '[withheld: the record is in a table closed on this machine]'
  const tables: Route[] = ['sys_scope_privilege', 'sys_ui_recent_selection', 'sys_script_include'].map((name) => ({ table: 'sys_db_object', exact: `name=${name}`, rows: [tableRow(name, name)] }))
  const world: Route[] = [
    closedTables(tableRow('sys_script_include', 'Script Include')),
    ...tables,
    { table: 'sys_dictionary', query: 'nameINsys_scope_privilege', rows: [column('sys_scope_privilege', 'target_name'), column('sys_scope_privilege', 'target_type'), column('sys_scope_privilege', 'operation')] },
    { table: 'sys_dictionary', query: 'nameINsys_ui_recent_selection', rows: [column('sys_ui_recent_selection', 'display_value'), column('sys_ui_recent_selection', 'value'), column('sys_ui_recent_selection', 'field')] },
    ...dictionaryRoutes,
    {
      table: 'sys_scope_privilege',
      rows: [
        { target_name: 'PayrollUtils', target_type: 'sys_script_include', operation: 'execute' },
        { target_name: 'GlideRecord', target_type: 'scriptable', operation: 'execute' },
        { target_name: 'incident', target_type: 'sys_db_object', operation: 'read' },
        // Not a table the instance knows: what the name is of cannot be told.
        { target_name: 'Something', target_type: 'u_gone', operation: 'read' },
      ],
    },
    { table: 'sys_ui_recent_selection', rows: [{ display_value: 'Abel Tuter', value: ID, field: 'caller_id' }] },
  ]
  const closed = await connect([{ table: 'sys_db_object', exact: 'name=sys_db_object', rows: [tableRow('sys_db_object', 'Table')] }, ...world], { tables: { allow: [], deny: ['sys_script_include'] } })
  const privileges = await closed.answer('sn_query', { table: 'sys_scope_privilege', fields: ['target_name', 'operation'] })
  assert.deepEqual(privileges.records.map((row: Data) => row.target_name), [WITHHELD, 'GlideRecord', 'incident', WITHHELD])
  // Which record someone picked in a reference field: the row does not say which table it is of.
  const picked = await closed.answer('sn_query', { table: 'sys_ui_recent_selection', fields: ['display_value', 'field'] })
  assert.deepEqual(picked.records, [{ display_value: WITHHELD, field: 'caller_id' }])
  assert.equal((await closed.call('sn_query', { table: 'sys_ui_recent_selection', query: 'display_valueSTARTSWITHAbel' })).data.error, 'blocked')

  const open = await connect(world)
  assert.deepEqual((await open.answer('sn_query', { table: 'sys_scope_privilege', fields: ['target_name'] })).records.map((row: Data) => row.target_name), ['PayrollUtils', 'GlideRecord', 'incident', 'Something'])
})

test('what a field shows is passed on only for kinds of fields that show nothing of other records', async () => {
  // Measured: a condition shows the names behind the sys_ids it holds, and an attachment field shows the name of
  // its file. A comparison with text works on what such a field stores, so that stays possible.
  const fields: Route = {
    table: 'sys_dictionary',
    query: 'nameINincident,task',
    rows: [column('task', 'number'), column('task', 'u_filter', 'conditions'), column('task', 'u_document', 'file_attachment'), column('task', 'u_stage', 'workflow'), column('task', 'u_odd', 'a_kind_not_measured')],
  }
  const row = {
    number: 'INC1',
    u_filter: labelled(`caller_id=${ID}`, 'Caller is Abel Tuter'),
    u_document: labelled(ID, 'payroll-2026.xlsx'),
    u_stage: labelled('waiting', 'Waiting for approval'),
    u_odd: labelled('x', 'Something else'),
  }
  const world = [fields, { table: 'sys_db_object', exact: 'name=sys_attachment', rows: [tableRow('sys_attachment', 'Attachment')] }, ...dictionaryRoutes, { table: 'incident', rows: [row] }]
  const wanted = { table: 'incident', fields: ['number', 'u_filter', 'u_document', 'u_stage', 'u_odd'], displayValue: true }

  const users = await connect(world, { tables: { allow: [], deny: ['sys_user'] } })
  const data = await users.answer('sn_query', wanted)
  // The attachment table is open, so the name of the file stays. The stage shows its label.
  assert.deepEqual(data.records, [{ number: 'INC1', u_filter: `caller_id=${ID}`, u_document: { value: ID, display: 'payroll-2026.xlsx' }, u_stage: { value: 'waiting', display: 'Waiting for approval' }, u_odd: 'x' }])
  assert.match(data.warnings.join(' '), /could not be told which table these fields point to, so their display values were left out: u_filter, u_odd/)
  // Comparing the condition with text is a comparison with what is stored.
  assert.equal((await users.answer('sn_query', { table: 'incident', query: 'u_filterLIKEcaller_id', fields: ['number'] })).returned, 1)

  const attachments = await connect([closedTables(tableRow('sys_attachment', 'Attachment')), ...world], { tables: { allow: [], deny: ['sys_attachment'] } })
  const without = await attachments.answer('sn_query', wanted)
  assert.equal(without.records[0].u_document, ID)
  assert.match(without.warnings.join(' '), /closed on this machine were left out: u_document/)

  // Nothing is closed: everything is shown.
  const open = await connect(world)
  assert.deepEqual((await open.answer('sn_query', wanted)).records[0].u_filter, { value: `caller_id=${ID}`, display: 'Caller is Abel Tuter' })
})

test('a text search is refused on a table below the table of system properties', async () => {
  // Such a table hands out the value of a property under its own name, and a search reads fields it does not
  // name: the properties that hold a secret could not be left out of it.
  const below: Route[] = [
    { table: 'sys_db_object', exact: 'name=u_props', rows: [tableRow('u_props', 'More properties', 'sys_properties')] },
    { table: 'sys_dictionary', query: 'nameINu_props,sys_properties', rows: [column('sys_properties', 'name'), column('sys_properties', 'value'), column('sys_properties', 'type'), column('u_props', 'u_note')] },
    ...dictionaryRoutes,
    { table: 'u_props', rows: [{ name: 'x', value: 'ciphertext', type: 'password2', u_note: 'n' }] },
  ]
  const { call, answer, sentTo } = await connect(below)
  const { data } = await call('sn_query', { table: 'u_props', query: '123TEXTQUERY321=cipher' })
  assert.equal(data.error, 'validation')
  assert.match(data.message, /hands out the values of system properties/)
  assert.equal(sentTo('u_props').length, 0)
  // Read, the value comes without the type that would say whether it is a secret, so it is withheld whatever it holds.
  assert.equal((await answer('sn_query', { table: 'u_props', fields: ['name', 'value'] })).records[0].value, '[withheld: this field holds a secret]')
})

test('the value of a system property is not handed out under another name', async () => {
  const properties: Route[] = [
    { table: 'sys_db_object', query: 'name=sys_properties', rows: [tableRow('sys_properties', 'System Property', 'sys_metadata')] },
    { table: 'sys_db_object', query: 'name=sys_metadata', rows: [tableRow('sys_metadata', 'Application File')] },
    { table: 'sys_dictionary', query: 'nameINsys_properties,sys_metadata', rows: [column('sys_metadata', 'sys_name'), column('sys_properties', 'name'), column('sys_properties', 'value'), column('sys_properties', 'type')] },
    { table: 'sys_dictionary', query: 'nameINsys_metadata', rows: [column('sys_metadata', 'sys_name')] },
    ...dictionaryRoutes,
    { table: 'sys_properties', rows: [{ name: 'glide.smtp.pw', type: 'password2', value: 'ciphertext', 'ref_sys_properties.value': 'ciphertext' }] },
    { table: 'sys_metadata', rows: [{ sys_name: 'glide.smtp.pw', 'ref_sys_properties.value': 'ciphertext' }] },
  ]
  const { answer, call, sentTo } = await connect(properties)

  // Measured: the instance takes "ref_<the table itself>." and returns the field under that name. The server does not.
  for (const args of [{ fields: ['name', 'ref_sys_properties.value'] }, { query: 'ref_sys_properties.valueSTARTSWITHc' }, { groupBy: 'ref_sys_properties.value' }]) {
    const { data } = await call('sn_query', { table: 'sys_properties', ...args })
    assert.equal(data.error, 'validation', JSON.stringify(args))
    assert.match(data.message, /Unknown field/)
  }
  assert.equal(sentTo('sys_properties').length, 0)

  // From the parent table the path is a real one. There the type of the property is not at hand, so the value is withheld.
  const data = await answer('sn_query', { table: 'sys_metadata', fields: ['sys_name', 'ref_sys_properties.value'] })
  assert.deepEqual(data.records, [{ sys_name: 'glide.smtp.pw', 'ref_sys_properties.value': '[withheld: this field holds a secret]' }])
  for (const args of [{ query: 'ref_sys_properties.valueSTARTSWITHc' }, { groupBy: 'ref_sys_properties.value' }]) {
    assert.equal((await call('sn_query', { table: 'sys_metadata', ...args })).data.error, 'validation', JSON.stringify(args))
  }
})

test('a dictionary entry without a type is no proof that a field is harmless', async () => {
  // The row of the dictionary is visible, its type is not: an access rule on that one field is enough for this.
  const untyped: Route[] = [
    { table: 'sys_dictionary', query: 'nameINsys_user', rows: [column('sys_user', 'name'), column('sys_user', 'user_password', ''), column('sys_user', 'manager', '')] },
    ...dictionaryRoutes,
    { table: 'sys_user', rows: [{ name: 'Abel', user_password: '$s$hash', manager: labelled(ID, 'Beth Anglin') }] },
  ]
  const { answer, call } = await connect(untyped)
  assert.equal((await answer('sn_query', { table: 'sys_user', fields: ['name', 'user_password'] })).records[0].user_password, '[withheld: this field holds a secret]')
  assert.match((await call('sn_query', { table: 'sys_user', query: 'user_passwordSTARTSWITH$' })).data.message, /judged by its name/)

  // With tables closed, a field of unknown type may point into one of them: no name is passed on, and none can be probed.
  const closed = await connect([{ table: 'sys_db_object', query: 'name=sys_user', rows: [tableRow('sys_user', 'User')] }, ...untyped], { tables: { allow: [], deny: ['sys_group'] } })
  const data = await closed.answer('sn_query', { table: 'sys_user', fields: ['name', 'manager'], displayValue: true })
  assert.deepEqual(data.records, [{ name: 'Abel', manager: ID }])
  assert.equal((await closed.call('sn_query', { table: 'sys_user', query: 'managerSTARTSWITHBe' })).data.error, 'blocked')
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

// The stored codes behind the labels, as measured: the tools decide on the codes.
const DISPOSITION_CODES: Record<string, string> = { Skipped: '4', 'Skipped Error': '9', 'Skipped Manual Merge': '10', 'Skipped Apply Once': '11' }
const REVIEW_CODES: Record<string, string> = { 'Not Reviewed': '1', Reviewed: '2', 'Reviewed and Reverted': '5' }
const skip = (disposition: string, review = 'Not Reviewed', label = disposition) => ({
  'upgrade_detail.disposition': labelled(DISPOSITION_CODES[disposition] ?? '4', label),
  'upgrade_detail.target_name': 'Example rule',
  'upgrade_detail.upgrade_history.to_version': 'glide-australia-02-11-2026__patch1.zip',
  state: labelled(REVIEW_CODES[review] ?? '1', review),
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
  // The record, its update rows, its versions, the entries of upgrades. The versions are counted from the page.
  assert.equal(calls.length, 4)
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

test('sn_origin decides from what is in view where the versions cannot be counted, and abstains where that is not enough', async () => {
  // More versions than one page shows, and the Aggregate API does not answer. No change is captured and the version
  // marked current is the vendor's: earlier versions, whoever made them, do not change what the record holds now.
  const many = [version('current', 'sys_upgrade_history', '2026-03-01 00:00:00'), ...Array.from({ length: 13 }, () => version('previous', 'sys_upgrade_history', '2025-03-01 00:00:00'))]
  const uncounted = (rows: Data[], changes: Data[] = [], fileExtra: Data = {}): Route[] => [
    { table: 'sys_metadata', rows: [file('sys_plugins', fileExtra)] },
    { table: 'sys_update_xml', rows: changes },
    { table: 'sys_update_version', rows },
    { table: 'sys_update_version', api: 'stats', status: 403 },
  ]
  const { answer } = await connect(uncounted(many))
  const data = await answer('sn_origin', { sysId: ID })
  assert.deepEqual({ verdict: data.verdict, divergence: data.divergence, created: data.created, bySource: data.evidence.versions.bySource }, { verdict: 'out_of_box_as_captured', divergence: 'no_customer_changes_captured', created: 'delivered', bySource: null })
  // A vendor version is in view, so the count is not missed.
  assert.doesNotMatch(data.warnings.join(' '), /Aggregate API/)

  // A vendor version in view proves delivery of a changed record as well.
  const mixed = [version('current', 'sys_update_set', '2026-03-01 10:00:00', 'abel'), version('previous', 'sys_upgrade_history', '2025-01-01 00:00:00'), ...Array.from({ length: 12 }, () => version('previous', 'sys_update_set', '2025-06-01 00:00:00', 'abel'))]
  const delivered = await (await connect(uncounted(mixed, [change()]))).answer('sn_origin', { sysId: ID })
  assert.deepEqual({ verdict: delivered.verdict, created: delivered.created }, { verdict: 'customized', created: 'delivered' })

  // No version marked current is in view and none can be counted: whose content the record holds is not known.
  const none = Array.from({ length: 14 }, () => version('previous', 'sys_upgrade_history', '2025-03-01 00:00:00'))
  const open = await (await connect([...uncounted(none).slice(0, 2), { table: 'sys_update_version', query: 'state=current', rows: [] }, ...uncounted(none).slice(2)])).answer('sn_origin', { sysId: ID })
  assert.equal(open.divergence, 'unknown')

  // A changed record of a platform package, created at its first capture, with nothing but versions from update sets
  // in view: without the count a vendor version cannot be ruled out, so "created here" is not concluded, and that
  // such records are rare is no argument for "delivered".
  const local = Array.from({ length: 14 }, (_, index) => version(index ? 'previous' : 'current', 'sys_update_set', '2026-03-01 10:00:00', 'abel'))
  const changed = await (await connect(uncounted(local, [change()], { sys_created_on: '2026-03-01 10:00:00' }))).answer('sn_origin', { sysId: ID })
  assert.deepEqual({ verdict: changed.verdict, created: changed.created }, { verdict: 'unknown', created: 'unknown' })
  assert.match(changed.explanation, /its versions could not be counted, so a vendor version cannot be ruled in or out/)
  assert.match(changed.warnings.join(' '), /Aggregate API/)
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

  // Not one of the fields the platform adds itself, also where the name begins like one: nothing says who delivered the entry.
  for (const element of ['word', 'sys_legacy_id']) {
    const other = await connect(routes('sys_dictionary', element, 'sys_plugins'))
    assert.equal((await other.answer('sn_origin', { sysId: ID })).verdict, 'unknown', element)
    assert.equal(other.sentTo('sys_db_object').length, 0, element)
  }
  const bare = await connect(routes('sys_dictionary', 'sys_id', ''))
  const undecided = await bare.answer('sn_origin', { sysId: ID })
  assert.equal(undecided.verdict, 'unknown')
  assert.match(undecided.explanation, /belongs to no package/)
})

test('sn_origin: an entry of an upgrade that may be hidden leaves open whether the record was found changed', async () => {
  // One entry is in view, and it was reverted. Without a total, a newer entry that this account cannot see cannot
  // be ruled out, and that one would say that the record differs.
  const reverted = skip('Skipped', 'Reviewed and Reverted')
  const noTotal = await connect([{ table: 'upgrade_history_task', query: 'upgrade_detail.file_name=', rows: [reverted], noTotal: true }, ...origin('sys_plugins', [], [])])
  const data = await noTotal.answer('sn_origin', { sysId: ID })
  assert.equal(data.divergence, 'unknown')
  assert.notEqual(data.verdict, 'out_of_box_as_captured')
  assert.match(data.warnings.join(' '), /did not say how many entries upgrades have for this record/)
  // With a total that matches what came back, the reverted entry is all there is.
  const counted = await connect(origin('sys_plugins', [], [], {}, [reverted]))
  assert.equal((await counted.answer('sn_origin', { sysId: ID })).verdict, 'out_of_box_as_captured')
})

test('sn_origin: a record that a table left out with the rows of its closed child tables is not "not found"', async () => {
  // An incident is a row of task. Asked for as "task_<sys_id>" with incidents closed, the table of tasks answers
  // without it, and "no such record" would be a statement about a record that is there.
  const world: Route[] = [
    closedTables(tableRow('incident', 'Incident', 'task')),
    ...['sys_metadata', 'sys_update_xml', 'sys_update_version', 'upgrade_history_task', 'sys_upgrade_history_log', 'sys_upgrade_history', 'sys_package', 'sys_scope'].map((name): Route => ({ table: 'sys_db_object', exact: `name=${name}`, rows: [tableRow(name, name)] })),
    { table: 'sys_dictionary', query: 'nameINsys_metadata', rows: [column('sys_metadata', 'sys_package', 'reference', 'sys_package'), column('sys_metadata', 'sys_scope', 'reference', 'sys_scope'), column('sys_metadata', 'sys_class_name', 'sys_class_name')] },
    { table: 'sys_dictionary', query: 'nameINsys_package', rows: [column('sys_package', 'sys_class_name', 'sys_class_name'), column('sys_package', 'name')] },
    { table: 'sys_dictionary', query: 'nameINsys_scope', rows: [column('sys_scope', 'scope'), column('sys_scope', 'name')] },
    { table: 'sys_dictionary', query: 'nameINupgrade_history_task', rows: [column('upgrade_history_task', 'upgrade_detail', 'reference', 'sys_upgrade_history_log'), column('upgrade_history_task', 'state', 'integer')] },
    { table: 'sys_dictionary', query: 'nameINsys_upgrade_history_log', rows: [column('sys_upgrade_history_log', 'file_name'), column('sys_upgrade_history_log', 'target_name'), column('sys_upgrade_history_log', 'disposition', 'integer'), column('sys_upgrade_history_log', 'upgrade_history', 'reference', 'sys_upgrade_history')] },
    { table: 'sys_dictionary', query: 'nameINsys_upgrade_history', rows: [column('sys_upgrade_history', 'to_version')] },
    ...dictionaryRoutes,
    { table: 'task', rows: [] },
    ...origin(null, [], []),
  ]
  const closed = await connect(world, { tables: { allow: [], deny: ['incident'] } })
  const data = await closed.answer('sn_origin', { updateName: `task_${ID}` })
  assert.equal(closed.sentTo('task')[0].query, `sys_id=${ID}^sys_class_nameNOT INincident^ORsys_class_nameISEMPTY`)
  assert.notEqual(data.verdict, 'not_found')
  assert.match(data.warnings.join(' '), /Rows of tables that are closed on this machine were left out of the look-up in "task"/)
  // With nothing closed, the same answer of the table means that there is no such record.
  const open = await connect(world)
  assert.equal((await open.answer('sn_origin', { updateName: `task_${ID}` })).verdict, 'not_found')

  // A name that says which table the record is of, and that table is open with nothing closed below it: then
  // nothing that was left out anywhere can be this record, and "no such record" stands.
  const actions: Route[] = [{ table: 'sys_db_object', exact: 'name=sys_ui_action', rows: [tableRow('sys_ui_action', 'UI Action', 'sys_metadata')] }, { table: 'sys_ui_action', rows: [] }]
  const precise = await connect([...actions, ...world], { tables: { allow: [], deny: ['incident'] } })
  const none = await precise.answer('sn_origin', { updateName: `sys_ui_action_${ID}` })
  assert.equal(none.verdict, 'not_found')
  assert.doesNotMatch(none.warnings.join(' '), /left out of the look-up/)
  // Asked for by its sys_id, the record can be of any table, also of one whose rows were left out.
  const bySysId = await precise.answer('sn_origin', { sysId: ID })
  assert.notEqual(bySysId.verdict, 'not_found')
  assert.match(bySysId.warnings.join(' '), /Application files of tables that are closed on this machine were left out/)
})

test('a login that is rejected in the middle of a call is passed on as that', async () => {
  // Not as "this table is closed on this machine", and not as a list of categories that could not be read.
  const rejected = (table: string): Route => ({ table, status: 401 })
  const plugins = await connect(
    [{ table: 'v_plugin', rows: [{ id: 'com.example', name: 'Example', active: 'active', version: '1.0' }] }, { table: 'sys_db_object', exact: 'name=v_plugin', rows: [tableRow('v_plugin', 'Plugin')] }, { table: 'sys_db_object', exact: 'name=sys_store_app', status: 401 }, rejected('sys_store_app'), ...dictionaryRoutes],
    { tables: { allow: [], deny: ['sys_user'] } },
  )
  const listed = await plugins.call('sn_plugins')
  assert.equal(listed.data.error, 'auth')
  assert.doesNotMatch(JSON.stringify(listed.data), /closed on this machine/)
  // On a connection of its own: after a rejected login the client sends nothing for a while, and that would fail
  // the call whatever the tool does with the failure.
  const instance = await connect(
    [{ table: 'sys_db_object', exact: 'name=sys_store_app', status: 401 }, { table: 'sys_db_object', exact: 'name=v_plugin', rows: [tableRow('v_plugin', 'Plugin')] }, { table: 'v_plugin', rows: [] }, ...dictionaryRoutes],
    { tables: { allow: [], deny: ['sys_user'] } },
  )
  const overview = await instance.call('sn_instance')
  assert.equal(overview.data.error, 'auth')
  // The entries of upgrades are one more witness, and many accounts cannot read them: that is no failure. A login
  // that is rejected there is one.
  const witness = await connect([{ table: 'upgrade_history_task', status: 401 }, ...origin('sys_plugins', [], [])])
  assert.equal((await witness.call('sn_origin', { sysId: ID })).data.error, 'auth')
  const unreadable = await connect([{ table: 'upgrade_history_task', status: 403 }, ...origin('sys_plugins', [], [])])
  assert.equal((await unreadable.answer('sn_origin', { sysId: ID })).verdict, 'out_of_box_as_captured')

  const attached = await connect([...['sys_script', 'sys_script_client', 'sys_ui_policy', 'sys_ui_action', 'sys_security_acl', 'sys_data_policy2'].map(rejected), ...dictionaryRoutes])
  const answer = await attached.call('sn_dependencies', { table: 'incident' })
  assert.equal(answer.data.error, 'auth')
  // One table that this account may not read is a category that could not be checked, and the others are answered.
  const partly = await connect([{ table: 'sys_script', status: 403 }, { table: 'sys_script', api: 'stats', status: 403 }, ...dictionaryRoutes])
  const some = await partly.answer('sn_dependencies', { table: 'incident', categories: ['businessRules', 'clientScripts'] })
  assert.equal(some.categories.businessRules.status, 'not_checked')
})

test('sn_origin decides on stored codes, so the language of the account does not matter', async () => {
  // An account that reads German gets "Übersprungen" for the disposition and its own word for the review state.
  const german = await connect(origin('sys_plugins', [], [], {}, [skip('Skipped', 'Not Reviewed', 'Übersprungen')]))
  const data = await german.answer('sn_origin', { sysId: ID })
  assert.deepEqual({ divergence: data.divergence, verdict: data.verdict }, { divergence: 'changed_without_capture', verdict: 'customized' })

  const reverted = { ...skip('Skipped', 'Reviewed and Reverted', 'Übersprungen'), state: labelled('5', 'Geprüft und zurückgesetzt') }
  const back = await connect(origin('sys_plugins', [], [], {}, [reverted]))
  assert.equal((await back.answer('sn_origin', { sysId: ID })).verdict, 'out_of_box_as_captured')

  // The instance lists its own codes: they are taken from there, by the English labels of the choice lists.
  const own = await connect([
    { table: 'sys_choice', rows: [{ name: 'sys_upgrade_history_log', element: 'disposition', value: '77', label: 'Skipped by policy' }, { name: 'upgrade_history_task', element: 'state', value: '8', label: 'Reverted to base' }] },
    ...origin('sys_plugins', [], [], {}, [{ ...skip('Skipped'), 'upgrade_detail.disposition': labelled('77', 'Nach Richtlinie übersprungen') }]),
  ])
  assert.equal((await own.answer('sn_origin', { sysId: ID })).verdict, 'customized')
})

test('sn_origin: the newest entry of an upgrade that says "differs" counts, not just the newest entry', async () => {
  // A patch in October could not apply the file. The family upgrade in September had found it changed, and nobody reverted it.
  const rows = [{ ...skip('Skipped Error'), sys_created_on: '2026-10-15 12:00:00' }, skip('Skipped Manual Merge')]
  const { answer } = await connect(origin('sys_plugins', [], [], {}, rows))
  const data = await answer('sn_origin', { sysId: ID })
  assert.deepEqual({ divergence: data.divergence, verdict: data.verdict }, { divergence: 'changed_without_capture', verdict: 'customized' })
  assert.match(data.warnings.join(' '), /did not overwrite it \("Skipped Manual Merge"\)/)
})

test('sn_origin: a record that was deleted once and made again is not called deleted', async () => {
  const name = `u_custom_${ID}`
  const rows = [change({ name, sys_updated_on: '2026-03-02 10:00:00' }), change({ name, action: 'DELETE', sys_updated_on: '2026-03-01 10:00:00' })]
  // The table of the record does not exist any more, so nothing but the update rows speaks. The newest of them decides.
  const { answer } = await connect([{ table: 'sys_metadata', rows: [] }, { table: 'sys_update_xml', rows }, { table: 'sys_update_version', rows: [] }])
  const data = await answer('sn_origin', { updateName: name })
  assert.equal(data.verdict, 'unknown')
  assert.match(data.warnings.join(' '), /Update rows or versions exist under this name, but the record itself is not readable/)

  const gone = await connect([{ table: 'sys_metadata', rows: [] }, { table: 'sys_update_xml', rows: [...rows].reverse() }, { table: 'sys_update_version', rows: [] }])
  assert.equal((await gone.answer('sn_origin', { updateName: name })).verdict, 'deleted_here')

  // Without a total from the instance, a newer change that is hidden cannot be ruled out, so "deleted" is not said.
  const blind = await connect([{ table: 'sys_metadata', rows: [] }, { table: 'sys_update_xml', rows: [...rows].reverse(), noTotal: true }, { table: 'sys_update_version', rows: [] }])
  const unsure = await blind.answer('sn_origin', { updateName: name })
  assert.equal(unsure.verdict, 'unknown')
  assert.match(unsure.warnings.join(' '), /newest captured change in view is a delete, but a newer one that is hidden from this account could not be ruled out/)
})

test('sn_origin: where the table of application files gives no total, the record is still read as an application file', async () => {
  // "No rows" without a total is not "no such file". Read from its own table, the record brings its package along.
  const routes: Route[] = [
    { table: 'sys_metadata', rows: [], noTotal: true },
    { table: 'sys_db_object', query: 'name=sys_script', rows: [tableRow('sys_script', 'Business Rule', 'sys_metadata')] },
    { table: 'sys_dictionary', query: 'nameINsys_script,sys_metadata', rows: [column('sys_metadata', 'sys_package', 'reference', 'sys_package'), column('sys_script', 'name')] },
    { table: 'sys_script', rows: [file('sys_plugins')] },
    { table: 'sys_update_xml', rows: [change()] },
    { table: 'sys_update_version', rows: [version('current', 'sys_update_set', '2026-03-01 10:00:00', 'abel')] },
    stats('sys_update_version', { sys_update_set: 1 }),
    { table: 'upgrade_history_task', query: 'upgrade_detail.file_name=', rows: [] },
  ]
  const { answer, sentTo } = await connect(routes)
  const data = await answer('sn_origin', { updateName: NAME })
  assert.ok(sentTo('sys_script')[0].params.get('sysparm_fields')!.split(',').includes('sys_package'))
  // A record of a platform package that was changed here, not one that was created here.
  assert.deepEqual({ provenance: data.provenance, verdict: data.verdict }, { provenance: 'vendor', verdict: 'customized' })
})

test('sn_origin finds the current version among many, and does not vouch for a source it does not know', async () => {
  // Eleven versions. Sorted by state, a state the instance added pushes the current one off the page.
  const many = [...Array.from({ length: 10 }, () => version('archived', 'sys_upgrade_history', '2025-01-01 00:00:00')), version('current', 'sys_update_set', '2026-03-01 10:00:00', 'abel')]
  const { answer, sentTo } = await connect([
    { table: 'sys_metadata', rows: [file('sys_plugins')] },
    { table: 'sys_update_xml', rows: [] },
    { table: 'sys_update_version', query: 'state=current', rows: [many[10]] },
    { table: 'sys_update_version', rows: many },
    stats('sys_update_version', { sys_upgrade_history: 10, sys_update_set: 1 }),
  ])
  const data = await answer('sn_origin', { sysId: ID })
  assert.deepEqual({ divergence: data.divergence, verdict: data.verdict }, { divergence: 'customer_changes_captured', verdict: 'customized' })
  assert.equal(data.evidence.versions.current.source_table, 'sys_update_set')
  assert.equal(sentTo('sys_update_version').at(-1)?.query, `name=${NAME}^state=current^ORDERBYDESCsys_created_on`)

  // A current version that comes from a repository: whose content it is, this tool cannot say.
  const repo = await connect(origin('sys_store_app', [], [version('current', 'sys_repo_config', '2026-03-01 10:00:00', 'abel')]))
  const other = await repo.answer('sn_origin', { sysId: ID })
  assert.deepEqual({ divergence: other.divergence, verdict: other.verdict }, { divergence: 'unknown', verdict: 'unknown' })
  assert.match(other.warnings.join(' '), /comes from "sys_repo_config", a source this tool does not classify/)
})

test('sn_origin: an application the company develops elsewhere is not called out-of-the-box', async () => {
  // Installed from the company's repository it arrives like an application from the store. Its scope carries the company's prefix.
  const code = { table: 'sys_properties', rows: [{ name: 'glide.appcreator.company.code', value: 'acme' }] }
  const own = await connect([code, ...origin('sys_store_app', [], [version('current', 'sys_store_app', '2026-03-01 10:00:00')], { 'sys_scope.scope': 'x_acme_claims' })])
  const data = await own.answer('sn_origin', { sysId: ID })
  assert.deepEqual({ verdict: data.verdict, provenance: data.provenance }, { verdict: 'custom_application_file', provenance: 'company_application' })
  assert.match(data.explanation, /this company develops.*neither the vendor's nor a change/)

  // Another vendor's prefix, the platform's own prefix, or no readable company code: an installed application like any other.
  for (const [routes, scope] of [[[code], 'x_other_claims'], [[code], 'sn_hr_core'], [[], 'x_acme_claims']] as Array<[Route[], string]>) {
    const other = await connect([...routes, ...origin('sys_store_app', [], [version('current', 'sys_store_app', '2026-03-01 10:00:00')], { 'sys_scope.scope': scope })])
    const answer = await other.answer('sn_origin', { sysId: ID })
    assert.deepEqual({ verdict: answer.verdict, provenance: answer.provenance }, { verdict: 'out_of_box_as_captured', provenance: 'installed_application' }, scope)
  }
})

test('sn_origin: dates and versions decide more cases, and not more than they can', async () => {
  // No package at all, changed here, no vendor version: nothing says the vendor delivered it, however old it is.
  const bare = await connect(origin('', [change()], [version('current', 'sys_update_set', '2026-03-01 10:00:00', 'abel')], { sys_package: '' }))
  const old = await bare.answer('sn_origin', { sysId: ID })
  assert.deepEqual({ created: old.created, verdict: old.verdict }, { created: 'here', verdict: 'customer_created' })

  // Inside an installed application, the update row is gone. The record is as old as its only version, which came from an update set.
  const made = await connect(origin('sys_store_app', [], [version('current', 'sys_update_set', '2026-03-01 10:00:00', 'abel')], { sys_created_on: '2026-03-01 10:00:00' }))
  const here = await made.answer('sn_origin', { sysId: ID })
  assert.deepEqual({ created: here.created, verdict: here.verdict }, { created: 'here', verdict: 'customer_created' })

  // A change marked to be replaced by the next upgrade.
  const replaced = await connect(origin('sys_plugins', [change({ replace_on_upgrade: 'true' })], [version('current', 'sys_update_set', '2026-03-01 10:00:00', 'abel'), version('previous', 'sys_upgrade_history', '2026-03-01 09:59:59')]))
  assert.match((await replaced.answer('sn_origin', { sysId: ID })).warnings.join(' '), /marked "replace on upgrade"/)

  // The instance gives no total, and no record comes back: whether it exists is not established.
  const silent = await connect([{ table: 'sys_metadata', rows: [], noTotal: true }, { table: 'sys_update_xml', rows: [] }, { table: 'sys_update_version', rows: [] }])
  assert.equal((await silent.answer('sn_origin', { sysId: ID })).verdict, 'unknown')
})

test('sn_origin still answers from the evidence when the table of application files cannot be read', async () => {
  const name = `sys_choice_${ID}`
  const choice = { sys_id: ID, sys_created_on: '2026-03-01 10:00:00', sys_created_by: 'abel', sys_updated_on: '2026-03-01 10:00:00', sys_updated_by: 'abel' }
  const evidence: Route[] = [
    { table: 'sys_update_xml', rows: [change({ name })] },
    { table: 'sys_update_version', rows: [version('current', 'sys_update_set', '2026-03-01 10:00:00', 'abel')] },
  ]
  // The dictionary says that a choice carries no package: it is no application file.
  const plain: Route[] = [
    { table: 'sys_db_object', exact: 'name=sys_choice', rows: [tableRow('sys_choice', 'Choice')] },
    { table: 'sys_dictionary', query: 'nameINsys_choice', rows: [column('sys_choice', 'name'), column('sys_choice', 'element'), column('sys_choice', 'value')] },
    ...dictionaryRoutes,
  ]
  const { answer } = await connect([{ table: 'sys_metadata', status: 403 }, { table: 'sys_choice', query: 'sys_id=', rows: [choice] }, ...plain, ...evidence])
  const data = await answer('sn_origin', { updateName: name })
  assert.deepEqual({ verdict: data.verdict, table: data.record.table }, { verdict: 'customer_created', table: 'sys_choice' })
  assert.match(data.warnings.join(' '), /sys_metadata could not be read \(acl\)/)

  // Without the dictionary nothing says whether the record belongs to a package: "created here" is not concluded.
  const blind = await connect([{ table: 'sys_metadata', status: 403 }, { table: 'sys_db_object', status: 403 }, { table: 'sys_choice', rows: [choice] }, ...evidence])
  const unsure = await blind.answer('sn_origin', { updateName: name })
  assert.equal(unsure.verdict, 'unknown')
  assert.match(unsure.explanation, /Whether it belongs to a package could not be read/)

  // An application file is read from its own table with its package: a customized business rule of the platform is
  // not taken for one that was made here.
  const rule = { sys_id: ID, sys_class_name: 'sys_script', sys_update_name: NAME, sys_created_on: '2020-01-01 00:00:00', sys_created_by: 'vendor.dev', sys_updated_on: '2026-03-01 10:00:00', sys_updated_by: 'abel', sys_package: labelled('p1', 'Core'), 'sys_package.sys_class_name': 'sys_plugins' }
  const files: Route[] = [
    { table: 'sys_db_object', exact: 'name=sys_script', rows: [tableRow('sys_script', 'Business Rule', 'sys_metadata')] },
    { table: 'sys_dictionary', query: 'nameINsys_script,sys_metadata', rows: [column('sys_metadata', 'sys_package', 'reference', 'sys_package'), column('sys_metadata', 'sys_update_name'), column('sys_script', 'name')] },
    ...dictionaryRoutes,
  ]
  const viaOwn = await connect([{ table: 'sys_metadata', status: 403 }, ...files, { table: 'sys_script', rows: [rule] }, { table: 'sys_update_xml', rows: [change()] }, { table: 'sys_update_version', rows: [version('current', 'sys_update_set', '2026-03-01 10:00:00', 'abel')] }])
  const judged = await viaOwn.answer('sn_origin', { updateName: NAME })
  assert.deepEqual({ verdict: judged.verdict, provenance: judged.provenance, created: judged.created, package: judged.record.package }, { verdict: 'customized', provenance: 'vendor', created: 'delivered', package: 'Core' })

  // A wrong login is not a missing piece of evidence: the call fails.
  const rejected = await connect([{ table: 'sys_metadata', status: 401 }])
  assert.equal((await rejected.call('sn_origin', { sysId: ID })).data.error, 'auth')
})

test('sn_origin: an untouched record of the global scope with a vendor version was delivered', async () => {
  const { answer } = await connect(origin('sys_scope', [], [version('current', 'sys_upgrade_history', '2026-03-01 00:00:00')]))
  const data = await answer('sn_origin', { sysId: ID })
  assert.deepEqual({ verdict: data.verdict, created: data.created }, { verdict: 'out_of_box_as_captured', created: 'delivered' })
})

test('sn_origin sees a revert when the vendor version is a few seconds older than the last change', async () => {
  // The two are written in the same moment, and the clock of the update row can be seconds ahead.
  const row = change({ sys_created_on: '2026-03-01 09:00:00', sys_updated_on: '2026-03-01 10:00:00' })
  const near = await connect(origin('sys_store_app', [row], [version('current', 'sys_store_app', '2026-03-01 09:59:57', 'abel')]))
  assert.match((await near.answer('sn_origin', { sysId: ID })).warnings.join(' '), /reverted to the vendor version/)
  const far = await connect(origin('sys_store_app', [row], [version('current', 'sys_store_app', '2026-03-01 09:30:00', 'abel')]))
  assert.doesNotMatch((await far.answer('sn_origin', { sysId: ID })).warnings.join(' '), /reverted to the vendor version/)
})

test('sn_origin says so when the table that would answer for a system field cannot be read', async () => {
  const { answer } = await connect([
    { table: 'sys_dictionary', rows: [{ sys_id: ID, name: 'x_acme_case', element: 'sys_id' }] },
    { table: 'sys_db_object', status: 403 },
    ...origin('', [], [], { sys_update_name: '', sys_class_name: 'sys_dictionary', sys_package: '' }),
  ])
  const data = await answer('sn_origin', { sysId: ID })
  assert.equal(data.verdict, 'unknown')
  assert.match(data.warnings.join(' '), /the package of the table "x_acme_case" could not be read from sys_db_object \(acl\)/)
  assert.match(data.explanation, /Whether it belongs to a package could not be read/)

  // The same entry with a captured change: without the package of its table, "created here" is not concluded from
  // the fact that the entry names no package of its own.
  const customized = await connect([
    { table: 'sys_dictionary', rows: [{ sys_id: ID, name: 'incident', element: 'sys_id' }] },
    { table: 'sys_db_object', status: 403 },
    ...origin('', [change({ name: 'sys_dictionary_incident_sys_id' })], [version('current', 'sys_update_set', '2026-03-01 10:00:00', 'abel')], { sys_update_name: 'sys_dictionary_incident_sys_id', sys_class_name: 'sys_dictionary', sys_package: '' }),
  ])
  const unsure = await customized.answer('sn_origin', { sysId: ID })
  assert.deepEqual({ verdict: unsure.verdict, created: unsure.created }, { verdict: 'unknown', created: 'unknown' })

  // The table of a company's own application answers for the system field with its scope as well as its package:
  // the generated entry itself sits in the global scope.
  const company = await connect([
    { table: 'sys_properties', rows: [{ name: 'glide.appcreator.company.code', value: 'acme' }] },
    { table: 'sys_dictionary', rows: [{ sys_id: ID, name: 'x_acme_claims_case', element: 'sys_id' }] },
    { table: 'sys_db_object', query: 'name=x_acme_claims_case', rows: [{ name: 'x_acme_claims_case', sys_package: labelled('p9', 'Claims'), 'sys_package.sys_class_name': 'sys_store_app', 'sys_scope.scope': 'x_acme_claims' }] },
    ...origin('', [], [], { sys_update_name: '', sys_class_name: 'sys_dictionary', sys_package: '', 'sys_scope.scope': 'global' }),
  ])
  const ours = await company.answer('sn_origin', { sysId: ID })
  assert.deepEqual({ verdict: ours.verdict, provenance: ours.provenance }, { verdict: 'custom_application_file', provenance: 'company_application' })
})

test('sn_origin says why, whenever it does not decide', async () => {
  const cases: Array<[string, Route[], RegExp]> = [
    // Measured: one application file in nine belongs to no package, and almost none of those was ever captured.
    ['no package', origin('', [], [], { sys_package: '' }), /belongs to no package.*Nothing on the instance says who delivered it/],
    // Measured: 492 application files name a package whose own record does not come back.
    ['a package that cannot be read', origin('', [], []), /package it names could not be read/],
    ['global scope, untouched', origin('sys_scope', [], []), /belongs to the global scope and not to a package/],
    ['changed inside an installed application', origin('sys_store_app', [], [version('current', 'sys_update_set', '2026-03-01 10:00:00', 'abel')]), /delivered and then changed, or created here/],
    ['hidden from the account', [{ table: 'sys_metadata', rows: [null] }], /The record exists, but this account may not read it/],
    ['a part of another record', origin('sys_plugins', [], [], { sys_update_name: '', sys_class_name: 'sys_hub_action_input' }), /no update name of it could be used/],
    ['evidence not readable', [{ table: 'sys_metadata', rows: [file('sys_plugins')] }, { table: 'sys_update_xml', status: 403 }, { table: 'sys_update_version', rows: [] }, stats('sys_update_version', {})], /part of the evidence is missing, hidden, or came without a total/],
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
  // A dictionary entry is an application file itself: its own table gives the package along with what it describes.
  const entry = (kind: string, extra: Data) => ({ ...file('sys_plugins', { sys_update_name: '', sys_class_name: kind }), ...extra })
  const lookup = (kind: string, rows: Data[]): Route[] => [{ table: 'sys_metadata', query: 'sys_update_name=', rows: [] }, { table: kind, rows }, ...origin(null, [], []).slice(1)]

  const field = await connect(
    lookup('sys_dictionary', [entry('sys_dictionary', { sys_id: 'f'.repeat(32), name: 'cmdb_ci', element: 'name' }), entry('sys_dictionary', { name: 'cmdb_ci_server', element: 'host_name' })]),
  )
  const data = await field.answer('sn_origin', { updateName: 'sys_dictionary_cmdb_ci_server_host_name' })
  assert.equal(data.verdict, 'out_of_box_as_captured')
  assert.deepEqual({ sysId: data.record.sysId, updateName: data.record.updateName, package: data.record.package }, { sysId: ID, updateName: 'sys_dictionary_cmdb_ci_server_host_name', package: 'Example package' })
  // The name does not say where the table ends and the field begins: every split is asked for, and the row that gives the same name is taken.
  // Every place where the table can end and the field begin, each as an exact pair.
  assert.equal(field.sentTo('sys_dictionary')[0].query, 'name=cmdb^element=ci_server_host_name^NQname=cmdb_ci^element=server_host_name^NQname=cmdb_ci_server^element=host_name^NQname=cmdb_ci_server_host^element=name')
  assert.equal(field.sentTo('sys_metadata').length, 1, 'the entry is read once, from its own table')
  assert.equal(field.sentTo('sys_update_xml')[0].query, 'name=sys_dictionary_cmdb_ci_server_host_name^ORDERBYDESCsys_updated_on')
  assert.equal(field.calls.length, 5)

  const label = await connect(lookup('sys_documentation', [entry('sys_documentation', { name: 'incident', element: 'category', language: 'en' })]))
  assert.equal((await label.answer('sn_origin', { updateName: 'sys_documentation_incident_category_en' })).verdict, 'out_of_box_as_captured')

  // Some delivered records carry a sys_id that is a word. The entry is found all the same.
  const worded = await connect(lookup('sys_dictionary', [entry('sys_dictionary', { sys_id: 'dict_incident_category', name: 'incident', element: 'category' })]))
  assert.equal((await worded.answer('sn_origin', { updateName: 'sys_dictionary_incident_category' })).verdict, 'out_of_box_as_captured')

  // No such field: that is established, because the dictionary was readable.
  const none = await connect(lookup('sys_dictionary', []))
  assert.equal((await none.answer('sn_origin', { updateName: 'sys_dictionary_incident_no_such_field' })).verdict, 'not_found')

  // The dictionary is not readable, hides rows, or has more candidates than one page: then nothing is established.
  const others = Array.from({ length: 60 }, (_, index) => entry('sys_dictionary', { sys_id: String(index).padStart(32, '0'), name: 'incident', element: `other_${index}` }))
  for (const route of [{ table: 'sys_dictionary', status: 403 }, { table: 'sys_dictionary', rows: [null] }, { table: 'sys_dictionary', rows: others }]) {
    const blind = await connect([{ table: 'sys_metadata', rows: [] }, route, ...origin(null, [], []).slice(1)])
    const unknown = await blind.answer('sn_origin', { updateName: 'sys_dictionary_incident_category' })
    assert.equal(unknown.verdict, 'unknown')
    assert.match(unknown.warnings.join(' '), /sys_dictionary could not be read completely/)
  }
})

test('the query that finds a record by the name built from its content', () => {
  assert.deepEqual(queryByContent('sys_dictionary_incident_category'), { table: 'sys_dictionary', query: 'name=incident^element=category' })
  // The entry of a table itself is named "..._null" and has no element. "u_null" would be a field of that name too.
  assert.deepEqual(queryByContent('sys_dictionary_incident_null'), { table: 'sys_dictionary', query: 'name=incident^elementISEMPTY' })
  assert.deepEqual(queryByContent('sys_dictionary_incident_u_null'), { table: 'sys_dictionary', query: 'name=incident^element=u_null^NQname=incident_u^elementISEMPTY' })
  assert.deepEqual(queryByContent('sys_documentation_incident_category_en'), { table: 'sys_documentation', query: 'name=incident^element=category^language=en' })
  // The label of a table has an empty element, which leaves two underscores in the name.
  assert.deepEqual(queryByContent('sys_documentation_incident__en'), { table: 'sys_documentation', query: 'name=incident^elementISEMPTY^language=en' })
  // Each split is an exact pair of table and field: asked as two lists, "task" with "due" would come back as well.
  assert.deepEqual(queryByContent('sys_dictionary_task_sla_due'), { table: 'sys_dictionary', query: 'name=task^element=sla_due^NQname=task_sla^element=due' })
  // A name that ends in a sys_id belongs to a record with an id of its own, a dictionary override for one. A dictionary
  // entry is never named with nothing behind its table.
  for (const name of ['sys_script_0123456789abcdef0123456789abcdef', `sys_dictionary_override_${ID}`, 'sys_dictionary_incident', 'sys_dictionary_incident_', 'sys_dictionary_Incident_category', 'sys_documentation_incident', 'sys_dictionary_']) {
    assert.equal(queryByContent(name), null, name)
  }
})

test('sn_origin does not take an answer without a total for a complete one', async () => {
  // Access rules take rows off a page after it was cut. Without a total an empty page proves nothing.
  const blind = await connect([
    { table: 'sys_metadata', rows: [file('sys_plugins')] },
    { table: 'sys_update_xml', rows: [], noTotal: true },
    { table: 'sys_update_version', rows: [], noTotal: true },
    { table: 'upgrade_history_task', rows: [], noTotal: true },
  ])
  const data = await blind.answer('sn_origin', { sysId: ID })
  assert.deepEqual({ verdict: data.verdict, divergence: data.divergence, capturedBy: data.capturedBy }, { verdict: 'unknown', divergence: 'unknown', capturedBy: 'unknown' })
  assert.match(data.explanation, /came without a total/)

  // The same for a name nothing answers to: "not found" needs to know that nothing is recorded under it.
  const nothing = await connect([
    { table: 'sys_metadata', rows: [] },
    { table: 'sys_update_xml', rows: [], noTotal: true },
    { table: 'sys_update_version', rows: [], noTotal: true },
    { table: 'upgrade_history_task', rows: [], noTotal: true },
  ])
  const open = await nothing.answer('sn_origin', { updateName: `u_custom_${ID}` })
  assert.equal(open.verdict, 'unknown')
  assert.match(open.warnings.join(' '), /could not be established that nothing is recorded under it/)
})

test('sn_origin: "deleted" and "not found" are not said over rows it cannot see or use', async () => {
  // The newest update row is hidden. It can be the one that made the record again after the delete in view.
  const name = `u_custom_${ID}`
  const hiddenNewest = await connect([
    { table: 'sys_metadata', rows: [] },
    { table: 'sys_update_xml', rows: [null, change({ name, action: 'DELETE' })] },
    { table: 'sys_update_version', rows: [] },
    { table: 'upgrade_history_task', rows: [] },
  ])
  assert.equal((await hiddenNewest.answer('sn_origin', { updateName: name })).verdict, 'unknown')
  const visible = await connect([{ table: 'sys_metadata', rows: [] }, { table: 'sys_update_xml', rows: [change({ name, action: 'DELETE' })] }, { table: 'sys_update_version', rows: [] }, { table: 'upgrade_history_task', rows: [] }])
  assert.equal((await visible.answer('sn_origin', { updateName: name })).verdict, 'deleted_here')

  // A captured change ends in the sys_id, but its name does not come back.
  const nameless = await connect([{ table: 'sys_metadata', rows: [] }, { table: 'sys_update_xml', rows: [{ name: '' }] }])
  const data = await nameless.answer('sn_origin', { sysId: ID })
  assert.equal(data.verdict, 'unknown')
  assert.match(data.warnings.join(' '), /its name did not come back in a usable form/)
})

test('sn_origin: a version of a source it does not classify can be the vendor\'s', async () => {
  // Changed in 2026, created in 2020, in the global scope. One earlier version came without its source.
  const rows = [version('current', 'sys_update_set', '2026-03-01 10:00:00', 'abel'), version('previous', '', '2020-01-01 00:00:00')]
  const data = await (await connect(origin('sys_scope', [change()], rows))).answer('sn_origin', { sysId: ID })
  assert.deepEqual({ verdict: data.verdict, created: data.created }, { verdict: 'unknown', created: 'unknown' })
  assert.match(data.warnings.join(' '), /a source this tool does not classify: unknown\. One of them can be the vendor's/)
  // With every version classified, the same record is the customer's own.
  const clear = await (await connect(origin('sys_scope', [change()], [rows[0]]))).answer('sn_origin', { sysId: ID })
  assert.equal(clear.verdict, 'customer_created')

  // A package of a class without a rule is said to be that, not "no package".
  const odd = await (await connect(origin('sys_other_package', [], []))).answer('sn_origin', { sysId: ID })
  assert.equal(odd.verdict, 'unknown')
  assert.match(odd.explanation, /a package of a kind this tool has no rule for \(sys_other_package\)/)
})

test('sn_origin: a version from an update set is a capture, also where its update row is gone', async () => {
  // Made by a person in January in an update set that was deleted later, changed again in March.
  const rows = [version('current', 'sys_update_set', '2026-03-01 10:00:00', 'abel'), version('previous', 'sys_update_set', '2026-01-01 10:00:00', 'abel')]
  const data = await (await connect(origin('sys_store_app', [change()], rows, { sys_created_on: '2026-01-01 10:00:00', sys_created_by: 'abel' }))).answer('sn_origin', { sysId: ID })
  assert.deepEqual({ verdict: data.verdict, created: data.created, first: data.evidence.customerUpdates.firstCapturedOn }, { verdict: 'customer_created', created: 'here', first: '2026-01-01 10:00:00' })

  // No update row at all, and the current version from an update set: its author is who captured the change.
  const versionOnly = await (await connect(origin('sys_plugins', [], [version('current', 'sys_update_set', '2026-03-01 10:00:00', 'abel')]))).answer('sn_origin', { sysId: ID })
  assert.deepEqual({ divergence: versionOnly.divergence, capturedBy: versionOnly.capturedBy }, { divergence: 'customer_changes_captured', capturedBy: 'people' })
  const byJob = await (await connect(origin('sys_plugins', [], [version('current', 'sys_update_set', '2026-03-01 10:00:00', 'system')]))).answer('sn_origin', { sysId: ID })
  assert.equal(byJob.capturedBy, 'system_accounts')
})

test('sn_origin: what a row does not say is not read as an answer', async () => {
  // An update row without an author has no person on it: it counts as sn_delta counts it.
  const authorless = await (await connect(origin('sys_plugins', [change({ sys_created_by: '', sys_updated_by: '' })], []))).answer('sn_origin', { sysId: ID })
  assert.deepEqual({ divergence: authorless.divergence, capturedBy: authorless.capturedBy }, { divergence: 'customer_changes_captured', capturedBy: 'system_accounts' })
  // One row by a job and one by a person: a person captured a change.
  const job = { sys_created_by: 'system', sys_updated_by: 'system' }
  const mixed = await (await connect(origin('sys_plugins', [change(job), change({ sys_created_by: 'abel', sys_updated_by: 'abel' })], []))).answer('sn_origin', { sysId: ID })
  assert.equal(mixed.capturedBy, 'people')
  // An account is the same in whatever case it is written: the instance compares names that way.
  const upper = await (await connect(origin('sys_plugins', [change({ sys_created_by: 'System', sys_updated_by: 'GUEST' })], []))).answer('sn_origin', { sysId: ID })
  assert.equal(upper.capturedBy, 'system_accounts')

  // An earlier version from an update set and none marked current: whose content the record holds is not known.
  const noCurrent = await (await connect(origin('sys_plugins', [], [version('previous', 'sys_update_set', '2026-03-01 10:00:00', 'abel')]))).answer('sn_origin', { sysId: ID })
  assert.deepEqual({ verdict: noCurrent.verdict, divergence: noCurrent.divergence }, { verdict: 'unknown', divergence: 'unknown' })
  assert.match(noCurrent.warnings.join(' '), /no version is marked current/)
  assert.doesNotMatch(noCurrent.warnings.join(' '), /the current version is the vendor's/)

  // An entry of an upgrade that came back without what the upgrade did with the record.
  const blank = await (await connect(origin('sys_plugins', [], [], {}, [{ state: labelled('1', 'Not Reviewed'), sys_created_on: '2026-09-25 17:00:00' }]))).answer('sn_origin', { sysId: ID })
  assert.deepEqual({ verdict: blank.verdict, divergence: blank.divergence }, { verdict: 'unknown', divergence: 'unknown' })
  assert.match(blank.warnings.join(' '), /what the upgrade did with it did not come back/)
  // More entries than were read, none of which says that the record differs: that is not "hidden".
  const many = await (await connect(origin('sys_plugins', [], [], {}, Array.from({ length: 11 }, () => skip('Skipped Error'))))).answer('sn_origin', { sysId: ID })
  assert.match(many.warnings.join(' '), /more entries for this record than were read/)
  assert.doesNotMatch(many.warnings.join(' '), /cannot see/)
})

test('sn_origin: two records that spell the same name are not told apart by guessing', async () => {
  const entry = (name: string, element: string, id: string, packageClass: string) => ({ ...file(packageClass, { sys_id: id, sys_update_name: '', sys_class_name: 'sys_dictionary' }), name, element })
  const world = (rows: Data[]): Route[] => [{ table: 'sys_metadata', rows: [] }, { table: 'sys_dictionary', rows }, ...origin(null, [], []).slice(1)]
  const two = await connect(world([entry('task', 'sla_due', 'a'.repeat(32), 'sys_app'), entry('task_sla', 'due', 'b'.repeat(32), 'sys_plugins')]))
  const data = await two.answer('sn_origin', { updateName: 'sys_dictionary_task_sla_due' })
  assert.equal(data.verdict, 'unknown')
  assert.match(data.warnings.join(' '), /More than one record of sys_dictionary spells the name "sys_dictionary_task_sla_due" \(task with sla_due; task_sla with due\)\. Give the sys_id/)
  // A row that stores another update name is another record.
  const other = await connect(world([{ ...entry('task', 'sla_due', 'a'.repeat(32), 'sys_plugins'), sys_update_name: 'sys_dictionary_something_else' }]))
  assert.equal((await other.answer('sn_origin', { updateName: 'sys_dictionary_task_sla_due' })).verdict, 'not_found')
  // The update name of a dictionary override ends in a sys_id: it is not looked up as a dictionary entry.
  const override = await connect(world([]))
  await override.answer('sn_origin', { updateName: `sys_dictionary_override_${ID}` })
  assert.equal(override.sentTo('sys_dictionary').length, 0)
})

test('sn_origin: a record of an application customization is said to be one, and not judged', async () => {
  // Changes a customer made to an installed application are kept in a package of their own. No rule here fits it.
  const data = await (await connect(origin('sys_app_customization', [change()], [version('current', 'sys_update_set', '2026-03-01 10:00:00', 'abel')]))).answer('sn_origin', { sysId: ID })
  assert.equal(data.verdict, 'unknown')
  assert.match(data.explanation, /application customization \(sys_app_customization\)/)
})

test('sn_origin: what an upgrade entry means is decided by the codes the instance lists', async () => {
  const codes: Route = {
    table: 'sys_choice',
    query: 'elementINdisposition,state',
    rows: [
      { name: 'sys_upgrade_history_log', element: 'disposition', value: '4', label: 'Skipped' },
      { name: 'sys_upgrade_history_log', element: 'disposition', value: '9', label: 'Skipped Error' },
      { name: 'upgrade_history_task', element: 'state', value: '5', label: 'Reviewed and Reverted' },
      { name: 'upgrade_history_task', element: 'state', value: '7', label: 'Reviewed, Not Reverted' },
      { name: 'upgrade_history_task', element: 'state', value: '8', label: 'Revert Failed' },
    ],
  }
  const judged = async (row: Data) => (await (await connect([codes, ...origin('sys_plugins', [], [], {}, [row])])).answer('sn_origin', { sysId: ID })).verdict
  // A file the upgrade could not apply is a failure and no local change, also where the instance names its codes itself.
  assert.equal(await judged(skip('Skipped Error')), 'out_of_box_as_captured')
  assert.equal(await judged(skip('Skipped')), 'customized')
  // Reverted is what says so, and nothing that says it did not happen.
  assert.equal(await judged({ ...skip('Skipped'), state: labelled('5', 'Reviewed and Reverted') }), 'out_of_box_as_captured')
  assert.equal(await judged({ ...skip('Skipped'), state: labelled('7', 'Reviewed, Not Reverted') }), 'customized')
  assert.equal(await judged({ ...skip('Skipped'), state: labelled('8', 'Revert Failed') }), 'customized')
})

test('sn_origin sends no request whose answer it would not use', async () => {
  // A record this account may not read: nothing can be checked, so nothing is looked up.
  const hidden = await connect([{ table: 'sys_metadata', rows: [null] }, ...origin(null, [change()], []).slice(1)])
  const data = await hidden.answer('sn_origin', { updateName: NAME })
  assert.equal(data.verdict, 'unknown')
  assert.equal(hidden.calls.length, 1)

  // The codes of upgrade entries decide only where no change is captured.
  const changed = await connect([{ table: 'sys_choice', rows: [] }, ...origin('sys_plugins', [change()], [], {}, [skip('Skipped Manual Merge')])])
  await changed.answer('sn_origin', { sysId: ID })
  assert.equal(changed.sentTo('sys_choice').length, 0)

  // The company code is asked for only where a scope can carry it, and a failure to read it is not remembered.
  const vendorApp = await connect([{ table: 'sys_properties', rows: [] }, ...origin('sys_store_app', [], [], { 'sys_scope.scope': 'sn_hr_core' })])
  await vendorApp.answer('sn_origin', { sysId: ID })
  assert.equal(vendorApp.sentTo('sys_properties').length, 0)

  let failures = 1
  const flaky = await connect([...origin('sys_store_app', [], [], { 'sys_scope.scope': 'x_acme_claims' })])
  const first = await flaky.answer('sn_origin', { sysId: ID })
  assert.equal(first.provenance, 'installed_application')
  assert.match(first.warnings.join(' '), /The company code of this instance could not be read/)
  assert.equal(flaky.sentTo('sys_properties').length, failures)
  await flaky.answer('sn_origin', { sysId: ID })
  assert.equal(flaky.sentTo('sys_properties').length, ++failures, 'asked again, not answered from a remembered failure')
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
  // The rows that were left out are still counted, under the conditions as given: one call answers both.
  assert.equal(people.sentTo('sys_update_xml').at(-1)!.query, 'type=Report^sys_created_byINsystem,guest^ORsys_created_byLIKE@snc.^ORsys_created_byISEMPTY^sys_updated_byINsystem,guest^ORsys_updated_byLIKE@snc.^ORsys_updated_byISEMPTY')
  assert.equal(data.capturedBySystemAccounts, 1)
  assert.match(data.warnings.join(' '), /1 more row\(s\) under the same conditions have no person on them.*left out by peopleOnly/)

  // "since" takes a day or a moment, in the forms a query takes them.
  for (const [given, sent] of [['2026-11-01', '2026-11-01 00:00:00'], ['2026-11-01 08:30:00', '2026-11-01 08:30:00'], ['2026-11-01T08:30:00Z', '2026-11-01 08:30:00'], ['2026-11-01 08:30', '2026-11-01 08:30:00']]) {
    const dated = await connect([{ table: 'sys_update_xml', rows: [] }, stats('sys_update_xml', {})])
    await dated.answer('sn_delta', { since: given })
    assert.equal(dated.sentTo('sys_update_xml')[0].query, `sys_updated_on>=${sent}^ORDERBYDESCsys_updated_on`, given)
  }

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
    { table: 'sys_app', rows: [{ name: 'Example claims', scope: 'x_acme_claims', version: '1.2.0', active: 'true' }] },
  ])
  const data = await answer('sn_plugins', { filter: 'example' })
  // Applications developed on the instance are rows of another table, listed apart.
  assert.deepEqual({ table: data.customApps.table, scope: data.customApps.items[0].scope, query: data.customApps.query }, { table: 'sys_app', scope: 'x_acme_claims', query: 'nameLIKEexample^ORscopeLIKEexample^active=true' })
  assert.deepEqual(data.warnings, [])

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
  const routes = upgradeRoutes
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

test('sn_upgrade_skips says who captured the changes to each skipped record, and can leave out failures', async () => {
  const entry = (file: string, disposition: string) => ({
    'upgrade_detail.file_name': file,
    'upgrade_detail.target_name': 'Example',
    'upgrade_detail.type': 'Business Rule',
    'upgrade_detail.disposition': labelled(DISPOSITION_CODES[disposition], disposition),
    'upgrade_detail.upgrade_history.to_version': 'glide-australia-02-11-2026__patch1.zip',
    state: labelled('1', 'Not Reviewed'),
    sys_created_on: '2026-09-25 17:00:00',
  })
  const routes: Route[] = [
    { table: 'upgrade_history_task', rows: [entry('sys_script_1', 'Skipped'), entry('sys_script_2', 'Skipped Manual Merge'), entry('sys_properties_3', 'Skipped')] },
    // Rows a person is on, asked for only for the names that have rows at all.
    stats('sys_update_xml', { sys_script_1: 1 }, 'sys_created_byNOT IN', 'name'),
    stats('sys_update_xml', { sys_script_1: 2, sys_script_2: 1 }, undefined, 'name'),
    ...upgradeRoutes.filter((route) => !(route.table === 'upgrade_history_task' && (route.api ?? 'table') === 'table')),
  ]
  const { answer, sentTo } = await connect(routes)
  const data = await answer('sn_upgrade_skips', {})
  assert.deepEqual(data.records.map((row: Data) => `${row.file}: ${row.capturedBy}`), ['sys_script_1: people', 'sys_script_2: system_accounts', 'sys_properties_3: nobody'])
  assert.deepEqual(data.capturedBy, { people: 1, system_accounts: 1, nobody: 1 })
  const asked = sentTo('sys_update_xml', 'stats').map((call) => call.query)
  assert.equal(asked[0], 'nameINsys_script_1,sys_script_2,sys_properties_3')
  assert.match(asked[1], /^nameINsys_script_1,sys_script_2\^sys_created_byNOT INsystem,guest/)
  assert.equal(asked.length, 2)

  // A file the upgrade could not apply is a failure, not a customization: left out on request, by its stored code.
  await answer('sn_upgrade_skips', { excludeErrors: true })
  assert.equal(sentTo('upgrade_history_task').at(-1)!.query, `upgrade_detail.upgrade_history=${UP.family}^upgrade_detail.dispositionIN4,10^ORDERBYDESCsys_created_on`)
  await answer('sn_upgrade_skips', { excludeErrors: true, onlySkipped: false })
  // Measured: "NOT IN" leaves out the rows where the field is empty. An entry without a disposition is no failure.
  assert.equal(sentTo('upgrade_history_task').at(-1)!.query, `upgrade_detail.upgrade_history=${UP.family}^upgrade_detail.dispositionNOT IN9^ORupgrade_detail.dispositionISEMPTY^ORDERBYDESCsys_created_on`)
  // Where the instance does not list its codes, a built-in list says what a failure is, and the answer says so.
  const noCodes = await connect(routes.filter((route) => route.table !== 'sys_choice'))
  assert.match((await noCodes.answer('sn_upgrade_skips', { excludeErrors: true, onlySkipped: false })).warnings.join(' '), /built-in list was used to find the files an upgrade could not apply/)
  // Every "skipped" a failure: then the two inputs together ask for nothing, and that is said instead of sent.
  const onlyFailures = await connect([{ table: 'sys_choice', query: 'element=disposition', rows: [{ value: '9', label: 'Skipped Error' }, { value: '2', label: 'Updated' }] }, ...routes])
  const nothing = await onlyFailures.call('sn_upgrade_skips', { excludeErrors: true })
  assert.equal(nothing.data.error, 'validation')
  assert.match(nothing.data.message, /leaves nothing to ask for/)
  assert.equal(onlyFailures.sentTo('upgrade_history_task').length, 0)

  // Where the captured changes cannot be read, the entries carry no answer to "who", and the answer says so.
  const blind = await connect([{ table: 'sys_update_xml', api: 'stats', status: 403 }, ...routes.filter((route) => route.table !== 'sys_update_xml')])
  const unsure = await blind.answer('sn_upgrade_skips', {})
  assert.equal(unsure.records[0].capturedBy, undefined)
  assert.match(unsure.warnings.join(' '), /Who captured the changes to these records could not be read \(sys_update_xml: acl\)/)
})

test('who captured a list of records is asked for in batches, and the second question only where there is something', async () => {
  const names = Array.from({ length: 120 }, (_, index) => `sys_script_${String(index).padStart(32, '0')}`)
  const groups = (list: string[]) => Object.fromEntries(list.map((name) => [name, 1]))
  const { sn, calls } = fakeInstance([
    // A person is on the rows of the first ten records. Sixty records have rows at all.
    stats('sys_update_xml', groups(names.slice(0, 10)), 'sys_created_byNOT IN', 'name'),
    stats('sys_update_xml', groups(names.slice(0, 60)), undefined, 'name'),
  ])
  const known = await capturedByName(createContext(sn), [...names, names[0], 'not a name^ORx=1'])

  assert.deepEqual([known.get(names[0]), known.get(names[10]), known.get(names[60]), known.size], ['people', 'system_accounts', 'nobody', 120])
  const queries = calls.map((call) => call.query)
  const first = queries.filter((query) => !query.includes('NOT IN'))
  const second = queries.filter((query) => query.includes('NOT IN'))
  // 120 names in batches of at most 50, then the 60 that have rows in batches of at most 25.
  assert.deepEqual([first.length, second.length], [3, 3])
  assert.ok(queries.every((query) => query.length < 4_500), 'no query outgrows a request')
  // A name that could change the query it is put into is never sent.
  assert.ok(queries.every((query) => !query.includes('ORx=1')))

  // A failure leaves the names it concerns without an answer, and says so once.
  const kinds: string[] = []
  const failing = fakeInstance([{ table: 'sys_update_xml', api: 'stats', status: 403 }])
  const none = await capturedByName(createContext(failing.sn), names.slice(0, 3), (kind) => kinds.push(kind))
  assert.deepEqual([none.size, kinds], [0, ['acl']])
})

test('sn_upgrade_skips counts each thing under the right filter', async () => {
  const { answer, sentTo } = await connect(upgradeRoutes)
  await answer('sn_upgrade_skips', { fileContains: 'sys_script', unreviewedOnly: true })
  const asked = Object.fromEntries(sentTo('upgrade_history_task', 'stats').map((entry) => [entry.params.get('sysparm_group_by'), entry.query]))
  const shared = 'upgrade_detail.dispositionIN4,9,10^upgrade_detail.file_nameLIKEsys_script^stateIN1'

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
  assert.equal(sentTo('upgrade_history_task').at(-1)?.query, 'upgrade_detail.upgrade_history.to_versionLIKEzurich^upgrade_detail.file_nameLIKEsys_script^stateIN1^ORDERBYDESCsys_created_on')
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

test('sn_dependencies asks each category with the query that was measured for it', async () => {
  // What applies to a child table differs from one kind of record to the next: always, never, or only with a flag
  // on the record. Each of these was measured on an instance. A changed word here changes an answer without a sign.
  const tables = ['sys_script', 'sys_script_client', 'sys_ui_policy', 'sys_ui_action', 'sys_declarative_action_assignment', 'sys_data_policy2', 'sys_security_acl', 'sys_security_data_filter', 'sysevent_email_action', 'sysevent_in_email_action', 'contract_sla', 'sysrule_assignment', 'dl_definition', 'sys_transform_map', 'sc_cat_item_producer', 'sys_flow_record_trigger', 'wf_workflow_version', 'sys_relationship', 'sys_db_view_table', 'sys_dictionary_override', 'sys_ui_policy_action', 'sys_data_policy_rule', 'sys_choice', 'sys_ui_element', 'sys_ui_list_element']
  const { answer } = await connect([...dictionaryRoutes, ...tables.flatMap((table): Route[] => [{ table, rows: [] }, { table, api: 'stats', rows: [] }])])
  const queries = async (args: Data) => Object.fromEntries(Object.entries((await answer('sn_dependencies', args)).categories as Record<string, Data>).map(([key, category]) => [key, `${category.table}: ${category.query}`]))

  assert.deepEqual(await queries({ table: 'incident' }), {
    businessRules: 'sys_script: collectionINincident,task^active=true',
    clientScripts: 'sys_script_client: table=incident^active=true^NQtableINtask^applies_extended=true^active=true',
    uiPolicies: 'sys_ui_policy: table=incident^active=true^NQtableINtask^inherit=true^active=true',
    uiActions: 'sys_ui_action: tableINincident,task^active=true',
    declarativeActions: 'sys_declarative_action_assignment: tableINincident,task^active=true',
    dataPolicies: 'sys_data_policy2: model_table=incident^active=true^NQmodel_tableINtask^inherit=true^active=true',
    accessControls: 'sys_security_acl: nameINincident,task^ORnameSTARTSWITHincident.^ORnameSTARTSWITHtask.^active=true',
    dataFilters: 'sys_security_data_filter: table_nameINincident,task^active=true',
    notifications: 'sysevent_email_action: collectionINincident,task^active=true',
    inboundEmailActions: 'sysevent_in_email_action: table=incident^active=true',
    slaDefinitions: 'contract_sla: collectionINincident,task^active=true',
    assignmentRules: 'sysrule_assignment: tableINincident,task^active=true',
    dataLookups: 'dl_definition: source_tableINincident,task^active=true',
    transformMaps: 'sys_transform_map: target_table=incident^active=true',
    recordProducers: 'sc_cat_item_producer: table_name=incident^active=true',
    flowRecordTriggers: 'sys_flow_record_trigger: table=incident^active=true^NQtableINtask^run_on_extended=true^active=true',
    // Only the published version of a workflow runs, whether or not inactive ones are asked for.
    workflows: 'wf_workflow_version: tableINincident,task^active=true^published=true',
    relatedLists: 'sys_relationship: basic_apply_toINincident,task',
    databaseViews: 'sys_db_view_table: table=incident^active=true',
    dictionaryOverrides: 'sys_dictionary_override: nameINincident,task',
    referencedBy: 'sys_dictionary: reference=incident^internal_typeINreference,glide_list^active=true',
  })

  const all = await queries({ table: 'incident', activeOnly: false })
  assert.equal(all.clientScripts, 'sys_script_client: table=incident^NQtableINtask^applies_extended=true')
  assert.equal(all.workflows, 'wf_workflow_version: tableINincident,task^published=true')
  assert.equal(all.accessControls, 'sys_security_acl: nameINincident,task^ORnameSTARTSWITHincident.^ORnameSTARTSWITHtask.')

  assert.deepEqual(await queries({ table: 'incident', field: 'state' }), {
    // An action or a rule of a parent table applies only where its policy is marked to be inherited.
    uiPolicyActions: 'sys_ui_policy_action: table=incident^field=state^ui_policy.active=true^NQtableINtask^ui_policy.inherit=true^field=state^ui_policy.active=true',
    clientScripts: 'sys_script_client: table=incident^field=state^active=true^NQtableINtask^applies_extended=true^field=state^active=true',
    dataPolicyRules: 'sys_data_policy_rule: table=incident^field=state^sys_data_policy.active=true^NQtableINtask^sys_data_policy.inherit=true^field=state^sys_data_policy.active=true',
    accessControls: 'sys_security_acl: nameINincident.state,task.state^active=true',
    dictionaryOverrides: 'sys_dictionary_override: nameINincident,task^element=state',
    // One label per choice, the English one, and only the choices that are in use.
    choices: 'sys_choice: nameINincident,task^element=state^inactive=false^language=en',
    formSections: 'sys_ui_element: sys_ui_section.nameINincident,task^element=state',
    listLayouts: 'sys_ui_list_element: list_id.nameINincident,task^element=state',
    dependentFields: 'sys_dictionary: nameINincident,task^dependent_on_field=state^active=true',
  })

  // Without the parent tables, nothing of a parent is asked for.
  const own = await queries({ table: 'incident', includeParents: false })
  assert.equal(Object.values(own).filter((query) => query.includes('task')).length, 0)
})

test('sn_dependencies lists what is attached, with the query behind every category', async () => {
  // Nine levels below a table is as deep as its child tables are counted.
  const NINTH = `${'super_class.'.repeat(9)}name=incident`
  const { answer, sentTo } = await connect([
    { table: 'sys_db_object', exact: NINTH, rows: [] },
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
  // A captured change exists, and a person is on it. Who captured it is asked only for the items that have one.
  assert.deepEqual({ customerUpdate: rules.items[1].customerUpdate, capturedBy: rules.items[1].capturedBy }, { customerUpdate: true, capturedBy: 'people' })
  // A client script of a parent table applies only if it is marked as inherited.
  assert.equal(data.categories.clientScripts.query, 'table=incident^active=true^NQtableINtask^applies_extended=true^active=true')
  assert.deepEqual(data.categories.accessControls.items[0], { name: 'incident.number', sysId: 'acl1', definedOn: 'incident', active: true, customerUpdate: false, details: { operation: 'read', type: 'record', decision_type: 'Allow If' } })
  assert.deepEqual(data.childTables, { direct: 1, descendants: 3, names: ['incident_child'], truncated: false })
  // Counted through every level: measured, 95 of the 1,348 tables below one table were more than five levels down.
  assert.ok(sentTo('sys_db_object').some((sent) => sent.query.endsWith(`^OR${NINTH}`)))
  assert.doesNotMatch(data.warnings.join(' '), /levels below it/)
  // Where a table sits at the ninth level, there can be more below it, and the count says so.
  const deep = await connect([
    { table: 'sys_db_object', exact: NINTH, rows: [{ sys_id: 'y' }] },
    { table: 'sys_db_object', query: 'super_class.name=incident^ORsuper_class', rows: [{ sys_id: 'x' }], total: 3 },
    { table: 'sys_db_object', query: 'super_class.name=incident', rows: [{ name: 'incident_child' }] },
    ...dictionaryRoutes,
  ])
  assert.match((await deep.answer('sn_dependencies', { table: 'incident', categories: ['businessRules'] })).warnings.join(' '), /Tables extend "incident" 9 levels below it.*"descendants" does not count them/)
  assert.ok(data.notCovered.length > 0)
  assert.equal(sentTo('sys_update_xml', 'stats').length, 2, 'one grouped lookup for all items, one for who is on the captured ones')
  assert.equal(sentTo('sys_update_xml', 'stats')[0].query, 'nameINsys_script_a1,sys_script_a2,sys_script_client_c1,sys_security_acl_acl1')
  assert.match(sentTo('sys_update_xml', 'stats')[1].query, /^nameINsys_script_a2\^sys_created_byNOT INsystem,guest/)
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
  assert.equal(query('workflows'), 'tableINincident,task^active=true^published=true')
  // The fields that point at the table itself. A field that points at task can hold any task: that is the parent's list.
  assert.equal(query('referencedBy'), 'reference=incident^internal_typeINreference,glide_list^active=true')
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
  assert.equal(lookups.filter((query) => !query.includes('NOT IN')).length, 2, '51 names in chunks of 50')
  assert.equal(lookups.filter((query) => query.includes('NOT IN')).length, 1, 'the two captured ones in one more')
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
    { table: 'sys_choice', api: 'stats', rows: [{ stats: { count: '7' }, groupby_fields: [{ value: 'incident' }] }] },
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

test('sn_dependencies with a field: the choices of the nearest table count, and captured changes are flagged', async () => {
  // Measured: the choices of a field are captured together under "sys_choice_<table>_<field>", a form section under
  // "sys_ui_section_<sys_id>". Neither a choice nor a form element carries an update name of its own.
  const section = 'c'.repeat(32)
  const { answer, sentTo } = await connect([
    { table: 'sys_choice', api: 'stats', rows: [{ stats: { count: '6' }, groupby_fields: [{ value: 'incident' }] }, { stats: { count: '4' }, groupby_fields: [{ value: 'task' }] }] },
    { table: 'sys_choice', query: 'nameINincident^element=state', rows: [{ sys_id: 'c1', name: 'incident', element: 'state', label: 'New', value: '1', inactive: 'false', language: 'en' }], total: 6 },
    { table: 'sys_ui_element', rows: [{ sys_id: 'e1', element: 'state', sys_ui_section: section, 'sys_ui_section.name': 'incident', 'sys_ui_section.view_name': '', 'sys_ui_section.caption': '' }] },
    { table: 'sys_update_xml', api: 'stats', rows: [{ stats: { count: '2' }, groupby_fields: [{ value: 'sys_choice_incident_state' }] }, { stats: { count: '1' }, groupby_fields: [{ value: `sys_ui_section_${section}` }] }] },
    ...dictionaryRoutes,
  ])
  const data = await answer('sn_dependencies', { table: 'incident', field: 'state', categories: ['choices', 'formSections'] })

  // incident has choices of its own for the field: those of task are not used on incident.
  assert.equal(data.categories.choices.query, 'nameINincident^element=state^inactive=false^language=en')
  assert.equal(data.categories.choices.total, 6)
  assert.deepEqual(data.categories.choices.items[0], { name: 'New', sysId: 'c1', definedOn: 'incident', customerUpdate: true, capturedBy: 'people', details: { value: '1' } })
  assert.equal(data.categories.formSections.items[0].customerUpdate, true)
  assert.match(sentTo('sys_update_xml', 'stats')[0].query, new RegExp(`^nameIN(sys_choice_incident_state,sys_ui_section_${section}|sys_ui_section_${section},sys_choice_incident_state)$`))

  // Every choice, inactive ones included: still one label per choice, the English one.
  const all = await answer('sn_dependencies', { table: 'incident', field: 'state', categories: ['choices'], activeOnly: false })
  assert.equal(all.categories.choices.query, 'nameINincident^element=state^language=en')

  // Where it cannot be counted which table the choices belong to, those of the parent are not listed beside those
  // of the table as if both applied.
  const uncounted = await connect([
    { table: 'sys_choice', api: 'stats', status: 403 },
    { table: 'sys_choice', query: 'element=state', rows: [{ sys_id: 'c1', name: 'incident', element: 'state', label: 'New', value: '1' }, { sys_id: 'c2', name: 'task', element: 'state', label: 'Open', value: '1' }] },
    ...dictionaryRoutes,
  ])
  const unsure = await uncounted.answer('sn_dependencies', { table: 'incident', field: 'state', categories: ['choices'] })
  assert.equal(unsure.categories.choices.status, 'not_checked')
  assert.match(unsure.categories.choices.reason, /could not be counted which table of incident, task the items belong to \(sys_choice: acl\)/)

  // A form element whose section did not come back has no name to look a captured change up by: no flag is made up.
  const sectionless = await connect([
    { table: 'sys_ui_element', rows: [{ sys_id: 'e1', element: 'state', 'sys_ui_section.name': 'incident', 'sys_ui_section.view_name': '', 'sys_ui_section.caption': '' }] },
    stats('sys_update_xml', {}),
    ...dictionaryRoutes,
  ])
  const bare = await sectionless.answer('sn_dependencies', { table: 'incident', field: 'state', categories: ['formSections'] })
  assert.equal('customerUpdate' in bare.categories.formSections.items[0], false)
  assert.equal(sectionless.sentTo('sys_update_xml', 'stats').length, 0)
})

test('sn_dependencies does not take an empty answer for "none" on an instance that answers unusable queries with nothing', async () => {
  // A hardened instance: glide.invalid_query.returns_no_rows is on. A condition on a field this release does not
  // have then gives no rows, where it would otherwise give all of them and so betray itself.
  const hardened: Route[] = [
    { table: 'sys_properties', query: 'name=glide.invalid_query.returns_no_rows', rows: [{ name: 'glide.invalid_query.returns_no_rows', value: 'true' }] },
    { table: 'sys_db_object', query: 'name=sys_script_client', rows: [tableRow('sys_script_client', 'Client Script')] },
    { table: 'sys_dictionary', query: 'nameINsys_script_client', rows: [column('sys_script_client', 'table'), column('sys_script_client', 'active', 'boolean')] },
    { table: 'sys_db_object', query: 'name=sys_script', rows: [tableRow('sys_script', 'Business Rule')] },
    { table: 'sys_dictionary', query: 'nameINsys_script', rows: [column('sys_script', 'collection'), column('sys_script', 'active', 'boolean')] },
    { table: 'sys_script_client', rows: [] },
    { table: 'sys_script', rows: [] },
    ...dictionaryRoutes,
  ]
  const { answer } = await connect(hardened)
  const data = await answer('sn_dependencies', { table: 'incident', categories: ['clientScripts', 'businessRules'] })
  // The flag that passes a client script down to child tables is not a field here: the zero says nothing.
  assert.equal(data.categories.clientScripts.status, 'not_checked')
  assert.match(data.categories.clientScripts.reason, /has no field applies_extended on this instance, and this instance answers a query it cannot use with no rows/)
  // Every field of this condition exists: here the zero is a zero.
  assert.deepEqual({ status: data.categories.businessRules.status, total: data.categories.businessRules.total }, { status: 'checked', total: 0 })

  // The usual instance drops such a condition and answers with every row: an empty answer there was understood.
  const usual = await connect(hardened.slice(1))
  assert.equal((await usual.answer('sn_dependencies', { table: 'incident', categories: ['clientScripts'] })).categories.clientScripts.status, 'checked')
})

test('sn_dependencies says so when some rows of a category are hidden', async () => {
  const rule = { sys_id: 'r1', sys_name: 'Example rule', sys_update_name: 'sys_script_r1', collection: 'incident', active: 'true' }
  const { answer } = await connect([{ table: 'sys_script', rows: [rule, null, null] }, stats('sys_update_xml', {}), ...dictionaryRoutes])
  const data = await answer('sn_dependencies', { table: 'incident', categories: ['businessRules'] })
  assert.deepEqual({ total: data.categories.businessRules.total, returned: data.categories.businessRules.returned }, { total: 3, returned: 1 })
  assert.match(data.categories.businessRules.reason, /2 matching row\(s\) are hidden from this account/)
  assert.match(data.warnings.join(' '), /Rows are hidden from this account in: businessRules/)
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
    { table: 'sys_user_has_role', rows: [{ 'role.name': 'admin', 'user.user_name': 'reader' }, { 'role.name': 'itil', 'user.user_name': 'reader' }] },
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

test('applications are not read through their parent table where their own table is closed on this machine', async () => {
  const known = ['v_plugin', 'sys_scope', 'sys_app'].map((name): Route => ({ table: 'sys_db_object', exact: `name=${name}`, rows: [tableRow(name, name)] }))
  const world: Route[] = [
    closedTables(tableRow('sys_store_app', 'Store application', 'sys_scope', 'sys_package')),
    ...known,
    ...dictionaryRoutes,
    { table: 'v_plugin', rows: [{ id: 'com.snc.incident', name: 'Incident', active: 'active', version: '1.0' }] },
    { table: 'sys_scope', rows: [{ name: 'Example application', scope: 'sn_example', version: '1.0', active: 'true' }] },
  ]
  const { answer, sentTo } = await connect(world, { tables: { allow: [], deny: ['sys_store_app'] } })
  const data = await answer('sn_plugins')
  assert.equal(data.plugins.returned, 1)
  assert.equal(data.storeApps.table, null)
  assert.match(data.warnings.join(' '), /Installed applications could not be read: sys_store_app is closed on this machine.*not "none installed"/)
  assert.equal(sentTo('sys_scope').length, 0)

  // Where the instance does not hand the table out and nothing is closed here, the parent table is the way to them.
  const viaParent = await connect([{ table: 'sys_store_app', status: 403 }, ...world.slice(1)])
  assert.equal((await viaParent.answer('sn_plugins')).storeApps.table, 'sys_scope')
})

test('sn_instance: an account that is no administrator and has no read-only role is named as such', async () => {
  const routes = sourceTables.filter((table) => table !== 'sys_user_has_role').map((table) => ({ table, rows: [{ sys_id: '1' }] }))
  const { answer } = await connect([{ table: 'sys_user_has_role', rows: [{ 'role.name': 'itil', 'user.user_name': 'reader' }] }, ...routes])
  const data = await answer('sn_instance')
  assert.deepEqual(data.account, { roles: 1, admin: false, readOnlyRole: false })
  // The account says it. A warning is for what limits the answer, and this does not: only an administrator without
  // the role is named there, because the instance would take a write from that account.
  assert.doesNotMatch(data.warnings.join(' '), /snc_read_only/)

  // The look-up checks itself: rows of another user mean that the condition on the user was not applied.
  const other = await connect([{ table: 'sys_user_has_role', rows: [{ 'role.name': 'admin', 'user.user_name': 'somebody.else' }] }, ...routes])
  assert.equal((await other.answer('sn_instance')).account, null)
})

test('sn_instance does not look the account up through the user table when that table is closed', async () => {
  const routes = sourceTables.map((table) => ({ table, rows: [{ sys_id: '1', 'role.name': 'admin', 'user.user_name': 'reader' }] }))
  const { answer, sentTo } = await connect(routes, { tables: { allow: [], deny: ['sys_user'] } })
  assert.equal((await answer('sn_instance')).account, null)
  assert.equal(sentTo('sys_user_has_role').some((entry) => entry.query.includes('user.user_name')), false)
})

test('sn_instance counts the business rules that run on every read of every table', async () => {
  const { answer } = await connect([
    { table: 'sys_script', query: 'collection=global^action_query=true', rows: [{ sys_id: 'r1', action_query: 'true' }] },
    ...sourceTables.map((table) => ({ table, rows: [{ sys_id: '1' }] })),
  ])
  const data = await answer('sn_instance')
  assert.equal(data.queryRulesOnEveryTable, 1)
  assert.match(data.warnings.join(' '), /1 business rule runs on every read of every table.*sys_script, collection=global\^action_query=true\^active=true/)
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
  // This instance has no readable sys_script: how many rules run on every table is then not known, which is not "none".
  assert.equal(data.queryRulesOnEveryTable, null)
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
  // No role row at all for an account that reads these tables: the lookup through the user table did not work.
  assert.equal((await none.answer('sn_instance')).account, null)

  // One name is visible, one is hidden: the hidden one could be "admin", so nothing is claimed.
  const some = await connect([{ table: 'sys_user_has_role', rows: [{ 'role.name': 'snc_read_only', 'user.user_name': 'reader' }, { 'role.name': '', 'user.user_name': 'reader' }] }, ...sourceTables.filter((table) => table !== 'sys_user_has_role').map((table) => ({ table, rows: [{ sys_id: '1' }] }))])
  assert.equal((await some.answer('sn_instance')).account, null)
})

test('sn_instance with a token does not guess the account, and stays quiet about a read-only one', async () => {
  const routes = sourceTables.filter((table) => table !== 'sys_user_has_role').map((table) => ({ table, rows: [{ sys_id: '1' }] }))
  const token = await connect([{ table: 'sys_user_has_role', rows: [{ 'role.name': 'admin', 'user.user_name': 'reader' }] }, ...routes], { auth: { kind: 'bearer', token: 'abc' } })
  assert.equal((await token.answer('sn_instance')).account, null)
  assert.equal(token.sentTo('sys_user_has_role').filter((entry) => entry.query.includes('user.user_name')).length, 0)

  const readOnly = await connect([
    { table: 'sys_user_has_role', rows: [{ 'role.name': 'snc_read_only', 'user.user_name': 'reader' }] },
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
    { table: 'sys_user_has_role', rows: [{ 'role.name': 'snc_read_only', 'user.user_name': 'reader' }] },
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
