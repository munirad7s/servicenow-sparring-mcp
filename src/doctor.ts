/**
 * Checks the address, the login and what the configured account can read:
 * "npm run doctor" in a checkout, "servicenow-sparring doctor" for an installed copy.
 *
 * The tools need no app on the instance, only read access to a set of tables.
 * Run this against a new instance before trusting answers from it.
 */
import { ServiceNowClient } from './client.js'
import { loadSettings } from './config.js'
import { accountRoles, NO_CONNECTION, probe, SOURCES } from './tools/instance.js'
import { errorKind, mapLimit } from './tools/shared.js'

export async function runDoctor(): Promise<void> {
  // Run by a person in a folder they chose, so a .env there may be used.
  const config = loadSettings(process.env, process.cwd(), { cwdFile: true })
  const sn = new ServiceNowClient(config)
  console.log(`Checking ${sn.host}${config.envFile ? `, settings from ${config.envFile}` : ''}\n`)

  // One request first. A wrong password or address should fail once, not once per table.
  try {
    await sn.query({ table: SOURCES[0].table, fields: ['sys_id'], limit: 1 })
  } catch (error) {
    if (NO_CONNECTION.has(errorKind(error))) {
      console.log(`The instance cannot be used: ${error instanceof Error ? error.message : error}`)
      console.log('Check the address and the login. For a certificate or proxy problem see "Proxies and certificates" in the README.')
      process.exitCode = 1
      return
    }
  }

  const results = await mapLimit(SOURCES, 4, async (item) => ({ ...item, ...(await probe(sn, item.table)) }))
  const width = Math.max(...results.map((result) => result.table.length))
  for (const result of results) {
    const mark = result.status === 'readable' ? 'ok ' : 'NO '
    console.log(`${mark} ${result.table.padEnd(width)}  ${result.status.padEnd(16)} ${result.usedBy}`)
  }
  const closed = results.filter((result) => result.status !== 'readable')
  console.log(`\n${results.length - closed.length} of ${results.length} sources readable.`)
  if (closed.length) console.log('Tools that depend on a closed source report that part as "could not be checked".')

  console.log('\nBeyond the tables:')
  const line = (label: string, text: string) => console.log(`  ${label.padEnd(34)} ${text}`)

  const release = await sn
    .query<{ value: string }>({ table: 'sys_properties', query: 'name=glide.war', fields: ['value'], limit: 1 })
    .then((page) => page.records[0]?.value || 'not returned (hidden from this account, or not set)')
    .catch((error) => `not readable (${errorKind(error)})`)
  line('release (glide.war)', release)

  const counts = await sn
    .groupCount('sys_update_xml', 'type')
    .then((groups) => `ok, ${groups.length} types of captured changes`)
    .catch((error) => `not usable (${errorKind(error)}): sn_delta and sn_upgrade_skips answer without counts`)
  line('Aggregate API', counts)

  const details = await sn
    .query<Record<string, string>>({ table: 'upgrade_history_task', fields: ['upgrade_detail.file_name'], limit: 1 })
    .then((page) => (!page.records.length ? 'no entries to test with' : page.records[0]['upgrade_detail.file_name'] ? 'ok' : 'entries come back without their file names'))
    .catch((error) => `not readable (${errorKind(error)})`)
  line('upgrade details through a reference', details)

  const account = await accountRoles(sn)
  line(
    'account',
    !account
      ? 'roles unknown (a token does not name its user, or sys_user_has_role is not readable)'
      : `${account.roles} roles, admin: ${account.admin ? 'yes' : 'no'}, snc_read_only: ${account.readOnlyRole ? 'yes' : 'NO'}`,
  )
  if (account && !account.readOnlyRole) {
    console.log('\nThis account does not have the role snc_read_only. The server only ever reads, but the instance itself')
    console.log('would accept a write from this account. With a read-only account the instance enforces the promise too.')
  }

  console.log(`\n${sn.requestCount} requests, all GET.`)
  if (closed.length === results.length) process.exitCode = 1
}
