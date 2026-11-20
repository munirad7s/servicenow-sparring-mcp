import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { test } from 'node:test'
import { auditWriter } from '../src/audit.js'
import { fakeInstance } from './fake.js'

/** The log is written in the background: wait for it, instead of guessing how long a slow machine takes. */
async function until(done: () => boolean, timeoutMs = 5_000) {
  const end = Date.now() + timeoutMs
  while (!done() && Date.now() < end) await wait(10)
}

test('the audit log gets one line per request, readable by its owner only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sparring-audit-'))
  try {
    const path = join(dir, 'audit.jsonl')
    const { sn } = fakeInstance([{ table: 'incident', rows: [{ number: 'INC1' }] }], {}, auditWriter(path))
    await sn.query({ table: 'incident', query: 'active=true' })
    await sn.query({ table: 'incident' })
    await until(() => existsSync(path) && readFileSync(path, 'utf8').trim().split('\n').length === 2)

    const lines = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(lines.length, 2)
    assert.deepEqual({ ...lines[0], time: '', ms: 0 }, { time: '', tool: null, api: 'table', table: 'incident', query: 'active=true', fields: null, status: 200, sent: 1, rows: 1, total: 1, ms: 0 })
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the lines of the audit log stand in the order of the requests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sparring-audit-'))
  try {
    const path = join(dir, 'audit.jsonl')
    // Three hundred lines handed over at once, of very different length: written each on its own, they would overtake one another.
    const write = auditWriter(path)
    const entry = (index: number) => ({ time: '', tool: null, api: 'table' as const, table: 'incident', query: `priority=${index}^${'x'.repeat((index % 7) * 3_000)}`, fields: null, status: 200, sent: 1, rows: 0, total: 0, ms: 0 })
    for (let index = 0; index < 300; index++) write(entry(index))
    await until(() => existsSync(path) && readFileSync(path, 'utf8').trim().split('\n').length === 300)

    const order = readFileSync(path, 'utf8').trim().split('\n').map((line) => Number(/^priority=(\d+)/.exec(JSON.parse(line).query)?.[1]))
    assert.deepEqual(order, Array.from({ length: 300 }, (_, index) => index))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a log that cannot be written is reported once and breaks nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sparring-audit-'))
  try {
    const reports: string[] = []
    const { sn } = fakeInstance([{ table: 'incident', rows: [] }], {}, auditWriter(join(dir, 'no-such-folder', 'audit.jsonl'), (message) => reports.push(message)))
    await sn.query({ table: 'incident' })
    await sn.query({ table: 'incident' })
    await until(() => reports.length > 0)
    await wait(50)

    assert.equal(reports.length, 1)
    assert.match(reports[0], /cannot write to/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
