import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runDoctor } from '../src/doctor.js'
import { FILTERED_BY, SOURCES } from '../src/tools/instance.js'
import { fakeInstance, type Route } from './fake.js'

async function doctor(routes: Route[]) {
  const { sn, calls } = fakeInstance(routes)
  const lines: string[] = []
  const exitCode = await runDoctor(sn, (line) => lines.push(line))
  return { exitCode, output: lines.join('\n'), calls }
}

const readable = (except: string[] = []): Route[] => SOURCES.filter(({ table }) => !except.includes(table)).map(({ table }) => ({ table, rows: [{ sys_id: '1' }] }))

test('the doctor command lists what the account can read, and what it cannot', async () => {
  const { exitCode, output, calls } = await doctor([
    { table: 'sys_properties', query: 'name=glide.war', rows: [{ name: 'glide.war', value: 'glide-zurich-07-01-2025__patch1.zip' }] },
    { table: 'sys_store_app', status: 403 },
    { table: 'sys_script', rows: [null], total: 12 },
    { table: 'sys_update_xml', api: 'stats', rows: [{ stats: { count: '3' }, groupby_fields: [{ value: 'Business Rule' }] }] },
    { table: 'upgrade_history_task', rows: [{ sys_id: '1', 'upgrade_detail.file_name': 'sys_script_1' }] },
    { table: 'sys_user_has_role', query: 'user.user_name=', rows: [{ 'role.name': 'itil', 'user.user_name': 'reader' }] },
    ...readable(['sys_store_app', 'sys_script']),
  ])
  assert.equal(exitCode, 0)
  assert.match(output, /^Checking example\.service-now\.com/)
  assert.match(output, /NO  sys_store_app\s+acl/)
  assert.match(output, /NO  sys_script\s+row_restricted/)
  assert.match(output, new RegExp(`${SOURCES.length - 2} of ${SOURCES.length} sources readable`))
  assert.match(output, /release \(glide\.war\)\s+glide-zurich-07-01-2025__patch1\.zip/)
  assert.match(output, /Aggregate API\s+ok, 1 types of captured changes/)
  assert.match(output, /upgrade details through a reference\s+ok/)
  assert.match(output, /1 roles, admin: no, snc_read_only: NO/)
  assert.match(output, /does not have the role snc_read_only/)
  // One request per source, four for what lies beyond the tables, and one per field a function filters by, on
  // the sources that could be read. No source is asked twice.
  const fields = FILTERED_BY.flatMap((item) => item.fields).length
  assert.match(output, new RegExp(`fields the functions filter by\\s+${fields} of ${fields} applied by this instance`))
  assert.equal(calls.length, SOURCES.length + 4 + fields)
  assert.ok(calls.every((entry) => entry.method === 'GET'))
})

test('the doctor command asks the instance whether it applies a condition on each field the functions filter by', async () => {
  // Measured on a database view: an instance that cannot use a condition drops it and answers with every row.
  // Asked for the rows where a field is empty and filled at once, it then answers with rows.
  const beyond: Route[] = [
    { table: 'sys_properties', query: 'name=glide.war', rows: [{ name: 'glide.war', value: 'glide-zurich-07-01-2025__patch1.zip' }] },
    { table: 'sys_update_xml', api: 'stats', rows: [{ stats: { count: '3' }, groupby_fields: [{ value: 'Business Rule' }] }] },
  ]
  const dropping = await doctor([{ table: 'sys_update_xml', exact: 'typeISEMPTY^typeISNOTEMPTY', rows: [{ sys_id: '1' }] }, ...beyond, ...readable()])
  const fields = FILTERED_BY.flatMap((item) => item.fields).length
  assert.match(dropping.output, new RegExp(`fields the functions filter by\\s+${fields - 1} of ${fields} applied by this instance; DROPPED: sys_update_xml\\.type`))
  assert.match(dropping.output, /This instance drops a condition on a field a function filters by/)
  assert.equal(dropping.exitCode, 1)

  // A question the instance refuses is no proof either way: it is named, and the command does not fail for it.
  const refusing = await doctor([{ table: 'upgrade_history_task', exact: 'upgrade_detail.dispositionISEMPTY^upgrade_detail.dispositionISNOTEMPTY', status: 403 }, ...beyond, ...readable()])
  assert.match(refusing.output, /could not be asked: upgrade_history_task\.upgrade_detail\.disposition \(acl\)/)
  assert.equal(refusing.exitCode, 0)

  // A source that cannot be read is not asked about its fields.
  const closed = await doctor([{ table: 'sys_update_version', status: 403 }, ...beyond, ...readable(['sys_update_version'])])
  assert.ok(!closed.calls.some((entry) => entry.table === 'sys_update_version' && entry.query.includes('ISEMPTY')))
  const left = fields - FILTERED_BY.find((item) => item.table === 'sys_update_version')!.fields.length
  assert.match(closed.output, new RegExp(`fields the functions filter by\\s+${left} of ${left} applied`))
})

test('the doctor command takes the release by its name, not by its place', async () => {
  // The condition on the name was ignored, and some other property came back first.
  const { output } = await doctor([{ table: 'sys_properties', rows: [{ name: 'glide.smtp.pw', value: 'ciphertext' }] }, ...readable()])
  assert.doesNotMatch(output, /ciphertext/)
  assert.match(output, /release \(glide\.war\)\s+not returned/)
})

test('the doctor command says "hidden", not "none", when upgrade entries exist that the account cannot see', async () => {
  const { output } = await doctor([{ table: 'upgrade_history_task', query: '', rows: [null], total: 4 }, ...readable(['upgrade_history_task'])])
  assert.match(output, /upgrade details through a reference\s+entries exist, but none is visible to this account/)
})

test('the doctor command stops after one request when the login is rejected, and fails', async () => {
  const { exitCode, output, calls } = await doctor([{ table: SOURCES[0].table, status: 401 }])
  assert.equal(exitCode, 1)
  assert.match(output, /The instance cannot be used: example\.service-now\.com rejected the credentials/)
  assert.equal(calls.length, 1)
})

test('the doctor command fails when nothing at all can be read', async () => {
  const { exitCode } = await doctor(SOURCES.map(({ table }) => ({ table, status: 403 })))
  assert.equal(exitCode, 1)
})
