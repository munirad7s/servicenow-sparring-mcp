import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runDoctor } from '../src/doctor.js'
import { SOURCES } from '../src/tools/instance.js'
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
    { table: 'sys_user_has_role', query: 'user.user_name=', rows: [{ 'role.name': 'itil' }] },
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
  // One request per source, and four for what lies beyond the tables. No source is asked twice.
  assert.equal(calls.length, SOURCES.length + 4)
  assert.ok(calls.every((entry) => entry.method === 'GET'))
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
