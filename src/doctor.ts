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
  const first = await probe(sn, SOURCES[0].table)
  if (NO_CONNECTION.has(first.status)) {
    console.log(`The instance cannot be used: ${first.error instanceof Error ? first.error.message : first.status}`)
    console.log('Check the address and the login. For a certificate or proxy problem see "Proxies and certificates" in the README.')
    process.exitCode = 1
    return
  }

  const others = await mapLimit(SOURCES.slice(1), 4, async (item) => ({ ...item, ...(await probe(sn, item.table)) }))
  const results = [{ ...SOURCES[0], ...first }, ...others]
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

  // The row is taken by its name, not by its place: an ignored condition would hand back some other property.
  const release = await sn
    .query<{ name: string; value: string }>({ table: 'sys_properties', query: 'name=glide.war', fields: ['name', 'value'], limit: 1 })
    .then((page) => page.records.find((row) => row.name === 'glide.war')?.value || 'not returned (hidden from this account, or not set)')
    .catch((error) => `not readable (${errorKind(error)})`)
  line('release (glide.war)', release)

  const counts = await sn
    .groupCount('sys_update_xml', 'type')
    .then((groups) => `ok, ${groups.length} types of captured changes`)
    .catch((error) => `not usable (${errorKind(error)}): sn_delta and sn_upgrade_skips answer without counts`)
  line('Aggregate API', counts)

  const details = await sn
    .query<Record<string, string>>({ table: 'upgrade_history_task', fields: ['upgrade_detail.file_name'], limit: 1 })
    .then((page) => {
      if (!page.records.length) return (page.total ?? 0) > 0 ? 'entries exist, but none is visible to this account' : 'no entries to test with'
      return page.records[0]['upgrade_detail.file_name'] ? 'ok' : 'entries come back without their file names'
    })
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
