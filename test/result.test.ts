import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Page } from '../src/client.js'
import { ServiceNowError, validation } from '../src/errors.js'
import { clip, fail, listing, redact, tally, tidy } from '../src/result.js'
import { fakeInstance } from './fake.js'

const { sn } = fakeInstance([])
const page = (records: unknown[], total: number | null, limit = 20, offset = 0): Page<unknown> => ({ table: 'incident', query: '', limit, offset, records, total })
const rows = (count: number, size: number) => Array.from({ length: count }, (_, index) => ({ number: `INC${index}`, script: 'x'.repeat(size) }))

test('a page that fits is described as it is', () => {
  const warnings: string[] = []
  const answer = listing(sn, page(rows(20, 10), 100), warnings)
  assert.deepEqual({ returned: answer.returned, truncated: answer.truncated, nextOffset: answer.nextOffset }, { returned: 20, truncated: true, nextOffset: 20 })
  assert.deepEqual(warnings, [])

  const last = listing(sn, page(rows(5, 10), 25, 20, 20))
  assert.deepEqual({ returned: last.returned, truncated: last.truncated, nextOffset: last.nextOffset }, { returned: 5, truncated: false, nextOffset: undefined })
})

test('long values are cut before rows are dropped, and the answer says so', () => {
  const warnings: string[] = []
  const fetched = rows(20, 10_000)
  const shown = clip(fetched, warnings)

  assert.equal(shown.length, 20, 'all rows are still there')
  assert.ok(JSON.stringify(shown).length < 70_000)
  assert.match(shown[0].script, /\[cut here: \d+ more characters\]$/)
  assert.match(warnings.join(' '), /20 long value\(s\) were cut/)
  assert.equal(fetched[0].script.length, 10_000, 'the input is not changed')
})

test('one huge value cannot flood the answer, even as the only row', () => {
  const warnings: string[] = []
  const shown = clip([{ payload: 'x'.repeat(400_000) }], warnings)
  assert.ok(JSON.stringify(shown).length < 70_000)
  assert.match(warnings.join(' '), /cannot be read completely/)
})

test('when rows are dropped, reading on continues right behind the last row shown', () => {
  const warnings: string[] = []
  const fetched = Array.from({ length: 200 }, (_, index) => ({ number: `INC${index}`, text: 'y'.repeat(1_500) }))
  const shown = clip(fetched, warnings)
  assert.ok(shown.length > 0 && shown.length < 200)

  const answer = listing(sn, page(fetched, 200, 200), warnings, shown.length)
  assert.equal(answer.returned, shown.length)
  assert.equal(answer.truncated, true, 'also when the page itself was the last one')
  assert.equal(answer.nextOffset, shown.length)
  assert.match(warnings.join(' '), new RegExp(`Only the first ${shown.length} of 200 fetched rows`))
})

test('rows withheld by access rules are counted', () => {
  const warnings: string[] = []
  const answer = listing(sn, page(rows(1, 10), 5, 5), warnings)
  assert.equal(answer.total, 5)
  assert.equal(answer.returned, 1)
  assert.match(warnings.join(' '), /4 matching row\(s\)/)
})

test('a page that was both cut and thinned by access rules warns that rows can repeat', () => {
  const warnings: string[] = []
  const answer = listing(sn, page(rows(10, 10), 20, 20), warnings, 5)
  assert.equal(answer.nextOffset, 5)
  assert.match(warnings.join(' '), /10 matching row\(s\)/)
  assert.match(warnings.join(' '), /can repeat a few rows/)
})

test('without a total, a full page means "there may be more"', () => {
  const full = listing(sn, page(rows(20, 10), null, 20))
  assert.deepEqual({ truncated: full.truncated, nextOffset: full.nextOffset }, { truncated: true, nextOffset: 20 })
  const short = listing(sn, page(rows(5, 10), null, 20))
  assert.deepEqual({ truncated: short.truncated, nextOffset: short.nextOffset }, { truncated: false, nextOffset: undefined })
})

test('display values are kept where they say more than the stored value', () => {
  const tidied = tidy({
    state: { value: '6', display_value: 'Resolved' },
    number: { value: 'INC1', display_value: 'INC1' },
    opened_at: { value: '2026-03-01 08:00:00', display_value: '2026-03-01 09:00:00' },
    business_duration: { value: '1970-01-01 01:30:00', display_value: '1 Hour 30 Minutes' },
    empty: { value: '', display_value: '' },
    plain: 'x',
  })
  assert.deepEqual(tidied, {
    state: { value: '6', display: 'Resolved' },
    number: 'INC1',
    opened_at: '2026-03-01 08:00:00',
    business_duration: { value: '1970-01-01 01:30:00', display: '1 Hour 30 Minutes' },
    empty: '',
    plain: 'x',
  })
})

test('counting by name is safe for names that objects already have', () => {
  assert.deepEqual(tally([{ type: 'constructor' }, { type: 'toString' }, { type: 'constructor' }, { type: '' }], (item) => item.type), {
    constructor: 2,
    toString: 1,
    unknown: 1,
  })
})

test('secret fields are replaced, empty ones are left empty', () => {
  assert.deepEqual(redact({ name: 'a', password: 'hash', token: '' }, new Set(['password', 'token']), '[withheld]'), { name: 'a', password: '[withheld]', token: '' })
})

test('an error is an answer with a kind and a next step', () => {
  const text = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text)

  const acl = fail(new ServiceNowError('no', 'acl', 'sys_store_app', 403))
  assert.equal(acl.isError, true)
  assert.equal(text(acl).table, 'sys_store_app')
  assert.match(text(acl).hint, /could not be checked/)

  // A refused input names no table it never asked.
  assert.equal(text(fail(validation('Give sysId or updateName.'), 'sys_metadata')).table, undefined)
  assert.match(text(fail(new ServiceNowError('x', 'redirect'))).hint, /single sign-on/)
  assert.match(text(fail(new ServiceNowError('x', 'too_large'))).hint, /fewer fields/)
  assert.match(text(fail(new ServiceNowError('x', 'blocked', 'sys_user'))).hint, /could not be checked/)
  // Measured: the Aggregate API refuses to count by some fields. The table is readable, the field is the reason.
  const field = fail(new ServiceNowError('example.service-now.com answered HTTP 403: "Insufficient rights to query records" ("Field(s) present in the query do not have permission to be read").', 'acl', 'sys_metadata', 403))
  assert.match(text(field).hint, /because of a field in it.*"sys_metadata" itself may be readable.*could not be checked/)
  assert.equal(text(fail(new Error('y'.repeat(5_000)))).message.length, 1_001)
})
