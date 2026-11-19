import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const root = join(import.meta.dirname, '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const sourceFiles = (readdirSync(join(root, 'src'), { recursive: true }) as string[]).filter((path) => path.endsWith('.ts')).map((path) => join('src', path))

test('the source contains exactly one HTTP method, and it is GET', () => {
  const methods = sourceFiles.flatMap((path) => [...read(path).matchAll(/\bmethod\s*:\s*([^,}\n]+)/g)].map((match) => `${path}: ${match[1].trim()}`))
  assert.deepEqual(methods, ["src/client.ts: 'GET'"])
})

test('only the client talks to the network', () => {
  const callers = sourceFiles.filter((path) => /\bfetch\(/.test(read(path)))
  assert.deepEqual(callers.sort(), ['src/client.ts', 'src/smoke.ts'])
})

test('the repository carries no private data', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((path) => /\.(ts|js|json|md|yml|yaml|txt|example)$|^\.gitignore$|^LICENSE$/.test(path) && path !== 'package-lock.json')

  const findings: string[] = []
  for (const path of tracked) {
    const text = read(path)
    for (const host of text.match(/[a-z0-9-]+\.service-now\.com/gi) ?? []) {
      if (host !== 'example.service-now.com') findings.push(`${path}: instance host ${host}`)
    }
    for (const local of text.match(/(?:\/home\/|\/Users\/|[A-Z]:\\Users\\)[\w.-]+/g) ?? []) findings.push(`${path}: local path ${local}`)
    // URLs are taken out first: a test URL with credentials in it is not a mail address.
    const withoutUrls = text.replace(/[a-z+]+:\/\/[^\s'"`)]+/gi, '')
    for (const mail of withoutUrls.match(/[\w.+-]+@[\w-]+\.[a-z]{2,}/gi) ?? []) findings.push(`${path}: mail address ${mail}`)
    if (/co-authored-by|generated with/i.test(text) && path !== 'test/repo.test.ts') findings.push(`${path}: authorship trailer`)
  }
  assert.deepEqual(findings, [])
})
