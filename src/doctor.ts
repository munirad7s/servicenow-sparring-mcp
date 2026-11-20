/**
 * Checks the address, the login and what the configured account can read:
 * "npm run doctor" in a checkout, "servicenow-sparring doctor" for an installed copy.
 *
 * The tools need no app on the instance, only read access to a set of tables.
 * Run this against a new instance before trusting answers from it.
 */
import { ServiceNowClient } from './client.js'
import { proveCondition } from './dictionary.js'
import { loadSettings } from './config.js'
import { createContext } from './server.js'
import { accountRoles, FILTERED_BY, probe, SOURCES } from './tools/instance.js'
import { errorKind, mapLimit, NO_CONNECTION } from './tools/shared.js'

/**
 * Prints what it finds and returns the exit code: 1 if the instance cannot be used or no source is readable.
 * Called without a client, it reads the settings of the person who runs it.
 */
export async function runDoctor(given?: ServiceNowClient, print: (line: string) => void = console.log): Promise<number> {
  // Run by a person in a folder they chose, so a .env there may be used.
  const config = given ? null : loadSettings(process.env, process.cwd(), { cwdFile: true })
  const sn = given ?? new ServiceNowClient(config!)
  // The rules for closed tables apply to what the doctor asks as well.
  createContext(sn)
  print(`Checking ${sn.host}${config?.envFile ? `, settings from ${config.envFile}` : ''}\n`)

  // One request first, to a table this machine may ask for. A wrong password or address should fail once, not once per table.
  const opener = SOURCES.find((item) => sn.allows(item.table)) ?? SOURCES[0]
  const first = await probe(sn, opener.table)
  if (NO_CONNECTION.has(first.status)) {
    print(`The instance cannot be used: ${first.error instanceof Error ? first.error.message : first.status}`)
    print('Check the address and the login. For a certificate or proxy problem see "Proxies and certificates" in the README.')
    return 1
  }

  const results = await mapLimit(SOURCES, 4, async (item) => (item === opener ? { ...item, ...first } : { ...item, ...(await probe(sn, item.table)) }))
  const width = Math.max(...results.map((result) => result.table.length))
  for (const result of results) {
    const mark = result.status === 'readable' ? 'ok ' : 'NO '
    print(`${mark} ${result.table.padEnd(width)}  ${result.status.padEnd(16)} ${result.usedBy}`)
  }
  const closed = results.filter((result) => result.status !== 'readable')
  print(`\n${results.length - closed.length} of ${results.length} sources readable.`)
  if (closed.length) print('Tools that depend on a closed source report that part as "could not be checked".')

  print('\nBeyond the tables:')
  const line = (label: string, text: string) => print(`  ${label.padEnd(34)} ${text}`)

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

  // The fields the functions filter by in queries of their own. An instance that does not know a field drops the
  // condition and answers with every row, or, where it is set that way, answers with none. Each field is asked for
  // the rows where it is empty and filled at once, and for those where it is one of the two: see proveCondition.
  const asked = FILTERED_BY.filter((item) => results.find((result) => result.table === item.table)?.status === 'readable').flatMap((item) => item.fields.map((field) => ({ table: item.table, field })))
  const answers = await mapLimit(asked, 4, async ({ table, field }) => {
    const ask = (query: string) => sn.query({ table, query, fields: ['sys_id'], limit: 1 }).catch(() => null)
    return { name: `${table}.${field}`, verdict: await proveCondition(ask, field) }
  })
  const named = (verdict: string) => answers.filter((answer) => answer.verdict === verdict).map((answer) => answer.name)
  const [applied, droppedHere, silent, untested, unasked] = ['applied', 'dropped', 'answers_nothing', 'no_rows', 'unanswered'].map(named)
  line(
    'fields the functions filter by',
    `${applied.length} of ${answers.length} applied by this instance` +
      (droppedHere.length ? `; DROPPED: ${droppedHere.join(', ')}` : '') +
      (silent.length ? `; ANSWERED WITH NOTHING: ${silent.join(', ')}` : '') +
      (untested.length ? `; no rows to test with: ${untested.join(', ')}` : '') +
      (unasked.length ? `; could not be asked: ${unasked.join(', ')}` : ''),
  )
  if (droppedHere.length) {
    print('\nThis instance drops a condition on a field a function filters by, and answers with every row instead.')
    print('Answers of sn_delta, sn_origin, sn_upgrade_skips and sn_plugins that depend on that field are not to be trusted here.')
  }
  if (silent.length) {
    print('\nThis instance answers with no rows where a function filters by one of its fields, although the table has rows:')
    print('it does not know the field and is set to answer a query it cannot use with nothing. "Nothing found" from')
    print('sn_delta, sn_origin, sn_upgrade_skips and sn_plugins is not to be trusted here where it depends on that field.')
  }

  const account = await accountRoles(sn)
  line(
    'account',
    !account
      ? 'roles unknown (a token does not name its user, sys_user_has_role is not readable, or the tables of users or roles are closed on this machine)'
      : `${account.roles} roles, admin: ${account.admin ? 'yes' : 'no'}, snc_read_only: ${account.readOnlyRole ? 'yes' : 'NO'}`,
  )
  if (account && !account.readOnlyRole) {
    print('\nThis account does not have the role snc_read_only. The server only ever reads, but the instance itself')
    print('would accept a write from this account. With a read-only account the instance enforces the promise too.')
  }

  print(`\n${sn.requestCount} requests, all GET.`)
  return closed.length === results.length || droppedHere.length || silent.length ? 1 : 0
}
