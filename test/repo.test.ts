import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { VERSION } from '../src/version.js'

const root = join(import.meta.dirname, '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const posix = (path: string) => path.replaceAll('\\', '/')

/** Every file under a folder, with forward slashes on every platform. */
const walk = (folder: string): string[] =>
  (readdirSync(join(root, folder), { recursive: true }) as string[]).map((path) => posix(join(folder, path))).filter((path) => statSync(join(root, path)).isFile())

const sourceFiles = walk('src').filter((path) => path.endsWith('.ts'))
const TEXT = /\.(ts|js|json|md|yml|yaml|txt|example)$|^\.gitignore$|^LICENSE$/

/** The files that are published. From git where there is a checkout, from the folders otherwise. */
function trackedFiles(): string[] {
  if (existsSync(join(root, '.git'))) {
    return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean).map(posix)
  }
  const top = readdirSync(root).filter((name) => !['node_modules', 'dist', '.git'].includes(name))
  return top.flatMap((name) => (statSync(join(root, name)).isDirectory() ? walk(name) : [name]))
}
const textFiles = trackedFiles().filter((path) => TEXT.test(path) && path !== 'package-lock.json' && existsSync(join(root, path)))

// These three tests guard against a change that breaks the promise by accident. They read the source as text
// and can be got around on purpose; the test in tools.test.ts that records every request is the second line.

test('the source contains exactly one HTTP method, and it is GET', () => {
  const methods = sourceFiles.flatMap((path) => [...read(path).matchAll(/\bmethod\s*:\s*([^,}\n]+)/g)].map((match) => `${path}: ${match[1].trim()}`))
  assert.deepEqual(methods, ["src/client.ts: 'GET'"])

  // Other ways to name a method: a quoted verb, a quoted key, an assignment, a shorthand property, a Request object.
  const otherways = /['"`](POST|PUT|PATCH)['"`]|['"`]method['"`]\s*:|\.method\s*=|[{,]\s*method\s*[,}]|\bnew\s+Request\s*\(/
  assert.deepEqual(sourceFiles.filter((path) => otherways.test(read(path))), [])
})

test('only the client talks to the network, and only through fetch', () => {
  const callers = sourceFiles.filter((path) => /\bfetch\b/.test(read(path).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')))
  assert.deepEqual(callers.sort(), ['src/client.ts', 'src/smoke.ts'])

  const otherWays =
    /['"`](node:)?(http|https|http2|net|tls|dgram|dns|child_process|worker_threads|cluster|vm|inspector)['"`]|['"`]undici['"`]|sdk\/client\/(sse|streamableHttp|stdio|websocket)|XMLHttpRequest|WebSocket|EventSource|\beval\s*\(|\bFunction\s*\(|\bimport\s*\(|\brequire\s*\(/
  assert.deepEqual(sourceFiles.filter((path) => otherWays.test(read(path))), [])
})

test('the only file the server writes is the audit log', () => {
  const usesFiles = sourceFiles.filter((path) => /['"`](node:)?fs(\/promises)?['"`]/.test(read(path))).sort()
  assert.deepEqual(usesFiles, ['src/audit.ts', 'src/config.ts'])
  assert.match(read('src/audit.ts'), /^import \{ appendFile \} from 'node:fs\/promises'$/m)
  assert.match(read('src/config.ts'), /^import \{ readFileSync, statSync \} from 'node:fs'$/m)
})

test('the version is the same everywhere', () => {
  assert.equal(VERSION, JSON.parse(read('package.json')).version)
  assert.match(read('CHANGELOG.md'), new RegExp(`^## ${VERSION.replaceAll('.', '\\.')} `, 'm'))
})

test('the README names every function the server has, and no other', () => {
  const registered = sourceFiles.flatMap((path) => [...read(path).matchAll(/registerTool\(\s*'(sn_[a-z_]+)'/g)].map((match) => match[1])).sort()
  const documented = [...new Set([...read('README.md').matchAll(/^\| `(sn_[a-z_]+)` \|/gm)].map((match) => match[1]))].sort()
  assert.equal(registered.length, 8)
  assert.deepEqual(documented, registered)
})

test('no scratch file is published', () => {
  assert.deepEqual(trackedFiles().filter((path) => /(^|\/)_[^/]*$/.test(path)), [])
})

test('the repository carries no private data', () => {
  const findings: string[] = []
  for (const path of textFiles) {
    const text = read(path)
    for (const host of text.match(/[a-z0-9-]+\.service-now\.com/gi) ?? []) {
      if (host !== 'example.service-now.com') findings.push(`${path}: instance host ${host}`)
    }
    for (const local of text.match(/(?:\/home\/|\/Users\/|[A-Z]:\\Users\\)[\w.-]+/g) ?? []) findings.push(`${path}: local path ${local}`)
    // URLs are taken out first: a test URL with credentials in it is not a mail address.
    const withoutUrls = text.replace(/[a-z+]+:\/\/[^\s'"`)]+/gi, '')
    for (const mail of withoutUrls.match(/[\w.+-]+@[\w-]+\.[a-z]{2,}/gi) ?? []) {
      if (!/@example\.(org|com)$|@snc\.maint$/i.test(mail)) findings.push(`${path}: mail address ${mail}`)
    }
    if (/co-authored-by|generated with/i.test(text) && path !== 'test/repo.test.ts') findings.push(`${path}: authorship trailer`)
  }
  assert.deepEqual(findings, [])
})

test('no file hides characters a reader cannot see', () => {
  // Zero-width and direction-changing characters, a byte-order mark, a no-break space: none belongs in source or docs.
  const hidden = new RegExp(`[${[0xa0, 0xad, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff].map((code) => String.fromCharCode(code)).join('')}]`)
  assert.deepEqual(textFiles.filter((path) => hidden.test(read(path))), [])
})
