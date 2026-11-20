/**
 * Measures sn_origin on the configured instance: npm run origin-check [-- <sample size>]
 *
 * 1. A cross-check against a second judge. The upgrade engine skips a delivered
 *    file when it considers it customized. For every file the last family upgrade
 *    skipped for that reason, sn_origin should answer "customized".
 * 2. Two random samples, to show how often each verdict comes up and how often
 *    the tool abstains: one of application files, one of captured changes.
 *
 * It only reads, and it prints counts, never names or content. Run it before
 * relying on sn_origin on a new instance, and compare with the README.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ServiceNowClient } from './client.js'
import { loadSettings } from './config.js'
import { buildServer } from './server.js'
import { mapLimit } from './tools/shared.js'
import { recentUpgrades } from './tools/upgrade.js'

type Data = Record<string, any>

const size = Number(process.argv[2] ?? 100)
if (!Number.isInteger(size) || size < 1 || size > 2_000) throw new Error('The sample size must be a whole number between 1 and 2000.')

const sn = new ServiceNowClient(loadSettings(process.env, process.cwd(), { cwdFile: true }))
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
const client = new Client({ name: 'origin-check', version: '1.0.0' })
await Promise.all([client.connect(clientTransport), buildServer(sn).connect(serverTransport)])

async function origin(args: Data): Promise<Data> {
  const result = await client.callTool({ name: 'sn_origin', arguments: args })
  const text = (result.content as Array<{ text: string }>)[0]?.text ?? '{}'
  return text.startsWith('{') ? JSON.parse(text) : { error: 'refused' }
}

function table(title: string, answers: Data[], key: (answer: Data) => string) {
  const counts = new Map<string, number>()
  for (const answer of answers) counts.set(key(answer), (counts.get(key(answer)) ?? 0) + 1)
  console.log(`\n${title}: ${answers.length}`)
  for (const [name, count] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(5)}  ${((100 * count) / answers.length).toFixed(1).padStart(5)} %  ${name}`)
  }
}

const verdict = (answer: Data) => answer.verdict ?? `error: ${answer.error}`

/** Rows of a table at random positions. Each costs one request. */
async function randomRows(name: string, field: string, count: number): Promise<string[]> {
  const total = (await sn.query({ table: name, fields: ['sys_id'], limit: 1 })).total ?? 0
  const offsets = [...new Set(Array.from({ length: count }, () => Math.floor(Math.random() * total)))]
  const rows = await mapLimit(offsets, 4, (offset) => sn.query<Record<string, string>>({ table: name, fields: [field], limit: 1, offset }).then((page) => page.records[0]?.[field] ?? ''))
  return [...new Set(rows.filter(Boolean))]
}

console.log(`sn_origin on ${sn.host}`)

// 1. The upgrade engine as a second judge.
const upgrade = (await recentUpgrades(sn)).find((item) => item.kind === 'family')
if (!upgrade) {
  console.log('\nNo change of release family is recorded, so there is no upgrade to cross-check against.')
} else {
  const choices = await sn.query<Record<string, string>>({
    table: 'sys_choice',
    query: 'name=sys_upgrade_history_log^element=disposition^language=en^inactive=false^labelSTARTSWITHSkipped',
    fields: ['value', 'label'],
    limit: 50,
  })
  // "Skipped Error" is a failure to apply a file, not a judgement that it was customized.
  const codes = choices.records.filter((row) => !/error/i.test(row.label)).map((row) => row.value)
  const skipped = await sn.all<Record<string, string>>(
    { table: 'upgrade_history_task', query: `upgrade_detail.upgrade_history=${upgrade.sysId}^upgrade_detail.dispositionIN${codes.join(',')}`, fields: ['upgrade_detail.file_name'] },
    2_000,
  )
  const names = [...new Set(skipped.records.map((row) => row['upgrade_detail.file_name']).filter((name) => /^[A-Za-z0-9_.-]{1,250}$/.test(name ?? '')))]
  const answers = await mapLimit(names, 3, (updateName) => origin({ updateName }))
  table(`Files the last family upgrade (finished ${upgrade.finished}) skipped as customized`, answers, verdict)
  const agree = answers.filter((answer) => answer.verdict === 'customized').length
  console.log(`  sn_origin agrees with the upgrade engine on ${agree} of ${answers.length}.`)
  table('  of these, captured by', answers.filter((answer) => answer.verdict === 'customized'), (answer) => answer.capturedBy)
}

// 2. What the verdicts look like across the instance.
const files = await mapLimit(await randomRows('sys_metadata', 'sys_id', size), 3, (sysId) => origin({ sysId }))
table('Random application files', files, verdict)
table('Random application files, by kind of package', files.filter((answer) => answer.verdict), (answer) => `${answer.verdict}, ${answer.provenance}`)

const changes = await mapLimit(await randomRows('sys_update_xml', 'name', size), 3, (updateName) => (/^[A-Za-z0-9_.-]{1,250}$/.test(updateName) ? origin({ updateName }) : Promise.resolve({ error: 'name not usable' })))
table('Random captured changes', changes, verdict)
table('Random captured changes, by who captured them', changes.filter((answer) => answer.verdict), (answer) => `${answer.verdict}, ${answer.capturedBy}`)

console.log(`\n${sn.requestCount} requests, all GET.`)
process.exit(0)
