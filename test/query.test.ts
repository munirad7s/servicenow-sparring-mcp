import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ServiceNowError } from '../src/errors.js'
import { assertFieldPath, assertPlainValue, assertSysId, assertTableName, fieldsInEncodedQuery, isPlainValue, parseEncodedQuery } from '../src/query.js'

const refused = (run: () => unknown) =>
  assert.throws(run, (error: unknown) => error instanceof ServiceNowError && error.kind === 'validation')

/**
 * What the parser must do with each query. The expectations follow what a live
 * instance does: a form the instance drops or answers with nothing is refused
 * here. docs/encoded-queries.md lists the measurements.
 */
const ACCEPTED: Array<[query: string, fields: string[]]> = [
  ['active=true', ['active']],
  ['state!=6', ['state']],
  ['priority>2', ['priority']],
  ['priority>=2', ['priority']],
  ['sys_created_on<2025-01-01 00:00:00', ['sys_created_on']],
  ['reassignment_count<=3', ['reassignment_count']],
  ['short_descriptionLIKEemail', ['short_description']],
  ['short_descriptionNOT LIKEtest', ['short_description']],
  ['short_descriptionCONTAINSemail', ['short_description']],
  ['numberSTARTSWITHINC', ['number']],
  ['emailENDSWITH@example.com', ['email']],
  ['priorityIN1,2,3', ['priority']],
  ['stateNOT IN6,7', ['state']],
  ['sys_class_nameINSTANCEOFcmdb_ci_server', ['sys_class_name']],
  ['descriptionISEMPTY', ['description']],
  ['assigned_toISNOTEMPTY', ['assigned_to']],
  ['close_notesISEMPTYSTRING', ['close_notes']],
  ['short_descriptionANYTHING', ['short_description']],
  ['short_description=', ['short_description']],
  ['assigned_to=NULL', ['assigned_to']],
  ['', []],
  ['sys_created_onON2025-01-15@2025-01-15 00:00:00@2025-01-15 23:59:59', ['sys_created_on']],
  ['sys_created_onNOTON2025-01-15@2025-01-15 00:00:00@2025-01-15 23:59:59', ['sys_created_on']],
  ['sys_created_onBETWEEN2025-01-01 00:00:00@2025-01-31 23:59:59', ['sys_created_on']],
  ['priorityBETWEEN2@4', ['priority']],
  ['sys_created_onRELATIVEGT@dayofweek@ago@7', ['sys_created_on']],
  ['sys_created_onRELATIVELT@hour@ago@24', ['sys_created_on']],
  ['sys_created_onRELATIVEGE@minute@ahead@15', ['sys_created_on']],
  ['sys_created_onRELATIVELE@month@ago@1', ['sys_created_on']],
  ['sys_created_onRELATIVEEE@year@ago@1', ['sys_created_on']],
  ['opened_bySAMEASassigned_to', ['opened_by', 'assigned_to']],
  ['opened_atSAMEASclosed_at@day', ['opened_at', 'closed_at']],
  ['opened_atNSAMEAScaller_id.sys_created_on', ['opened_at', 'caller_id.sys_created_on']],
  ['closed_atGT_FIELDdue_date', ['closed_at', 'due_date']],
  ['opened_atLT_FIELDdue_date', ['opened_at', 'due_date']],
  ['closed_atGT_OR_EQUALS_FIELDdue_date', ['closed_at', 'due_date']],
  ['opened_atLT_OR_EQUALS_FIELDdue_date', ['opened_at', 'due_date']],
  ['closed_atMORETHANopened_at@hour@after@4', ['closed_at', 'opened_at']],
  ['closed_atLESSTHANopened_at@day@before@1', ['closed_at', 'opened_at']],
  ['locationIN_HIERARCHY0123456789abcdef0123456789abcdef', ['location']],
  ['active=true^priority=1^ORpriority=2', ['active', 'priority']],
  ['active=true^priority=1^NQstate=6^assigned_toISEMPTY', ['active', 'priority', 'state', 'assigned_to']],
  ['active=true^EQ', ['active']],
  ['active=true^EQ^ORDERBYDESCsys_created_on', ['active', 'sys_created_on']],
  ['^EQ', []],
  ['^active=true', ['active']],
  ['active=true^', ['active']],
  ['ORDERBYpriority^ORDERBYDESCnumber', ['priority', 'number']],
  ['active=true^ORDERBYDESCcaller_id.name', ['active', 'caller_id.name']],
  ['active=true^GROUPBYpriority', ['active', 'priority']],
  ['GOTOnumberSTARTSWITHINC0010001', ['number']],
  ['caller_id.manager.department.name=IT', ['caller_id.manager.department.name']],
  ['ref_incident.severity=1', ['ref_incident.severity']],
  ['123TEXTQUERY321=email^active=true', ['active']],
  ['short_descriptionLIKEIN PROGRESS', ['short_description']],
  ['nameSTARTSWITHORDERBY', ['name']],
  ['descriptionLIKEa=b', ['description']],
  ['short_description=NOT LIKE', ['short_description']],
  ['short_description=foo, bar, baz', ['short_description']],
  ['short_descriptionLIKEÜbung 日本語', ['short_description']],
  ['caller_id.email=alice@example.org', ['caller_id.email']],
  ['u_1st_approverISNOTEMPTY', ['u_1st_approver']],
  ['x_acme_app_statusINopen,pending', ['x_acme_app_status']],
  // "^^" is a literal ^ inside the value: one condition, not two.
  ['short_descriptionLIKEa^^b', ['short_description']],
  ['active=false^^priority=1', ['active']],
]

const REFUSED: Array<[query: string, why: string]> = [
  ['sys_created_on>javascript:gs.daysAgo(7)', 'runs script'],
  ['sys_created_on>JAVASCRIPT:gs.daysAgo(7)', 'runs script'],
  ["JavaScript :'active=true^' + f()", 'runs script'],
  ['assigned_toINjavascript:getMyGroups()', 'runs script'],
  ['assigned_toDYNAMIC90d1921e5f510100a9ad2572f2b477fe', 'runs a stored script'],
  ['assignment_groupIN_HIERARCHY_DYNAMICd6435e965f510100a9ad2572f2b47744', 'runs a stored script'],
  ['sys_created_onDATEPARTMonday@x', 'needs script'],
  ['stateVALCHANGES', 'matches nothing through the Table API'],
  ['stateCHANGESFROM1', 'matches nothing through the Table API'],
  ['stateCHANGESTO6', 'matches nothing through the Table API'],
  ['stateEXCLUDING6,7', 'matched nothing when measured'],
  ['watch_listDOESNOTHAVEabc', 'matched nothing when measured'],
  ['short_descriptionEMPTYSTRING', 'matched nothing when measured'],
  ['short_descriptionNOTLIKEtest', 'dropped by the instance'],
  ['stateNOTIN6,7', 'not an operator'],
  ['state<>6', 'read as < ">6"'],
  ['active==true', 'read as = "=true"'],
  ['descriptionISEMPTY=false', 'the value is ignored: the opposite of what was meant'],
  ['assigned_toISNOTEMPTYgarbage', 'the value is ignored'],
  ['sys_created_onONToday', 'dropped by the instance'],
  ['sys_created_onNOTONToday', 'dropped by the instance'],
  ['sys_created_onBETWEEN2025-01-01 00:00:00', 'dropped by the instance'],
  ['priorityBETWEEN2', 'dropped by the instance'],
  ['sys_created_onRELATIVEGT7', 'matches nothing'],
  ['sys_created_onRELATIVEGT@day@ago@7', 'the unit "day" matched nothing when measured'],
  ['sys_created_onRELATIVEGT@year@sometime@1', 'unknown direction'],
  ['opened_atSAMEAS', 'needs a field'],
  ['opened_atSAMEASclosed_at@bogus', 'unknown unit'],
  ['closed_atGT_FIELDdue_date@day', 'takes a plain field'],
  ['closed_atMORETHANopened_at', 'matched nothing when measured'],
  ['closed_atMORETHANopened_at@minute@after@4', 'the unit "minute" matched nothing when measured'],
  ['sys_class_nameINSTANCEOF', 'needs a table'],
  ['locationIN_HIERARCHY', 'needs a sys_id'],
  ['Active=true', 'upper-case field names are dropped by the instance'],
  ['STATEIN1,2', 'upper-case field name'],
  ['active', 'no operator'],
  ['activeFOO1', 'no operator'],
  ['active = true', 'space before the operator'],
  ['short_descriptionlikeemail', 'lower-case operator'],
  ['short_description*email', 'list shorthand'],
  ['short_descriptionMATCH_RGXINC[0-9]+', 'not checked'],
  ['^RLQUERYincident.problem_id,>=1^ENDRLQUERY', 'related list query'],
  ['SUBQUERYsys_id,task,task_sla^stage=breached^ENDSUBQUERY', 'subquery'],
  ['ORDERBY', 'needs a field'],
  ['ORDERBYNot A Field', 'needs a field'],
  ['active=true^TRENDBYsys_created_on,week', 'not checked'],
  ['active=true^OR', 'empty condition'],
  ['active=true^OR123TEXTQUERY321=email', 'a text search cannot be joined with OR'],
  ['caller_id..name=Bob', 'empty path segment'],
  ['.active=true', 'empty path segment'],
  ['123field=abc', 'field names do not start with a digit'],
  ['variables.0123456789abcdef0123456789abcdef=yes', 'catalog variables cannot be checked'],
  ['variables.abcdef0123456789abcdef0123456789=yes', 'catalog variables cannot be checked, also when the id starts with a letter'],
  ['sys_tags=urgent', 'tags cannot be checked'],
  ['sys_tagsISEMPTY', 'matched nothing when measured, in either direction'],
  ['sys_tags.abcdef0123456789abcdef0123456789=abcdef0123456789abcdef0123456789', 'tags cannot be checked'],
  ['short_description%email', 'list shorthand'],
  ['short_description!*email', 'list shorthand'],
  ['short_descriptionMATCH_PAT*email*', 'not checked'],
  ['a=1\nb=2', 'line break'],
  ['a=1\u0000', 'control character'],
  ['^^^', 'a lone caret'],
]

test('accepts what the instance applies, and finds every field in it', () => {
  for (const [query, fields] of ACCEPTED) {
    assert.deepEqual(fieldsInEncodedQuery(query), fields, query)
  }
})

test('refuses what the instance would drop, answer with nothing, or run as script', () => {
  for (const [query, why] of REFUSED) {
    assert.throws(
      () => fieldsInEncodedQuery(query),
      (error: unknown) => error instanceof ServiceNowError && error.kind === 'validation',
      `${JSON.stringify(query)} must be refused: ${why}`,
    )
  }
})

test('a look-alike letter does not get "javascript:" past the check', () => {
  // U+017F, the long s, folds to "s".
  refused(() => fieldsInEncodedQuery(`sys_created_on>java${String.fromCharCode(0x17f)}cript:gs.daysAgo(7)`))
  // A non-breaking space, and a zero-width space, between the word and the colon.
  refused(() => fieldsInEncodedQuery(`sys_created_on>javascript${String.fromCharCode(0xa0)}:gs.daysAgo(7)`))
  refused(() => fieldsInEncodedQuery(`sys_created_on>javascript${String.fromCharCode(0x200b)}:gs.daysAgo(7)`))
})

test('conditions are returned with operator and value', () => {
  const parsed = parseEncodedQuery('state=6^priorityIN1,2^ORDERBYnumber^short_descriptionLIKEa^^b')
  assert.deepEqual(parsed.conditions, [
    { field: 'state', operator: '=', value: '6' },
    { field: 'priority', operator: 'IN', value: '1,2' },
    { field: 'short_description', operator: 'LIKE', value: 'a^b' },
  ])
  assert.equal(parsed.escapedCaret, true)
  assert.equal(parseEncodedQuery('active=true').escapedCaret, false)
})

test('a refusal names the term and how to write it', () => {
  assert.throws(() => fieldsInEncodedQuery('state<>6'), /use !=/)
  assert.throws(() => fieldsInEncodedQuery('descriptionISEMPTY=false'), /takes no value/)
  assert.throws(() => fieldsInEncodedQuery('sys_created_onRELATIVEGT@day@ago@7'), /dayofweek/)
  assert.throws(() => fieldsInEncodedQuery('closed_atMORETHANopened_at'), /GT_FIELD/)
  assert.throws(() => fieldsInEncodedQuery('short_descriptionNOTLIKEx'), /with a space/)
})

test('size limits keep one call from keeping the server busy', () => {
  refused(() => fieldsInEncodedQuery(`short_descriptionLIKE${'a'.repeat(8_001)}`))
  refused(() => fieldsInEncodedQuery(`${'a'.repeat(81)}=1`))
  refused(() => assertFieldPath(Array.from({ length: 11 }, () => 'a').join('.')))
  assertFieldPath(Array.from({ length: 10 }, () => 'a').join('.'))
})

test('table names cannot leave the Table API path', () => {
  assertTableName('incident')
  assertTableName('x_acme_app_table2')
  for (const name of ['../../x_app/endpoint', 'incident?sysparm_x=1', 'Incident', 'incident/..', '', 'a b', 'a'.repeat(81)]) {
    refused(() => assertTableName(name))
  }
})

test('convenience inputs stay values', () => {
  assertPlainValue('Now Assist', 'filter')
  assertPlainValue('com.snc.incident', 'filter')
  refused(() => assertPlainValue('x^ORactive=false', 'filter'))
  refused(() => assertPlainValue('javascript:gs.log(1)', 'filter'))
  refused(() => assertPlainValue('a'.repeat(251), 'filter'))
  refused(() => assertSysId('not-a-sys-id'))
  refused(() => assertSysId('0123456789abcdef0123456789abcdef^ORactive=true'))
  assertSysId('0123456789abcdef0123456789abcdef')
  assertSysId('global')
})

test('a value read from the instance is checked before it goes into a query', () => {
  assert.equal(isPlainValue('sys_script_0123456789abcdef0123456789abcdef'), true)
  for (const value of ['a^ORb=c', 'a,b', 'a\nb', '', 'javascript:x', undefined, 5, 'a'.repeat(251)]) {
    assert.equal(isPlainValue(value), false, String(value))
  }
})
