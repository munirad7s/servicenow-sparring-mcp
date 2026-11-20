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
const sn = new ServiceNowClient(loadSettings(process.env, process.cwd(), { cwdFile: true }), (url, init) => {
  methods.add(String(init.method))
  paths.add(new URL(url).pathname.split('/').slice(0, 4).join('/'))
  return fetch(url, init)
})

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

const label = await call('sn_query', { table: 'incident', query: 'state=New' })
check('a choice label in place of the stored value is refused', refused(label) && /label of "1"/.test(label.data.message))
const byName = await call('sn_query', { table: 'incident', query: 'caller_id=No Such Person', fields: ['number'] })
check('an empty result on a reference compared with a name is explained', !byName.isError && byName.data.total === 0 && byName.data.warnings.some((warning: string) => warning.includes('sys_id')))

const paged = await call('sn_query', { table: 'sys_db_object', fields: ['name'], limit: 2 })
check('sn_query pages and reports the total', !paged.isError && paged.data.truncated === true && paged.data.nextOffset === 2 && paged.data.total > 2, `total ${paged.data.total}`)

const perState = await call('sn_query', { table: 'incident', groupBy: 'state' })
const counted = (perState.data.groups ?? []).reduce((sum: number, group: Data) => sum + group.count, 0)
check('sn_query counts rows per value of a field', !perState.isError && perState.data.records.length === 0 && counted === perState.data.total, `${perState.data.groups?.length} groups, ${perState.data.total} rows`)

const secrets = await call('sn_query', { table: 'sys_properties', query: 'typeINpassword,password2^valueISNOTEMPTY', fields: ['name', 'value'], limit: 5 })
check(
  'system properties that hold secrets are withheld',
  !secrets.isError && (secrets.data.returned === 0 || secrets.data.records.every((record: Data) => String(record.value).startsWith('[withheld'))),
  `${secrets.data.returned} checked`,
)

const field = await call('sn_schema', { table: 'incident', filter: 'short_description' })
check('sn_schema finds an inherited field by default', !field.isError && field.data.columns?.[0]?.definedOn === 'task' && field.data.fieldCount > field.data.ownFieldCount, `${field.data.ownFieldCount} own, ${field.data.fieldCount} in all`)

const views = await call('sn_query', { table: 'sys_db_view', fields: ['name'], limit: 1 })
const viewName = views.data.records?.[0]?.name
if (viewName) {
  const view = await call('sn_schema', { table: viewName })
  check('sn_schema describes a database view', !view.isError && view.data.table?.kind === 'database_view' && view.data.table.joins?.length > 0, `${view.data.fieldCount} fields`)
  const typo = await call('sn_query', { table: viewName, query: 'zzz_no_such_field=1' })
  check('a query on an unknown field of a database view is refused', refused(typo))
}

const plugins = await call('sn_plugins', { limit: 3 })
check('sn_plugins lists plugins and installed applications', !plugins.isError && plugins.data.plugins.returned > 0, `applications read from ${plugins.data.storeApps.table}, total ${plugins.data.storeApps.total}`)

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

const deps = await call('sn_dependencies', { table: 'incident', limit: 2 })
const categories: Record<string, Data> = deps.data.categories ?? {}
const checked = Object.values(categories).filter((category) => category.status === 'checked').length
check('sn_dependencies covers incident and its parent', !deps.isError && deps.data.tablesCovered?.includes('task') && checked >= 15, `${checked} of ${Object.keys(categories).length} categories checked, ${deps.data.requests} requests`)
check('every category names its table and query', Object.values(categories).every((category) => category.table && typeof category.query === 'string' && category.query.length > 0))
console.log(`     totals: ${Object.entries(categories).map(([key, category]) => `${key}=${category.total ?? category.status}`).join(' ')}`)

const skips = await call('sn_upgrade_skips', { limit: 3 })
check(
  'sn_upgrade_skips answers for the latest family upgrade',
  !skips.isError && typeof skips.data.total === 'number',
  `total ${skips.data.total}, not reviewed ${skips.data.notReviewed}, codes from ${skips.data.dispositionCodes?.from}, upgrade ${skips.data.upgrade?.kind ?? 'none'}`,
)
check('sn_upgrade_skips counts per disposition for the whole filter', skips.data.total === 0 || (Array.isArray(skips.data.byDisposition) && skips.data.byDisposition.reduce((sum: number, item: Data) => sum + item.count, 0) === skips.data.total))

const resource = await client.readResource({ uri: 'servicenow-sparring://limitations' })
check('the limitations resource is served', String((resource.contents[0] as Data).text).includes('read-only promise'))

const prompt = await client.getPrompt({ name: 'verify_claim', arguments: { claim: 'test' } })
check('the verify_claim prompt is served', prompt.messages.length === 1)

check('every request was a GET', methods.size === 1 && methods.has('GET'), `${sn.requestCount} requests`)
check('only the two read endpoints were called', [...paths].every((path) => path === '/api/now/table' || path === '/api/now/stats'), [...paths].join(', '))

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.')
process.exit(failures ? 1 : 0)
