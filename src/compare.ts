/**
 * Compares the server with the instance asked directly: npm run compare [-- <random tables>]
 *
 * 1. Fields. For well-known tables and some at random, the dictionary is read a
 *    second time, one table of the parent chain after the other, and held against
 *    what sn_schema answers: type, reference, mandatory, read-only, length,
 *    deactivated, choice list, the table that defines the field, and its label.
 * 2. Queries. A few hundred encoded queries go to the Table API as they are, and
 *    through sn_query. One the server passes on has to bring the same total and
 *    the same first rows. The ones it refuses on purpose are counted apart. The
 *    server gives a sorted query one more sort key, and says so in its answer:
 *    the instance is asked directly with that key, because without it the rows
 *    it answers with are not the same from one request to the next.
 *
 * 3. Rows. Whole rows are read both ways and compared cell by cell. A cell may
 *    differ only where the server says so in the cell itself: a value it
 *    withholds, a long text it cuts, a text it took a secret out of. With display
 *    values it also keeps a time as it is stored, in UTC.
 * 4. Counts per value, against the Aggregate API, read by pages as an agent would.
 *
 * It only reads. It prints counts, and for a difference the field or the query
 * concerned, with sys_ids replaced, never a value. It ends with 1 if anything
 * differs. Run it with no table closed on the machine: a closed table changes
 * totals on purpose.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ServiceNowClient } from './client.js'
import { loadSettings } from './config.js'
import { withStableOrder } from './query.js'
import { buildServer } from './server.js'

type Data = Record<string, any>
type Row = Record<string, string>

const wanted = Number(process.argv[2] ?? 20)
if (!Number.isInteger(wanted) || wanted < 0 || wanted > 500) throw new Error('The number of random tables must be a whole number between 0 and 500.')

const settings = loadSettings(process.env, process.cwd(), { cwdFile: true })
const sn = new ServiceNowClient(settings)
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
const client = new Client({ name: 'compare', version: '1.0.0' })
await Promise.all([client.connect(clientTransport), buildServer(sn).connect(serverTransport)])

async function call(name: string, args: Data): Promise<{ data: Data; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args })
  const text = (result.content as Array<{ text: string }>)[0]?.text ?? '{}'
  return { data: text.startsWith('{') ? JSON.parse(text) : { error: 'protocol', message: text }, isError: result.isError === true }
}

// The second way to the instance: a plain GET, past everything the server does to a request.
let direct = 0
const authorization = settings.auth.kind === 'basic' ? `Basic ${Buffer.from(`${settings.auth.username}:${settings.auth.password}`).toString('base64')}` : `Bearer ${settings.auth.token}`
async function get(table: string, params: Record<string, string | number>, api = 'table'): Promise<{ status: number; total: string | null; rows: Row[] | null }> {
  const url = new URL(`/api/now/${api}/${table}`, settings.instanceUrl)
  for (const [key, value] of Object.entries({ ...params, sysparm_exclude_reference_link: 'true' })) url.searchParams.set(key, String(value))
  direct++
  // No method is named: a request without one is a GET.
  const response = await fetch(url, { headers: { Authorization: authorization, Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(settings.timeoutMs) })
  const body = (await response.json().catch(() => null)) as { result?: unknown } | null
  return { status: response.status, total: response.headers.get('x-total-count'), rows: Array.isArray(body?.result) ? (body.result as Row[]) : null }
}
/** Every row that matches, page after page. Fails if the instance does not answer with a list. */
async function all(table: string, query: string, fields: string[]): Promise<Row[]> {
  const rows: Row[] = []
  for (let offset = 0; ; offset += 1_000) {
    const page = await get(table, { sysparm_query: query, sysparm_fields: fields.join(','), sysparm_limit: 1_000, sysparm_offset: offset })
    if (page.status !== 200 || !page.rows) throw new Error(`The instance answered with HTTP ${page.status} for ${table}.`)
    rows.push(...page.rows)
    if (page.rows.length < 1_000) return rows
  }
}
const masked = (text: string) => text.replace(/[0-9a-f]{32}/g, '<sys_id>')

console.log(`Compared with the Table API on ${sn.host}`)
if (settings.tables.allow.length || settings.tables.deny.length) {
  console.log('\nTables are closed on this machine. The server then leaves rows out on purpose, so totals differ by design: run this with no table closed.')
  process.exit(1)
}

// ---------------------------------------------------------------------- fields

const KNOWN = ['incident', 'change_request', 'problem', 'sc_req_item', 'sc_task', 'task_sla', 'sys_user', 'sys_user_group', 'cmdb_ci_linux_server', 'cmdb_ci_win_server', 'cmdb_ci_appl', 'kb_knowledge', 'sys_script', 'sysapproval_approver', 'alm_hardware', 'incident_task']
const withParent = Number((await get('sys_db_object', { sysparm_query: 'super_classISNOTEMPTY', sysparm_fields: 'sys_id', sysparm_limit: 1 })).total ?? 0)
const random: string[] = []
for (let i = 0; i < wanted && withParent > 0; i++) {
  const page = await get('sys_db_object', { sysparm_query: 'super_classISNOTEMPTY^ORDERBYsys_id', sysparm_fields: 'name', sysparm_limit: 1, sysparm_offset: Math.floor(Math.random() * withParent) })
  if (page.rows?.[0]?.name) random.push(page.rows[0].name)
}

const yes = (value: unknown) => value === 'true'
const differences: string[] = []
let tables = 0
let absent = 0
let fields = 0
for (const table of [...new Set([...KNOWN, ...random])]) {
  // The chain, one step at a time, by the sys_id of the parent.
  const chain: string[] = []
  let row = (await all('sys_db_object', `name=${table}`, ['name', 'super_class']))[0]
  if (!row) {
    absent++
    continue
  }
  while (row && chain.length < 32) {
    chain.push(row.name)
    row = row.super_class ? (await all('sys_db_object', `sys_id=${row.super_class}`, ['name', 'super_class']))[0] : (undefined as unknown as Row)
  }
  // The fields, root first: an entry on a table nearer to the one asked for wins. Then the overrides and the labels.
  const expected = new Map<string, Data>()
  for (const name of [...chain].reverse()) {
    for (const entry of await all('sys_dictionary', `name=${name}^elementISNOTEMPTY`, ['element', 'internal_type', 'reference', 'mandatory', 'read_only', 'max_length', 'active', 'choice', 'column_label'])) {
      expected.set(entry.element, {
        type: entry.internal_type,
        reference: entry.reference || null,
        mandatory: yes(entry.mandatory),
        readOnly: yes(entry.read_only),
        maxLength: entry.max_length === '' ? null : Number(entry.max_length),
        inactive: entry.active === 'false',
        // 1 and 3 are the two kinds of dropdown. 2 only suggests values, and the field takes any other.
        choice: entry.choice === '1' || entry.choice === '3',
        definedOn: name,
        label: entry.column_label,
      })
    }
  }
  for (const name of [...chain].reverse()) {
    for (const override of await all('sys_dictionary_override', `name=${name}`, ['element', 'mandatory_override', 'mandatory', 'read_only_override', 'read_only'])) {
      const field = expected.get(override.element)
      if (field && yes(override.mandatory_override)) field.mandatory = yes(override.mandatory)
      if (field && yes(override.read_only_override)) field.readOnly = yes(override.read_only)
    }
    for (const label of await all('sys_documentation', `name=${name}^language=en^elementISNOTEMPTY`, ['element', 'label'])) {
      const field = expected.get(label.element)
      if (field && label.label) field.label = label.label
    }
  }

  const answer = await call('sn_schema', { table })
  if (answer.isError) {
    differences.push(`${table}: sn_schema failed (${answer.data.error})`)
    continue
  }
  tables++
  if (JSON.stringify(answer.data.table.extends) !== JSON.stringify(chain.slice(1))) differences.push(`${table}: parent tables ${JSON.stringify(answer.data.table.extends)}, read directly ${JSON.stringify(chain.slice(1))}`)
  const got = new Map<string, Data>((answer.data.columns as Data[]).map((column) => [column.name, column]))
  for (const name of expected.keys()) if (!got.has(name)) differences.push(`${table}.${name}: missing from sn_schema`)
  for (const name of got.keys()) if (!expected.has(name)) differences.push(`${table}.${name}: in sn_schema only`)
  for (const [name, want] of expected) {
    const have = got.get(name)
    if (!have) continue
    fields++
    const pairs: Array<[string, unknown, unknown]> = [
      ['type', have.type, want.type],
      ['reference', have.reference ?? null, want.reference],
      ['mandatory', have.mandatory ?? false, want.mandatory],
      ['readOnly', have.readOnly ?? false, want.readOnly],
      ['maxLength', have.maxLength ?? null, want.maxLength],
      ['inactive', have.inactive ?? false, want.inactive],
      ['choice', have.choice ?? false, want.choice],
      ['definedOn', have.definedOn, want.definedOn],
      ['label', have.label, want.label],
    ]
    for (const [key, mine, theirs] of pairs) if (mine !== theirs) differences.push(`${table}.${name}: ${key} is ${JSON.stringify(mine)}, read directly ${JSON.stringify(theirs)}`)
  }
}
console.log(`\nFields: ${tables} tables${absent ? ` (${absent} of the list do not exist here)` : ''}, ${fields} fields, ${differences.length} difference(s)`)
for (const line of differences.slice(0, 40)) console.log(`  ${line}`)
if (differences.length > 40) console.log(`  and ${differences.length - 40} more`)

// --------------------------------------------------------------------- queries

// Values of the instance, so that the conditions meet rows. They are sent, never printed.
const sample = async (table: string, query: string, field: string) => (await get(table, { sysparm_query: query, sysparm_fields: field, sysparm_limit: 1 })).rows?.[0]?.[field] ?? ''
const caller = await sample('incident', 'caller_idISNOTEMPTY', 'caller_id')
const group = await sample('incident', 'assignment_groupISNOTEMPTY', 'assignment_group')
const number = await sample('incident', 'ORDERBYnumber', 'number')
const ci = await sample('incident', 'cmdb_ciISNOTEMPTY', 'cmdb_ci')
const day = (await sample('incident', 'ORDERBYDESCopened_at', 'opened_at')).slice(0, 10) || '2026-01-01'
const NONE = '0'.repeat(32)

/** Queries the server is to pass on unchanged. */
const PASSED: Array<[string, string[]]> = [
  ['incident', [
    '', 'active=true', 'active=false', 'active=true^priority=1', 'priority=1^ORpriority=2', 'priorityIN1,2', 'priorityNOT IN1,2', 'priority!=1', 'priority<3', 'priority<=3', 'priority>3', 'priority>=3', 'priorityBETWEEN1@3',
    'short_descriptionLIKEemail', 'short_descriptionNOT LIKEemail', 'short_descriptionSTARTSWITHUnable', 'short_descriptionENDSWITHdown', 'short_descriptionISEMPTY', 'short_descriptionISNOTEMPTY', 'short_descriptionLIKEe-mail',
    'short_descriptionLIKE100%', 'short_descriptionLIKEa b', 'active=true^short_descriptionCONTAINSemail', 'descriptionLIKEplease', 'close_notesISEMPTY', 'close_notesANYTHING',
    `caller_id=${caller}`, `caller_id!=${caller}`, `caller_idIN${caller}`, 'caller_idISEMPTY', 'caller_id.active=true', 'caller_id.active=false', 'caller_id.department.nameISNOTEMPTY', 'caller_id.nameSTARTSWITHA',
    `assignment_group=${group}`, 'assignment_groupISEMPTY', 'assignment_group.nameLIKEService', 'assignment_group.nameSTARTSWITHS^active=true', `assignment_group=${group}^ORassignment_groupISEMPTY`,
    `number=${number}`, 'numberSTARTSWITHINC', 'numberLIKE001', `numberIN${number}`, `numberNOT IN${number}`, `cmdb_ci=${ci}`, 'cmdb_ci.sys_class_name=cmdb_ci_server', 'cmdb_ci.nameISNOTEMPTY',
    'state=1', 'state=2', 'stateIN1,2,3', 'state!=7', 'stateNOT IN6,7,8', 'incident_state=6', 'state=6^ORstate=7', 'state<6', 'category=network', 'category=software', 'categoryISEMPTY', 'categoryINnetwork,hardware', 'subcategoryISNOTEMPTY',
    'impact=1^urgency=1', 'impact=1^ORurgency=1', 'impact=1^urgency=1^NQpriority=5', 'active=true^NQactive=false', 'priority=1^NQpriority=2^NQpriority=3', 'active=true^priority=1^ORpriority=2^state=2',
    'priority=1^ORpriority=2^NQstate=6^ORstate=7', 'active=true^priority=1^ORstate=2^NQcategory=network',
    `opened_at>=${day} 00:00:00`, `opened_at<${day} 00:00:00`, `opened_atBETWEEN${day} 00:00:00@${day} 23:59:59`, `opened_atON${day}@${day} 00:00:00@${day} 23:59:59`, `opened_atNOTON${day}@${day} 00:00:00@${day} 23:59:59`,
    'opened_atRELATIVEGT@year@ago@3', 'opened_atRELATIVELT@year@ago@1', 'opened_atRELATIVEGE@month@ago@6', 'sys_created_on>2020-01-01', 'sys_created_on<2020-01-01 00:00:00', 'sys_updated_on>=2026-01-01 00:00:00',
    'opened_atMORETHANsys_created_on@hour@before@1', 'opened_atLESSTHANsys_created_on@hour@after@1', 'opened_atSAMEASsys_created_on', 'opened_atNSAMEASsys_created_on',
    'sys_updated_onGT_FIELDsys_created_on', 'sys_updated_onLT_FIELDsys_created_on', 'sys_updated_onGT_OR_EQUALS_FIELDsys_created_on', 'opened_bySAMEAScaller_id', 'opened_byNSAMEAScaller_id',
    'made_sla=true', 'made_sla=false', 'reassignment_count>0', 'reassignment_count=0', 'reopen_count>=1', 'sys_mod_count>10', 'sys_mod_countBETWEEN5@10',
    'sys_class_name=incident', 'sys_class_nameINSTANCEOFtask', 'sys_class_name!=incident', `sys_id=${NONE}`, 'sys_idISNOTEMPTY', 'sys_idSTARTSWITH0', `sys_idIN${NONE},${'1'.repeat(32)}`,
    'active=true^ORDERBYnumber', 'active=true^ORDERBYDESCnumber', 'ORDERBYpriority^ORDERBYDESCopened_at', 'active=true^ORDERBYcaller_id.name', 'priority=1^ORDERBYDESCsys_created_on', 'active=true^EQ', 'active=true^EQ^ORDERBYnumber',
    'active=true^priority=1^ORDERBYnumber^ORDERBYDESCsys_id', 'activeISNOTEMPTY', 'activeISEMPTY', 'active=1', 'active=0', 'active=TRUE', 'active!=true',
    'priority=', 'priority=^active=true', 'short_description=', 'short_description!=', 'caller_id=', 'caller_id!=', 'priority=NULL', 'priority!=NULL', 'caller_id=NULL', 'caller_id!=NULL',
    'short_descriptionLIKEa^short_descriptionLIKEe^short_descriptionLIKEi', 'short_descriptionLIKEa^ORshort_descriptionLIKEe^ORdescriptionLIKEi',
    'watch_listISNOTEMPTY', `watch_listLIKE${caller}`, 'active=true^sys_domain=global', 'sys_domainISNOTEMPTY', 'business_duration>1970-01-01 01:00:00', 'calendar_durationISNOTEMPTY', 'time_workedISEMPTY', 'due_dateISEMPTY',
    'short_descriptionLIKE,', 'short_descriptionLIKE@', 'short_descriptionLIKE=', 'short_description=a^^b', '123TEXTQUERY321=email', 'short_descriptionLIKEemail^123TEXTQUERY321=server',
  ]],
  ['task', ['', 'active=true', 'sys_class_name=incident', 'sys_class_nameINincident,problem', 'sys_class_nameNOT INincident,problem', 'sys_class_nameINSTANCEOFchange_request', 'active=true^sys_class_name=change_request', 'numberSTARTSWITHCHG', 'assigned_toISEMPTY^active=true', 'parentISNOTEMPTY', 'parent.sys_class_name=incident', 'ref_incident.category=network', 'ref_change_request.type=normal', 'priority=1^ORDERBYDESCsys_updated_on']],
  ['change_request', ['', 'type=normal', 'type=standard', 'typeINnormal,emergency', 'risk=2', 'state=-5', 'state<0', 'stateIN-5,-4', 'start_dateISNOTEMPTY', 'end_dateGT_FIELDstart_date', 'cab_required=true', 'approval=approved', 'approval!=approved', 'chg_modelISNOTEMPTY', 'on_hold=true', 'active=true^ORDERBYstart_date']],
  ['sys_user', ['', 'active=true', 'active=true^emailISNOTEMPTY', 'user_nameSTARTSWITHa', 'nameLIKEadmin', 'last_loginISNOTEMPTY', 'locked_out=true', 'department.nameISNOTEMPTY', 'manager.active=true', 'roles=admin', 'sys_created_by=system', 'emailENDSWITH.com', 'emailLIKE@', 'web_service_access_only=true', 'vip=true', 'ORDERBYuser_name']],
  ['sys_script', ['', 'active=true', 'collection=incident', 'collection=incident^active=true', 'collectionINincident,task', 'when=before', 'whenINbefore,after', 'order<100', 'orderBETWEEN100@200', 'scriptLIKEcurrent.update', 'scriptLIKEgs.log', 'nameLIKEincident', 'action_insert=true^action_update=false', 'advanced=true', 'filter_conditionISNOTEMPTY', 'sys_scope.scope=global', 'sys_scope!=global', 'sys_package.sys_class_name=sys_store_app', 'sys_policy=read', 'sys_updated_by=admin', 'sys_updated_byNOT INsystem,guest^sys_updated_byNOT LIKE@snc.']],
  ['sys_dictionary', ['', 'name=incident', 'name=incident^elementISNOTEMPTY', 'name=incident^internal_type=reference', 'nameINincident,task^element=state', 'reference=sys_user', 'reference=sys_user^active=true', 'internal_type=glide_date_time^name=task', 'mandatory=true^name=incident', 'elementSTARTSWITHu_', 'nameSTARTSWITHu_', 'max_length>4000', 'choice=1', 'choice!=0', 'attributesLIKEtree_picker', 'default_valueISNOTEMPTY^name=incident', 'dependentISNOTEMPTY^name=incident', 'calculation!=NULL']],
  ['sys_db_object', ['', 'name=incident', 'super_class.name=task', 'super_classISEMPTY', 'nameSTARTSWITHcmdb_ci_', 'nameSTARTSWITHu_', 'nameSTARTSWITHx_', 'is_extendable=true', 'super_class.super_class.name=cmdb_ci', 'labelLIKEIncident', 'sys_scope.scope!=global', 'access=public', 'number_refISNOTEMPTY', 'ORDERBYname']],
  ['sys_update_xml', ['', 'type=Business Rule', 'action=DELETE', 'action=INSERT_OR_UPDATE^type=Access Control', 'nameSTARTSWITHsys_script_', 'nameSTARTSWITHsys_script_include_', 'update_set.name=Default', 'update_set.state=complete', 'sys_created_by=admin', 'category=customer', 'target_nameLIKEincident', 'replace_on_upgrade=true', 'remote_update_setISNOTEMPTY', 'application.scope=global', 'ORDERBYDESCsys_updated_on']],
  ['sys_choice', ['', 'name=incident^element=state', 'name=incident^element=state^language=en', 'name=incident^element=state^inactive=false', 'name=task^element=priority', 'nameINincident,task^element=state^ORDERBYsequence', 'element=state^value=1', 'labelLIKEProgress', 'language=de', 'dependent_valueISNOTEMPTY^name=incident']],
  ['cmdb_ci', ['', 'sys_class_name=cmdb_ci_linux_server', 'sys_class_nameINSTANCEOFcmdb_ci_server', 'operational_status=1', 'install_status=1', 'nameISEMPTY', 'ip_addressISNOTEMPTY', 'ip_addressSTARTSWITH10.', 'manufacturer.nameLIKEDell', 'location.cityISNOTEMPTY', 'discovery_sourceISNOTEMPTY', 'support_groupISEMPTY', 'sys_class_name!=cmdb_ci_computer^ORDERBYname']],
  ['kb_knowledge', ['', 'workflow_state=published', 'workflow_state=published^active=true', 'textLIKEpassword', 'short_descriptionLIKEhow', 'valid_to>=2026-01-01', 'authorISNOTEMPTY', 'sys_view_count>10', 'kb_category.labelISNOTEMPTY', 'numberSTARTSWITHKB']],
  ['task_sla', ['', 'has_breached=true', 'stage=in_progress', 'task.sys_class_name=incident', 'task.sys_class_name=incident^has_breached=true', 'percentage>50', 'active=true^stage!=paused', 'task.active=true', 'task.assignment_group.nameISNOTEMPTY', 'sla.collection=incident']],
  ['sys_properties', ['', 'name=glide.ui.session_timeout', 'nameSTARTSWITHglide.ui.', 'nameLIKEtimeout', 'type=boolean', 'type=password', 'is_private=true', 'valueISEMPTY', 'value=true', 'valueLIKEhttp', 'read_rolesISNOTEMPTY', 'write_rolesLIKEadmin', 'sys_scope.scope!=global', 'ignore_cache=true']],
]

/** Queries the server is to refuse: sent on, each would be answered with something other than what it asks for. */
const REFUSED: Array<[string, string]> = [
  ['incident', 'close_notesEMPTYSTRING'],
  ['incident', 'active=true^GROUPBYpriority'],
  ['incident', 'active=yes'],
  ['incident', 'no_such_field=1'],
  ['incident', 'no_such_field=1^active=true'],
  ['incident', 'active=true^no_such_field=1'],
  ['incident', 'caller_id.no_such_field=1'],
  ['incident', 'opened_atONToday@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()'],
  ['incident', 'due_date<javascript:gs.daysAgoStart(0)'],
  ['incident', 'caller_idDYNAMIC90d1921e5f510100a9ad2572f2b477fe'],
  ['incident', 'work_notesLIKEa'],
  ['incident', 'commentsLIKEa'],
  ['incident', 'short_descriptionLIKE^'],
  ['incident', 'IR_AND_OR_QUERY=email'],
  ['incident', 'short_descriptionDOES NOT CONTAINemail'],
  ['incident', 'short_descriptionIS NOTemail'],
  ['incident', `sys_tags.${NONE}=${NONE}`],
  ['change_request', 'end_date>start_date'],
]

const tally = new Map<string, number>()
const count = (kind: string) => tally.set(kind, (tally.get(kind) ?? 0) + 1)
const wrong: string[] = []
for (const [table, queries] of PASSED) {
  // A table this instance does not have, or this account may not read, is left out.
  if ((await get(table, { sysparm_fields: 'sys_id', sysparm_limit: 1 })).status !== 200) {
    count(`left out: the table cannot be read here (${queries.length} queries)`)
    continue
  }
  for (const query of queries) {
    // The one thing the server may add to a query it passes on is the last sort key. The answer has to name it.
    const sent = withStableOrder(query)
    const [theirs, mine] = [await get(table, { sysparm_query: sent, sysparm_fields: 'sys_id', sysparm_limit: 5 }), await call('sn_query', { table, query, fields: ['sys_id'], limit: 5 })]
    const ids = (rows: Array<Data> | null | undefined) => JSON.stringify((rows ?? []).map((row) => row.sys_id))
    const warnings = ((mine.data.warnings as string[] | undefined) ?? []).join(' ')
    if (mine.isError) {
      // A field this instance lacks is no finding about the server.
      if (/^Unknown field/.test(String(mine.data.message))) count('left out: a field this instance does not have')
      else wrong.push(`refused, and should be passed on: ${table}  ${masked(query)}  (${String(mine.data.message).slice(0, 120)})`)
    } else if (theirs.status !== 200) {
      wrong.push(`passed on, and the instance refuses it when asked directly (HTTP ${theirs.status}): ${table}  ${masked(query)}`)
    } else if (/hold a secret/.test(warnings)) {
      // The one intended difference: a comparison on the value of a property leaves out the properties that hold a
      // secret. The answer names the query with that condition, and its total can be smaller.
      count('another query on purpose, said in a warning: properties that hold a secret are left out')
    } else if (String(mine.data.total) !== String(theirs.total)) {
      wrong.push(`other total: ${table}  ${masked(query)}  (sn_query ${mine.data.total}, directly ${theirs.total})`)
    } else if (mine.data.query !== sent) {
      wrong.push(`the answer names another query than the one given: ${table}  ${masked(query)}  (${masked(String(mine.data.query))})`)
    } else if (ids(mine.data.records) !== ids(theirs.rows)) {
      wrong.push(`same total, other rows: ${table}  ${masked(query)}`)
    } else {
      count('same total and same rows as the Table API')
    }
  }
}
for (const [table, query] of REFUSED) {
  const mine = await call('sn_query', { table, query, fields: ['sys_id'], limit: 1 })
  if (mine.isError && mine.data.error === 'validation') count('refused, as intended')
  else wrong.push(`${mine.isError ? `refused as "${mine.data.error}", not as a query that cannot be checked` : 'passed on, and should be refused'}: ${table}  ${masked(query)}`)
}

console.log(`\nQueries: ${[...tally.values()].reduce((sum, value) => sum + value, 0) + wrong.length}`)
for (const [kind, value] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${String(value).padStart(5)}  ${kind}`)
console.log(`  ${String(wrong.length).padStart(5)}  difference(s)`)
for (const line of wrong.slice(0, 40)) console.log(`         ${line}`)

// ------------------------------------------------------------------------ rows

/** Reads of whole rows: table, query, fields, and whether display values are asked for. */
const READS: Array<[string, string, string[], boolean]> = [
  ['incident', 'ORDERBYnumber', ['number', 'short_description', 'description', 'state', 'priority', 'caller_id', 'assignment_group', 'opened_at', 'active', 'sys_class_name', 'cmdb_ci', 'close_notes', 'watch_list', 'business_duration'], false],
  ['incident', 'ORDERBYnumber', ['number', 'state', 'priority', 'caller_id', 'assignment_group', 'opened_at', 'active', 'caller_id.name', 'assignment_group.manager'], true],
  ['sys_script', 'collection=incident^ORDERBYname', ['name', 'collection', 'when', 'order', 'condition', 'script', 'filter_condition', 'active', 'sys_scope', 'sys_package'], false],
  ['sys_script', 'collection=task^ORDERBYname', ['name', 'when', 'order', 'sys_scope', 'sys_package', 'sys_updated_by'], true],
  ['sys_script_include', 'ORDERBYname', ['name', 'api_name', 'script', 'client_callable', 'access', 'sys_policy'], false],
  ['sys_dictionary', 'name=incident^ORDERBYelement', ['name', 'element', 'internal_type', 'reference', 'max_length', 'mandatory', 'default_value', 'attributes', 'reference_qual', 'calculation'], false],
  ['sys_properties', 'ORDERBYname', ['name', 'value', 'type', 'description', 'is_private'], false],
  ['sys_properties', 'typeINpassword,password2', ['name', 'value', 'type'], false],
  ['sys_user', 'ORDERBYuser_name', ['user_name', 'name', 'email', 'active', 'user_password', 'last_login_time', 'department', 'roles'], false],
  ['sys_update_xml', 'ORDERBYDESCsys_updated_on', ['name', 'type', 'target_name', 'action', 'update_set', 'payload', 'sys_created_by'], false],
  ['sys_update_xml', 'type=System Property^ORDERBYname', ['name', 'target_name', 'payload'], false],
  ['sys_update_version', 'ORDERBYDESCsys_created_on', ['name', 'state', 'source_table', 'source', 'payload'], false],
  ['sys_security_acl', 'nameSTARTSWITHincident^ORDERBYname', ['name', 'operation', 'type', 'condition', 'script', 'advanced', 'active'], false],
  ['sys_ui_policy', 'table=incident^ORDERBYshort_description', ['short_description', 'conditions', 'on_load', 'reverse_if_false', 'script_true', 'run_scripts'], false],
  ['sysevent_email_action', 'collection=incident^ORDERBYname', ['name', 'event_name', 'condition', 'recipient_fields', 'message_html', 'subject'], false],
  ['sys_choice', 'name=incident^element=state^ORDERBYsequence', ['name', 'element', 'value', 'label', 'language', 'sequence', 'inactive'], false],
  ['kb_knowledge', 'ORDERBYnumber', ['number', 'short_description', 'text', 'workflow_state', 'author', 'kb_knowledge_base'], false],
  ['sys_db_object', 'nameSTARTSWITHincident^ORDERBYname', ['name', 'label', 'super_class', 'super_class.name', 'is_extendable', 'sys_scope.scope'], false],
  ['task_sla', 'ORDERBYDESCsys_created_on', ['task', 'sla', 'stage', 'has_breached', 'percentage', 'business_duration', 'start_time'], true],
  ['sys_audit_delete', 'ORDERBYDESCsys_created_on', ['tablename', 'display_value', 'payload'], false],
  ['sys_email', 'ORDERBYDESCsys_created_on', ['subject', 'recipients', 'type', 'body_text'], false],
  ['oauth_entity', '', ['name', 'client_id', 'client_secret', 'type'], false],
  ['sys_auth_profile_basic', '', ['name', 'username', 'password'], false],
  ['discovery_credentials', '', ['name', 'type', 'user_name', 'password'], false],
]
const STORED_TIME = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/
const cells = new Map<string, number>()
const altered: string[] = []
let compared = 0
for (const [table, query, names, display] of READS) {
  const mine = await call('sn_query', { table, query, fields: names, limit: 15, ...(display ? { displayValue: true } : {}) })
  if (mine.isError) {
    // A table or a field this instance lacks, or one this account may not read, is no finding about the server.
    cells.set('reads left out: the table or a field is not there, or not readable', (cells.get('reads left out: the table or a field is not there, or not readable') ?? 0) + 1)
    continue
  }
  // Asked directly with the query the answer names, so that both ways read the same rows.
  const theirs = await get(table, { sysparm_query: String(mine.data.query), sysparm_fields: names.join(','), sysparm_limit: 15, ...(display ? { sysparm_display_value: 'all' } : {}) })
  const rows = mine.data.records as Data[]
  if (theirs.status !== 200 || !theirs.rows) {
    altered.push(`${table}: the instance refuses the read when asked directly (HTTP ${theirs.status})`)
    continue
  }
  if (rows.length !== theirs.rows.length) altered.push(`${table}: ${rows.length} rows through the server, ${theirs.rows.length} directly`)
  // With display values the server writes a cell as plain text where the stored and the shown value are the same.
  const shape = (cell: any) => (cell && typeof cell === 'object' ? { value: cell.value ?? '', display: cell.display_value ?? cell.display ?? cell.value ?? '' } : display ? { value: cell ?? '', display: cell ?? '' } : cell)
  for (let index = 0; index < Math.min(rows.length, theirs.rows.length); index++) {
    for (const name of names) {
      // A field the instance itself leaves out of a row is left out of both.
      if (!(name in theirs.rows[index]) && !(name in rows[index])) continue
      compared++
      const [mineCell, theirCell] = [shape(rows[index][name]), shape((theirs.rows[index] as Data)[name])]
      if (JSON.stringify(mineCell) === JSON.stringify(theirCell)) continue
      const shown = typeof rows[index][name] === 'string' ? (rows[index][name] as string) : JSON.stringify(rows[index][name] ?? null)
      const kind = shown.startsWith('[withheld')
        ? 'withheld, and marked in the cell'
        : shown.includes('[withheld') || shown.includes('[cut here:')
          ? 'a part withheld or cut, and marked in the cell'
          : display && typeof mineCell === 'object' && mineCell.value === theirCell?.value && STORED_TIME.test(String(mineCell.value))
            ? 'a time kept as it is stored, in UTC'
            : ''
      if (kind) cells.set(kind, (cells.get(kind) ?? 0) + 1)
      else altered.push(`${table}.${name}: the cell differs and is not marked`)
    }
  }
}
console.log(`\nRows: ${READS.length} reads, ${compared} cells compared`)
for (const [kind, value] of [...cells].sort((a, b) => b[1] - a[1])) console.log(`  ${String(value).padStart(5)}  ${kind}`)
console.log(`  ${String(altered.length).padStart(5)}  difference(s)`)
for (const line of [...new Set(altered)].slice(0, 40)) console.log(`         ${line}`)

// ------------------------------------------------------------- counts per value

const COUNTS: Array<[string, string, string]> = [
  ['incident', 'priority', ''], ['incident', 'state', 'active=true'], ['incident', 'category', ''], ['incident', 'assignment_group', ''], ['incident', 'caller_id', 'active=true'], ['incident', 'made_sla', 'priority=1^NQpriority=2'],
  ['task', 'sys_class_name', ''], ['sys_update_xml', 'type', ''], ['sys_update_xml', 'sys_created_by', ''], ['sys_update_xml', 'update_set', 'action=DELETE'], ['sys_script', 'collection', 'active=true'], ['sys_script', 'when', ''],
  ['sys_dictionary', 'internal_type', 'name=task'], ['sys_db_object', 'super_class', ''], ['sys_security_acl', 'operation', ''], ['sys_properties', 'type', ''], ['sys_user', 'active', ''], ['cmdb_ci', 'sys_class_name', ''],
  ['sys_update_version', 'source_table', ''], ['upgrade_history_task', 'upgrade_detail.disposition', ''], ['sys_choice', 'language', 'name=incident'],
]
let counted = 0
let skipped = 0
const miscounted: string[] = []
for (const [table, groupBy, query] of COUNTS) {
  const first = await call('sn_query', { table, groupBy, query, limit: 100 })
  if (first.isError) {
    skipped++
    continue
  }
  const groups = [...(first.data.groups as Data[])]
  // Read on by pages, as an agent would: every group has to come once.
  for (let page = first.data; page.truncated && typeof page.nextOffset === 'number'; ) {
    const next = await call('sn_query', { table, groupBy, query, limit: 100, offset: page.nextOffset })
    if (next.isError) break
    groups.push(...(next.data.groups as Data[]))
    page = next.data
  }
  const theirs = await get(table, { sysparm_count: 'true', sysparm_group_by: groupBy, ...(query ? { sysparm_query: query } : {}) }, 'stats')
  const want = new Map<string, number>(((theirs.rows ?? []) as Data[]).map((group) => [String(group.groupby_fields?.[0]?.value ?? ''), Number(group.stats?.count)]))
  const got = new Map<string, number>(groups.map((group) => [String(group.value), Number(group.count)]))
  const rowsInAll = [...want.values()].reduce((sum, value) => sum + value, 0)
  const same = theirs.status === 200 && groups.length === want.size && got.size === want.size && [...want].every(([value, count]) => got.get(value) === count) && first.data.totalGroups === want.size && first.data.total === rowsInAll
  if (same) counted++
  else miscounted.push(`${table} per ${groupBy}${query ? ` where ${masked(query)}` : ''}: ${groups.length} groups read (${got.size} different), ${want.size} directly; total ${first.data.total}, directly ${rowsInAll}`)
}
console.log(`\nCounts per value: ${COUNTS.length - skipped}${skipped ? ` (${skipped} left out: not readable here)` : ''}`)
console.log(`  ${String(counted).padStart(5)}  the same groups and counts as the Aggregate API, each group once`)
console.log(`  ${String(miscounted.length).padStart(5)}  difference(s)`)
for (const line of miscounted) console.log(`         ${line}`)

console.log(`\n${sn.requestCount + direct} requests, all GET: ${sn.requestCount} by the server, ${direct} directly.`)
process.exit(differences.length || wrong.length || altered.length || miscounted.length ? 1 : 0)
