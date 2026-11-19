/**
 * Checks what the configured account can read: npm run doctor
 *
 * The tools need no app on the instance, only read access to a set of tables.
 * Run this against a new instance before trusting answers from it.
 */
import { ServiceNowClient } from './client.js'
import { loadConfig, loadEnvFile } from './config.js'
import { probe, SOURCES } from './tools/instance.js'
import { mapLimit } from './tools/shared.js'

async function main() {
  loadEnvFile()
  const sn = new ServiceNowClient(loadConfig())
  console.log(`Checking ${sn.host}\n`)

  const results = await mapLimit(SOURCES, 4, async (item) => ({ ...item, ...(await probe(sn, item.table)) }))
  const width = Math.max(...results.map((result) => result.table.length))

  for (const result of results) {
    const mark = result.status === 'readable' ? 'ok ' : 'NO '
    console.log(`${mark} ${result.table.padEnd(width)}  ${result.status.padEnd(16)} ${result.usedBy}`)
  }

  const blocked = results.filter((result) => result.status !== 'readable')
  console.log(`\n${results.length - blocked.length} of ${results.length} sources readable, ${sn.requestCount} requests, all GET.`)

  if (blocked.some((result) => result.status === 'auth' || result.status === 'network' || result.status === 'invalid_response')) {
    console.log('The instance could not be used at all. Check the address and the credentials.')
    process.exit(1)
  }
  if (blocked.length) {
    console.log('Tools that depend on a blocked source report that part as "could not be checked".')
  }
}

main().catch((error) => {
  console.error(`doctor failed: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
})
