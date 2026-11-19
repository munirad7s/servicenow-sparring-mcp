import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ServiceNowError } from '../src/errors.js'
import { assertPlainValue, assertSysId, assertTableName, fieldsInEncodedQuery } from '../src/query.js'

const refused = (run: () => unknown) =>
  assert.throws(run, (error: unknown) => error instanceof ServiceNowError && error.kind === 'validation')

test('finds every field in a query, including sort fields, dot-walks and compared fields', () => {
  assert.deepEqual(fieldsInEncodedQuery('active=true^priorityIN1,2^ORstate!=6^NQcaller_id.emailLIKEexample^ORDERBYDESCsys_created_on'), [
    'active',
    'priority',
    'state',
    'caller_id.email',
    'sys_created_on',
  ])
  assert.deepEqual(fieldsInEncodedQuery('opened_atSAMEASclosed_at@day^nameNOT LIKEtest^descriptionISEMPTY'), [
    'opened_at',
    'closed_at',
    'name',
    'description',
  ])
  assert.deepEqual(fieldsInEncodedQuery(''), [])
  assert.deepEqual(fieldsInEncodedQuery('123TEXTQUERY321=email^active=true^EQ'), ['active'])
})

test('refuses what it cannot check', () => {
  refused(() => fieldsInEncodedQuery('sys_created_on>javascript:gs.daysAgo(7)'))
  refused(() => fieldsInEncodedQuery("JavaScript :'active=true^' + f()"))
  refused(() => fieldsInEncodedQuery('Active=true'))
  refused(() => fieldsInEncodedQuery('active'))
  refused(() => fieldsInEncodedQuery('activeFOO1'))
  refused(() => fieldsInEncodedQuery('^RLQUERYincident.problem_id,>=1^ENDRLQUERY'))
  refused(() => fieldsInEncodedQuery('ORDERBYNot A Field'))
  refused(() => fieldsInEncodedQuery('a=1\nb=2'))
  refused(() => fieldsInEncodedQuery('opened_atSAMEAS'))
})

test('table names cannot leave the Table API path', () => {
  assertTableName('incident')
  assertTableName('x_acme_app_table2')
  for (const name of ['../../x_app/endpoint', 'incident?sysparm_x=1', 'Incident', 'incident/..', '', 'a b']) {
    refused(() => assertTableName(name))
  }
})

test('convenience inputs stay values', () => {
  assertPlainValue('Now Assist', 'filter')
  refused(() => assertPlainValue('x^ORactive=false', 'filter'))
  refused(() => assertPlainValue('javascript:gs.log(1)', 'filter'))
  refused(() => assertSysId('not-a-sys-id'))
  assertSysId('0123456789abcdef0123456789abcdef')
})
