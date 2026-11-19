import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Dictionary } from '../src/dictionary.js'
import { dictionaryRoutes, fakeInstance } from './fake.js'

test('a table knows its parents', async () => {
  const { sn } = fakeInstance(dictionaryRoutes)
  const info = await new Dictionary(sn).table('incident')
  assert.deepEqual(info, { name: 'incident', label: 'Incident', chain: ['incident', 'task'] })
  assert.equal(await new Dictionary(sn).table('no_such_table'), null)
})

test('fields are inherited and say where they are defined', async () => {
  const { sn } = fakeInstance(dictionaryRoutes)
  const columns = await new Dictionary(sn).columns('incident')
  assert.equal(columns?.get('short_description')?.definedOn, 'task')
  assert.equal(columns?.get('caller_id')?.definedOn, 'incident')
  assert.equal(columns?.get('caller_id')?.reference, 'sys_user')
})

test('an unknown field is found, with suggestions', async () => {
  const { sn } = fakeInstance(dictionaryRoutes)
  const check = await new Dictionary(sn).checkFields('incident', ['short_descripton', 'active'])
  assert.equal(check.status, 'checked')
  assert.equal(check.unknown.length, 1)
  assert.equal(check.unknown[0].field, 'short_descripton')
  assert.ok(check.unknown[0].suggestions.includes('short_description'))
})

test('dot-walks are followed through reference fields only', async () => {
  const { sn } = fakeInstance(dictionaryRoutes)
  const dict = new Dictionary(sn)
  assert.deepEqual((await dict.checkFields('incident', ['caller_id.email', 'assigned_to.name'])).unknown, [])
  assert.match((await dict.checkFields('incident', ['caller_id.phone'])).unknown[0].reason, /not a field of "sys_user"/)
  assert.match((await dict.checkFields('incident', ['category.name'])).unknown[0].reason, /not a reference field/)
})

test('a table without dictionary cannot be checked, and says so', async () => {
  const { sn } = fakeInstance(dictionaryRoutes)
  const check = await new Dictionary(sn).checkFields('v_virtual', ['anything'])
  assert.equal(check.status, 'unavailable')
  assert.deepEqual(check.unknown, [])
})

test('an unreadable dictionary cannot be checked, and says so', async () => {
  const { sn } = fakeInstance([{ table: 'sys_db_object', status: 403 }])
  assert.equal((await new Dictionary(sn).checkFields('incident', ['active'])).status, 'unavailable')
})

test('the dictionary is read once per table', async () => {
  const { sn, calls } = fakeInstance(dictionaryRoutes)
  const dict = new Dictionary(sn)
  await dict.checkFields('incident', ['active'])
  const after = calls.length
  await dict.checkFields('incident', ['number', 'category'])
  assert.equal(calls.length, after)
})

test('dictionary overrides change the effective field', async () => {
  const { sn } = fakeInstance([
    ...dictionaryRoutes,
    { table: 'sys_dictionary_override', rows: [{ name: 'incident', element: 'short_description', mandatory_override: 'true', mandatory: 'true' }] },
  ])
  const effective = await new Dictionary(sn).effectiveColumns('incident')
  const field = effective?.columns.find((column) => column.name === 'short_description')
  assert.equal(field?.mandatory, true)
  assert.equal(field?.overriddenOn, 'incident')
  assert.deepEqual(field?.overrides, ['mandatory'])
  assert.equal(effective?.overridesRead, true)
})
