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
 *
 * With --sheet it prints one line per judged record instead, as CSV, for checking
 * the verdicts by hand: npm run --silent origin-check -- 25 --sheet > sheet.csv
 * That output names records of the instance. It is meant for the person who runs
 * it, not for publication.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ServiceNowClient } from './client.js'
import { loadSettings } from './config.js'
import { rawOf, tidy } from './result.js'
import { buildServer } from './server.js'
import { mapLimit } from './tools/shared.js'
import { recentUpgrades, skipCodes } from './tools/upgrade.js'

type Data = Record<string, any>

const args = process.argv.slice(2)
const sheet = args.includes('--sheet')
const size = Number(args.find((arg) => arg !== '--sheet') ?? 100)
if (!Number.isInteger(size) || size < 1 || size > 2_000) throw new Error('The sample size must be a whole number between 1 and 2000.')
// The sheet goes to standard output, so everything else goes to the error output.
const say = sheet ? console.error : console.log

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
  say(`\n${title}: ${answers.length}`)
  for (const [name, count] of [...counts].sort((a, b) => b[1] - a[1])) {
    say(`  ${String(count).padStart(5)}  ${((100 * count) / answers.length).toFixed(1).padStart(5)} %  ${name}`)
  }
}

/** One cell of the sheet. A text that a spreadsheet would read as a formula gets an apostrophe in front. */
const cell = (value: unknown) => {
  const text = String(value ?? '').replace(/\s+/g, ' ')
  return `"${(/^[=+\-@]/.test(text) ? `'${text}` : text).replaceAll('"', '""')}"`
}
const SHEET_COLUMNS = ['sample', 'table', 'name', 'update_name', 'sys_id', 'package', 'verdict', 'delivered_by', 'changed_here', 'created', 'captured_by', 'explanation', 'open', 'your_verdict', 'note']
function sheetLines(sample: string, answers: Data[]): string[] {
  return answers
    .filter((answer) => answer.verdict)
    .map((answer) => {
      const record: Data = answer.record ?? {}
      const open = record.table && record.sysId ? `https://${sn.host}/${record.table}.do?sys_id=${record.sysId}` : ''
      return [sample, record.table, record.name, record.updateName, record.sysId, record.package, answer.verdict, answer.provenance, answer.divergence, answer.created, answer.capturedBy, answer.explanation, open, '', '']
        .map(cell)
        .join(',')
    })
}
const lines: string[] = [SHEET_COLUMNS.join(',')]

const verdict = (answer: Data) => answer.verdict ?? `error: ${answer.error}`

/** Rows of a table at random positions. Each costs one request. */
async function randomRows(name: string, field: string, count: number): Promise<string[]> {
  const total = (await sn.query({ table: name, fields: ['sys_id'], limit: 1 })).total ?? 0
  const offsets = [...new Set(Array.from({ length: count }, () => Math.floor(Math.random() * total)))]
  const rows = await mapLimit(offsets, 4, (offset) => sn.query<Record<string, string>>({ table: name, fields: [field], limit: 1, offset }).then((page) => page.records[0]?.[field] ?? ''))
  return [...new Set(rows.filter(Boolean))]
}

say(`sn_origin on ${sn.host}`)

// 1. The upgrade engine as a second judge.
const upgrade = (await recentUpgrades(sn)).find((item) => item.kind === 'family')
if (!upgrade) {
  say('\nNo change of release family is recorded, so there is no upgrade to cross-check against.')
} else {
  // The codes sn_origin itself decides on: "not overwritten because it differs" without the files an upgrade could
  // not apply, and the review states that mean "set back to the vendor's version". Read from the instance, with the
  // built-in codes where it does not list them.
  const codes = await skipCodes(sn)
  const skipped = await sn.all<Record<string, string>>(
    { table: 'upgrade_history_task', query: `upgrade_detail.upgrade_history=${upgrade.sysId}^upgrade_detail.dispositionIN${[...codes.skipped].join(',')}`, fields: ['upgrade_detail.file_name', 'state'], display: true },
    2_000,
  )
  // A file that was reviewed and reverted is the vendor's again: sn_origin does not call it customized, and it is not counted here.
  const names = [
    ...new Set(
      skipped.records
        .map(tidy)
        .filter((row) => !codes.reverted.has(rawOf(row.state)))
        .map((row) => rawOf(row['upgrade_detail.file_name']))
        .filter((name) => /^[A-Za-z0-9_.-]{1,250}$/.test(name)),
    ),
  ]
  const answers = await mapLimit(names, 3, (updateName) => origin({ updateName }))
  table(`Files the last family upgrade (finished ${upgrade.finished}) skipped as customized`, answers, verdict)
  const agree = answers.filter((answer) => answer.verdict === 'customized').length
  say(`  sn_origin agrees with the upgrade engine on ${agree} of ${answers.length}.`)
  table('  of these, captured by', answers.filter((answer) => answer.verdict === 'customized'), (answer) => answer.capturedBy)
  lines.push(...sheetLines('skipped by the upgrade', answers.slice(0, size)))
}

// 2. What the verdicts look like across the instance.
const files = await mapLimit(await randomRows('sys_metadata', 'sys_id', size), 3, (sysId) => origin({ sysId }))
table('Random application files', files, verdict)
table('Random application files, by kind of package', files.filter((answer) => answer.verdict), (answer) => `${answer.verdict}, ${answer.provenance}`)
lines.push(...sheetLines('application file', files))

const changes = await mapLimit(await randomRows('sys_update_xml', 'name', size), 3, (updateName) => (/^[A-Za-z0-9_.-]{1,250}$/.test(updateName) ? origin({ updateName }) : Promise.resolve({ error: 'name not usable' })))
table('Random captured changes', changes, verdict)
table('Random captured changes, by who captured them', changes.filter((answer) => answer.verdict), (answer) => `${answer.verdict}, ${answer.capturedBy}`)
lines.push(...sheetLines('captured change', changes))

say(`\n${sn.requestCount} requests, all GET.`)
if (sheet) {
  console.log(lines.join('\n'))
  say(`\n${lines.length - 1} records on the sheet. It names records of this instance: keep it to yourself.`)
}
process.exit(0)
