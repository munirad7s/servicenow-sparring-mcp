/**
 * End-to-end check against a live instance: npm run smoke
 *
 * Drives the real MCP server over an in-memory transport, exactly as a client
 * would, and exits with 1 if any check fails. It only reads. It prints counts and
 * verdicts, never record content.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ServiceNowClient } from './client.js'
import { loadSettings } from './config.js'
import { buildServer } from './server.js'

type Data = Record<string, any>

const methods = new Set<string>()
const paths = new Set<string>()
const settings = loadSettings(process.env, process.cwd(), { cwdFile: true })
const recorded = (url: string, init: RequestInit) => {
  methods.add(String(init.method))
  paths.add(new URL(url).pathname.split('/').slice(0, 4).join('/'))
  return fetch(url, init)
}
const sn = new ServiceNowClient(settings, recorded)

const server = buildServer(sn)
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
const client = new Client({ name: 'smoke', version: '1.0.0' })
await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

let failures = 0
function check(name: string, passed: boolean, detail = '') {
  if (!passed) failures++
  console.log(`${passed ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`)
}

async function call(name: string, args: Data = {}): Promise<{ data: Data; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args })
  const text = (result.content as Array<{ text: string }>)[0]?.text ?? '{}'
  return { data: JSON.parse(text), isError: result.isError === true }
}

const refused = (answer: { data: Data; isError: boolean }) => answer.isError && answer.data.error === 'validation'

console.log(`Smoke test against ${sn.host}\n`)

const { tools } = await client.listTools()
const expected = ['sn_delta', 'sn_dependencies', 'sn_instance', 'sn_origin', 'sn_plugins', 'sn_query', 'sn_schema', 'sn_upgrade_skips']
check('eight tools registered', JSON.stringify(tools.map((tool) => tool.name).sort()) === JSON.stringify(expected))
check('every tool is marked read-only', tools.every((tool) => tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === false))
check('every tool declares an output schema', tools.every((tool) => tool.outputSchema))

const instance = await call('sn_instance')
check('sn_instance names the release', !instance.isError && typeof instance.data.release?.build === 'string', instance.data.release?.family ?? instance.data.message)
const sources: Record<string, string> = instance.data.sources ?? {}
const unreadable = Object.entries(sources).filter(([, status]) => status !== 'readable')
console.log(`     sources readable: ${Object.keys(sources).length - unreadable.length} of ${Object.keys(sources).length}${unreadable.length ? `; not readable: ${unreadable.map(([table, status]) => `${table}=${status}`).join(', ')}` : ''}`)
console.log(`     counts: ${JSON.stringify(instance.data.counts)}  sandbox: ${instance.data.scriptSandbox}  account: ${JSON.stringify(instance.data.account)}`)

const one = await call('sn_query', { table: 'sys_db_object', query: 'name=incident', fields: ['name', 'super_class.name'] })
check('sn_query finds exactly one table named incident', !one.isError && one.data.total === 1 && one.data.returned === 1, `total ${one.data.total}`)
check('sn_query reports that field names were verified', String(one.data.fieldCheck).startsWith('all field names verified'))
check('every answer says how many requests it cost', typeof one.data.requests === 'number' && one.data.requests > 0, `${one.data.requests} requests`)

check('a query on an unknown field is refused', refused(await call('sn_query', { table: 'sys_db_object', query: 'nonexistent_field_xyz=1' })))
check('a query with javascript: is refused', refused(await call('sn_query', { table: 'incident', query: 'sys_created_on>javascript:gs.daysAgo(1)' })))
check('a query with a stored script (DYNAMIC) is refused', refused(await call('sn_query', { table: 'incident', query: 'assigned_toDYNAMIC90d1921e5f510100a9ad2572f2b477fe' })))
check('a table name with a path is refused', refused(await call('sn_query', { table: '../../x_app/endpoint' })))
check('a dot-walk through a list field is refused', refused(await call('sn_query', { table: 'incident', query: 'watch_list.email=nobody' })))
check('a date condition ServiceNow would drop is refused', refused(await call('sn_query', { table: 'incident', query: 'sys_created_onONToday' })))
check('a condition without a value, which ServiceNow would drop, is refused', refused(await call('sn_query', { table: 'incident', query: 'short_descriptionLIKE' })))
check('a condition on a field that holds a secret is refused', refused(await call('sn_query', { table: 'sys_user', query: 'user_passwordSTARTSWITHa', fields: ['sys_id'] })))

// "Is not" leaves out the rows where the field is empty: the three counts must add up without them.
const count = async (query: string) => (await call('sn_query', { table: 'incident', query, fields: ['sys_id'], limit: 1 })).data
const [everything, unassigned, notNobody] = [await count(''), await count('assigned_toISEMPTY'), await count(`assigned_to!=${'0'.repeat(32)}`)]
check(
  '"is not" leaves out rows with an empty field, and the answer says so',
  notNobody.total === everything.total - unassigned.total && notNobody.warnings.some((warning: string) => warning.includes('out rows where the field is empty')),
  `${everything.total} rows, ${unassigned.total} without assignee, ${notNobody.total} returned by "is not"`,
)
const [isNull, notNull] = [await count('assigned_to=NULL'), await count('assigned_to!=NULL')]
check('"=NULL" and "!=NULL" ask whether the field is empty', isNull.total === unassigned.total && notNull.total === everything.total - unassigned.total && notNull.warnings.length === notNobody.warnings.length - 1, `${isNull.total} and ${notNull.total}`)
// A name where a reference stores a sys_id: "is not" would leave nothing out, so it is refused.
check('a name in place of a sys_id behind "is not" is refused', refused(await call('sn_query', { table: 'incident', query: 'assigned_to!=Nobody Of This Name', fields: ['sys_id'], limit: 1 })))
// A text search reads fields it does not name, with or without a list of fields to return.
check('a text search on a table with a secret field is refused', refused(await call('sn_query', { table: 'sys_user', query: '123TEXTQUERY321=admin' })))

const label = await call('sn_query', { table: 'incident', query: 'state=New' })
check('a choice label in place of the stored value is refused', refused(label) && /label of "1"/.test(label.data.message))
const byName = await call('sn_query', { table: 'incident', query: 'caller_id=No Such Person', fields: ['number'] })
check('an empty result on a reference compared with a name is explained', !byName.isError && byName.data.total === 0 && byName.data.warnings.some((warning: string) => warning.includes('sys_id')))

const paged = await call('sn_query', { table: 'sys_db_object', fields: ['name'], limit: 2 })
check('sn_query pages and reports the total', !paged.isError && paged.data.truncated === true && paged.data.nextOffset === 2 && paged.data.total > 2, `total ${paged.data.total}`)

// The same rows, sorted so that both reads have one order, once with the count and once without it.
const ordered = { table: 'sys_db_object', query: 'ORDERBYname', fields: ['name'], limit: 5 }
const withTotal = await call('sn_query', ordered)
const withoutTotal = await call('sn_query', { ...ordered, count: false })
check(
  'sn_query without the count returns the same rows and no total',
  !withTotal.isError && !withoutTotal.isError && withoutTotal.data.total === null && withTotal.data.total > 5 && JSON.stringify(withoutTotal.data.records) === JSON.stringify(withTotal.data.records) && withoutTotal.data.truncated === true && withoutTotal.data.warnings.some((warning: string) => warning.startsWith('Not counted, as asked')),
  `${withoutTotal.data.returned} rows, total ${withoutTotal.data.total} against ${withTotal.data.total}`,
)

const perState = await call('sn_query', { table: 'incident', groupBy: 'state' })
const counted = (perState.data.groups ?? []).reduce((sum: number, group: Data) => sum + group.count, 0)
check('sn_query counts rows per value of a field', !perState.isError && perState.data.records.length === 0 && counted === perState.data.total && perState.data.totalGroups === perState.data.groups?.length, `${perState.data.totalGroups} groups, ${perState.data.total} rows`)

const secrets = await call('sn_query', { table: 'sys_properties', query: 'typeINpassword,password2^valueISNOTEMPTY', fields: ['name', 'value'], limit: 5 })
check(
  'system properties that hold secrets are withheld',
  !secrets.isError && (secrets.data.returned === 0 || secrets.data.records.every((record: Data) => String(record.value).startsWith('[withheld'))),
  `${secrets.data.returned} checked`,
)
const probing = await call('sn_query', { table: 'sys_properties', query: 'valueLIKEa', fields: ['name'], limit: 1 })
check(
  'a condition on property values leaves out the properties that hold secrets',
  !probing.isError && String(probing.data.query).includes('typeNOT INpassword,password2') && probing.data.warnings.some((warning: string) => warning.includes('hold a secret')),
  `${probing.data.total} match`,
)
check('property values are not listed as groups', refused(await call('sn_query', { table: 'sys_properties', groupBy: 'value' })))

const field = await call('sn_schema', { table: 'incident', filter: 'short_description' })
check('sn_schema finds an inherited field by default', !field.isError && field.data.columns?.[0]?.definedOn === 'task' && field.data.fieldCount > field.data.ownFieldCount, `${field.data.ownFieldCount} own, ${field.data.fieldCount} in all`)

// A field of task that incident overrides or relabels: the override is a record of its own, and so is the label.
const overridden = await call('sn_schema', { table: 'incident' })
const withRecords = (overridden.data.columns ?? []).filter((column: Data) => column.overrideRecords?.length)
const relabelled = (overridden.data.columns ?? []).filter((column: Data) => column.labelFrom)
check(
  'sn_schema names dictionary overrides as records, and where a label comes from',
  !overridden.isError && withRecords.every((column: Data) => column.overrideRecords.every((item: Data) => /^[0-9a-f]{32}$/.test(item.sysId) && item.changes.length > 0)),
  `${withRecords.length} fields with an override, ${relabelled.length} with a label of another table`,
)

const views = await call('sn_query', { table: 'sys_db_view', fields: ['name'], limit: 1 })
const viewName = views.data.records?.[0]?.name
if (viewName) {
  const view = await call('sn_schema', { table: viewName })
  check('sn_schema describes a database view', !view.isError && view.data.table?.kind === 'database_view' && view.data.table.joins?.length > 0, `${view.data.fieldCount} fields`)
  const typo = await call('sn_query', { table: viewName, query: 'zzz_no_such_field=1' })
  check('a query on an unknown field of a database view is refused', refused(typo))
}

const plugins = await call('sn_plugins', { limit: 3 })
check(
  'sn_plugins lists plugins, installed applications and those developed here',
  !plugins.isError && plugins.data.plugins.returned > 0 && plugins.data.customApps.table === 'sys_app',
  `applications read from ${plugins.data.storeApps.table}, total ${plugins.data.storeApps.total}; developed here ${plugins.data.customApps.total}`,
)

const delta = await call('sn_delta', { limit: 3 })
check('sn_delta lists captured updates with a total', !delta.isError && typeof delta.data.total === 'number' && delta.data.notCaptured.length > 0, `total ${delta.data.total}`)
check('sn_delta counts per type', Array.isArray(delta.data.byType) && delta.data.byType.length > 0, `${delta.data.byType?.length} types`)
check('sn_delta separates system accounts from people', typeof delta.data.capturedBySystemAccounts === 'number', `${delta.data.capturedBySystemAccounts} by system accounts`)

const vendorRule = await call('sn_query', { table: 'sys_script', query: 'ORDERBYsys_created_on', fields: ['sys_id'], limit: 1 })
const vendor = await call('sn_origin', { sysId: vendorRule.data.records?.[0]?.sys_id })
check('sn_origin judges the oldest business rule', !vendor.isError && typeof vendor.data.verdict === 'string', `${vendor.data.verdict}, provenance ${vendor.data.provenance}, divergence ${vendor.data.divergence}`)

const customName = delta.data.updates?.[0]?.name
if (customName) {
  const custom = await call('sn_origin', { updateName: customName })
  check(
    'sn_origin judges the newest captured update',
    !custom.isError && custom.data.divergence === 'customer_changes_captured' && custom.data.capturedBy !== 'nobody',
    `${custom.data.verdict}, provenance ${custom.data.provenance}, created ${custom.data.created}, captured by ${custom.data.capturedBy}`,
  )
}

const missing = await call('sn_origin', { sysId: '0'.repeat(32) })
check('sn_origin says not_found for an unknown sys_id', !missing.isError && missing.data.verdict === 'not_found')

// A dictionary entry that was never captured stores no update name. It must still be found by the name it would get.
const unnamed = await call('sn_query', { table: 'sys_dictionary', query: 'sys_update_nameISEMPTY^elementISNOTEMPTY', fields: ['name', 'element'], limit: 1 })
const entry = unnamed.data.records?.[0]
if (entry && /^[a-z0-9_]+$/.test(`${entry.name}${entry.element}`)) {
  const neverCaptured = await call('sn_origin', { updateName: `sys_dictionary_${entry.name}_${entry.element}` })
  check(
    'sn_origin finds a never-captured field by its update name',
    !neverCaptured.isError && neverCaptured.data.record !== null && neverCaptured.data.verdict !== 'not_found',
    `${neverCaptured.data.verdict}, ${unnamed.data.total} such entries`,
  )
}

const deps = await call('sn_dependencies', { table: 'incident', limit: 2 })
const categories: Record<string, Data> = deps.data.categories ?? {}
const checked = Object.values(categories).filter((category) => category.status === 'checked').length
check('sn_dependencies covers incident and its parent', !deps.isError && deps.data.tablesCovered?.includes('task') && checked >= 15, `${checked} of ${Object.keys(categories).length} categories checked, ${deps.data.requests} requests`)
check('every category names its table and query', Object.values(categories).every((category) => category.table && typeof category.query === 'string' && category.query.length > 0))
console.log(`     totals: ${Object.entries(categories).map(([key, category]) => `${key}=${category.total ?? category.status}`).join(' ')}`)

const fieldUse = await call('sn_dependencies', { table: 'incident', field: 'category', limit: 2 })
const fieldParts: Record<string, Data> = fieldUse.data.categories ?? {}
check(
  'sn_dependencies lists what is tied to one field',
  !fieldUse.isError && fieldUse.data.field === 'category' && Object.values(fieldParts).filter((part) => part.status === 'checked').length >= 7,
  Object.entries(fieldParts).map(([key, part]) => `${key}=${part.total ?? part.status}`).join(' '),
)

const skips = await call('sn_upgrade_skips', { limit: 3 })
check(
  'sn_upgrade_skips answers for the latest family upgrade',
  !skips.isError && typeof skips.data.total === 'number',
  `total ${skips.data.total}, not reviewed ${skips.data.notReviewed}, codes from ${skips.data.dispositionCodes?.from}, upgrade ${skips.data.upgrade?.kind ?? 'none'}`,
)
const captured = Object.values(skips.data.capturedBy ?? {}).reduce((sum: number, count) => sum + Number(count), 0)
check(
  'sn_upgrade_skips says who captured the changes to each entry',
  !skips.isError && (skips.data.records ?? []).every((row: Data) => ['people', 'system_accounts', 'nobody'].includes(row.capturedBy)) && captured === skips.data.returned,
  JSON.stringify(skips.data.capturedBy),
)
const changedOnly = await call('sn_upgrade_skips', { limit: 1, excludeErrors: true })
check('sn_upgrade_skips can leave out the files an upgrade could not apply', !changedOnly.isError && changedOnly.data.total <= skips.data.total, `${changedOnly.data.total} of ${skips.data.total}`)
check('sn_upgrade_skips counts per disposition for the whole filter', skips.data.total === 0 || (Array.isArray(skips.data.byDisposition) && skips.data.byDisposition.reduce((sum: number, item: Data) => sum + item.count, 0) === skips.data.total))

const resource = await client.readResource({ uri: 'servicenow-sparring://limitations' })
check('the limitations resource is served', String((resource.contents[0] as Data).text).includes('read-only promise'))

const prompts = (await client.listPrompts()).prompts.map((item) => item.name).sort()
check('three prompts are served', JSON.stringify(prompts) === JSON.stringify(['assess_change', 'review_upgrade', 'verify_claim']))

// The same instance through a second server on which the user table is closed, as SERVICENOW_TABLE_DENY=sys_user
// would close it: no row of it, and no name of a user, may come back by any way.
const closedSn = new ServiceNowClient({ ...settings, tables: { allow: settings.tables.allow, deny: [...settings.tables.deny, 'sys_user'] } }, recorded)
const [closedClient, closedServer] = InMemoryTransport.createLinkedPair()
const closed = new Client({ name: 'smoke-closed', version: '1.0.0' })
await Promise.all([closed.connect(closedClient), buildServer(closedSn).connect(closedServer)])
const ask = async (name: string, args: Data = {}): Promise<{ data: Data; isError: boolean }> => {
  const result = await closed.callTool({ name, arguments: args })
  return { data: JSON.parse((result.content as Array<{ text: string }>)[0]?.text ?? '{}'), isError: result.isError === true }
}
const blocked = (answer: { data: Data; isError: boolean }) => answer.isError && answer.data.error === 'blocked'
console.log('\nWith the user table closed on this machine:')
check('the table itself is not asked for', blocked(await ask('sn_query', { table: 'sys_user', fields: ['sys_id'], limit: 1 })))
check('a dot-walk into it is refused', blocked(await ask('sn_query', { table: 'incident', fields: ['caller_id.name'], limit: 1 })))
const callers = await ask('sn_query', { table: 'incident', query: 'caller_idISNOTEMPTY^assignment_groupISNOTEMPTY', fields: ['caller_id', 'assignment_group'], displayValue: true, limit: 5 })
check(
  'the name behind a reference into it is left out, and other names stay',
  !callers.isError && (callers.data.records ?? []).every((row: Data) => typeof row.caller_id === 'string') && callers.data.warnings.some((warning: string) => warning.includes('were left out: caller_id')) &&
    (callers.data.returned === 0 || (callers.data.records ?? []).some((row: Data) => typeof row.assignment_group === 'object')),
  `${callers.data.returned} rows`,
)
const perCaller = await ask('sn_query', { table: 'incident', groupBy: 'caller_id', limit: 5 })
check('groups counted by such a reference carry no names', !perCaller.isError && (perCaller.data.groups ?? []).every((group: Data) => !group.display), `${perCaller.data.totalGroups} groups`)
check('comparing such a reference with text is refused', blocked(await ask('sn_query', { table: 'incident', query: 'caller_idSTARTSWITHa', fields: ['sys_id'], limit: 1 })))
check('a text search on a table that points into it is refused', blocked(await ask('sn_query', { table: 'incident', query: '123TEXTQUERY321=network', fields: ['sys_id'], limit: 1 })))

// A third server, on which business rules are closed. A captured change says by its name which table its record
// is of: "sys_script_<sys_id>" is a business rule, "sys_script_include_<sys_id>" is a script include.
const rulesSn = new ServiceNowClient({ ...settings, tables: { allow: settings.tables.allow, deny: [...settings.tables.deny, 'sys_script'] } }, recorded)
const [rulesClient, rulesServer] = InMemoryTransport.createLinkedPair()
const rules = new Client({ name: 'smoke-rules', version: '1.0.0' })
await Promise.all([rules.connect(rulesClient), buildServer(rulesSn).connect(rulesServer)])
const changes = async (prefix: string) => {
  const result = await rules.callTool({ name: 'sn_query', arguments: { table: 'sys_update_xml', query: `nameSTARTSWITH${prefix}`, fields: ['name', 'target_name'], limit: 50 } })
  const data: Data = JSON.parse((result.content as Array<{ text: string }>)[0]?.text ?? '{}')
  return (data.records ?? []).filter((row: Data) => new RegExp(`^${prefix}[0-9a-f]{32}$`).test(String(row.name)))
}
const withheld = (row: Data) => String(row.target_name).startsWith('[withheld')
const [ofRules, ofIncludes] = [await changes('sys_script_'), await changes('sys_script_include_')]
console.log('\nWith business rules closed on this machine:')
check('the name of a captured change to a business rule is withheld', ofRules.length > 0 && ofRules.every(withheld), `${ofRules.length} changes`)
check('the name of a captured change to a script include is passed on', ofIncludes.length > 0 && !ofIncludes.some(withheld), `${ofIncludes.length} changes`)

check('every request was a GET', methods.size === 1 && methods.has('GET'), `${sn.requestCount + closedSn.requestCount + rulesSn.requestCount} requests`)
check('only the two read endpoints were called', [...paths].every((path) => path === '/api/now/table' || path === '/api/now/stats'), [...paths].join(', '))

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.')
process.exit(failures ? 1 : 0)
