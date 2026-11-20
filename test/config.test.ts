import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { loadConfig, loadSettings } from '../src/config.js'
import { ServiceNowError } from '../src/errors.js'

const base = { SERVICENOW_INSTANCE_URL: 'https://example.service-now.com', SERVICENOW_USERNAME: 'reader', SERVICENOW_PASSWORD: 'secret' }
const isConfigError = (error: unknown) => error instanceof ServiceNowError && error.kind === 'config'
const refused = (env: Record<string, string>) => assert.throws(() => loadConfig(env), isConfigError)

function folderWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'sparring-'))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  return dir
}

test('reads a plain basic-auth configuration', () => {
  const config = loadConfig({ ...base, SERVICENOW_INSTANCE_URL: 'https://example.service-now.com/' })
  assert.equal(config.instanceUrl, 'https://example.service-now.com')
  assert.deepEqual(config.auth, { kind: 'basic', username: 'reader', password: 'secret' })
  assert.equal(config.timeoutMs, 30_000)
  assert.deepEqual(config.tables, { allow: [], deny: [] })
  assert.equal(config.auditLog, undefined)
})

test('a token wins over user name and password', () => {
  assert.deepEqual(loadConfig({ ...base, SERVICENOW_TOKEN: 'abc' }).auth, { kind: 'bearer', token: 'abc' })
})

test('refuses unsafe or incomplete configuration', () => {
  refused({ ...base, SERVICENOW_INSTANCE_URL: 'http://example.service-now.com' })
  refused({ ...base, SERVICENOW_INSTANCE_URL: 'https://user:pw@example.service-now.com' })
  refused({ ...base, SERVICENOW_INSTANCE_URL: 'https://example.service-now.com/api/now' })
  refused({ ...base, SERVICENOW_INSTANCE_URL: 'not a url' })
  refused({ SERVICENOW_INSTANCE_URL: base.SERVICENOW_INSTANCE_URL })
  refused({ SERVICENOW_INSTANCE_URL: base.SERVICENOW_INSTANCE_URL, SERVICENOW_USERNAME: 'reader' })
  refused({ ...base, SERVICENOW_TIMEOUT_MS: '5' })
  refused({ ...base, SERVICENOW_TABLE_DENY: 'sys_user, ../x' })
  refused({ ...base, SERVICENOW_TABLE_ALLOW: 'Incident' })
  refused({})
  // Each says what is missing: a user name alone lacks its password, and nothing at all lacks credentials.
  assert.throws(() => loadConfig({ SERVICENOW_INSTANCE_URL: base.SERVICENOW_INSTANCE_URL, SERVICENOW_USERNAME: 'reader' }), /SERVICENOW_PASSWORD is not set/)
  assert.throws(() => loadConfig({ SERVICENOW_INSTANCE_URL: base.SERVICENOW_INSTANCE_URL }), /No credentials/)
})

test('http is allowed for a local test server only', () => {
  assert.equal(loadConfig({ ...base, SERVICENOW_INSTANCE_URL: 'http://localhost:8080' }).instanceUrl, 'http://localhost:8080')
  assert.equal(loadConfig({ ...base, SERVICENOW_INSTANCE_URL: 'http://127.0.0.1:8080' }).instanceUrl, 'http://127.0.0.1:8080')
  refused({ ...base, SERVICENOW_INSTANCE_URL: 'http://localhost.example.org' })
})

test('a mistyped address is not repeated, because it can contain a password', () => {
  assert.throws(
    () => loadConfig({ ...base, SERVICENOW_INSTANCE_URL: 'https://reader:hunter2@my instance.example.org' }),
    (error: unknown) => isConfigError(error) && !/hunter2/.test((error as Error).message),
  )
})

test('a token or password that would break the request header is refused without being shown', () => {
  const shown = (env: Record<string, string>) => {
    try {
      loadConfig(env)
    } catch (error) {
      return (error as Error).message
    }
    return 'accepted'
  }
  assert.doesNotMatch(shown({ ...base, SERVICENOW_TOKEN: 'part-one\npart-two' }), /part-one|accepted/)
  assert.doesNotMatch(shown({ ...base, SERVICENOW_TOKEN: 'has space' }), /has space|accepted/)
  assert.doesNotMatch(shown({ ...base, SERVICENOW_PASSWORD: 'zzzfirst\nzzzsecond' }), /zzz|accepted/)
})

test('table lists accept names and prefixes', () => {
  const config = loadConfig({ ...base, SERVICENOW_TABLE_ALLOW: 'sys_*, v_plugin\nupgrade_history_task', SERVICENOW_TABLE_DENY: 'sys_user' })
  assert.deepEqual(config.tables, { allow: ['sys_*', 'v_plugin', 'upgrade_history_task'], deny: ['sys_user'] })
})

test('an env file fills gaps, and the environment has the last word', () => {
  const dir = folderWith({ 'instance.env': `SERVICENOW_INSTANCE_URL=${base.SERVICENOW_INSTANCE_URL}\nSERVICENOW_USERNAME=from_file\nSERVICENOW_PASSWORD="pw with space"\n` })
  const config = loadSettings({ SERVICENOW_ENV_FILE: 'instance.env', SERVICENOW_USERNAME: 'from_env' }, dir)

  assert.deepEqual(config.auth, { kind: 'basic', username: 'from_env', password: 'pw with space' })
  assert.equal(config.envFile, join(dir, 'instance.env'))
})

test('an empty variable counts as not set', () => {
  const dir = folderWith({ 'instance.env': 'SERVICENOW_USERNAME=from_file\nSERVICENOW_PASSWORD=from_file\n' })
  const config = loadSettings({ ...base, SERVICENOW_USERNAME: '', SERVICENOW_PASSWORD: '', SERVICENOW_ENV_FILE: 'instance.env' }, dir)
  assert.deepEqual(config.auth, { kind: 'basic', username: 'from_file', password: 'from_file' })
})

test('only SERVICENOW_ variables are taken from a file, and the process environment is left alone', () => {
  const dir = folderWith({ 'instance.env': `${Object.entries(base).map(([key, value]) => `${key}=${value}`).join('\n')}\nNODE_TLS_REJECT_UNAUTHORIZED=0\nHTTPS_PROXY=http://elsewhere.example\n` })
  const env: Record<string, string | undefined> = { SERVICENOW_ENV_FILE: 'instance.env' }
  const before = { ...process.env }

  loadSettings(env, dir)
  assert.deepEqual(Object.keys(env), ['SERVICENOW_ENV_FILE'])
  assert.deepEqual({ ...process.env }, before)
})

test('a missing, oversized or non-regular env file is an error', () => {
  const dir = folderWith({ 'huge.env': 'A=1\n'.repeat(40_000) })
  mkdirSync(join(dir, 'folder.env'))
  for (const name of ['missing.env', 'huge.env', 'folder.env']) {
    assert.throws(() => loadSettings({ ...base, SERVICENOW_ENV_FILE: name }, dir), isConfigError, name)
  }
})

test('a file saved with a byte-order mark still works', () => {
  const dir = folderWith({ 'instance.env': `${String.fromCharCode(0xfeff)}SERVICENOW_INSTANCE_URL=${base.SERVICENOW_INSTANCE_URL}\nSERVICENOW_TOKEN=abc\n` })
  assert.equal(loadSettings({ SERVICENOW_ENV_FILE: 'instance.env' }, dir).instanceUrl, base.SERVICENOW_INSTANCE_URL)
})

test('"~" in a path means the home folder', () => {
  const dir = mkdtempSync(join(homedir(), '.sparring-test-'))
  try {
    writeFileSync(join(dir, 'instance.env'), `SERVICENOW_INSTANCE_URL=${base.SERVICENOW_INSTANCE_URL}\nSERVICENOW_TOKEN=abc\n`)
    const config = loadSettings({ SERVICENOW_ENV_FILE: `~/${relative(homedir(), dir)}/instance.env`, SERVICENOW_AUDIT_LOG: '~/sparring-audit.jsonl' }, tmpdir())
    assert.equal(config.envFile, join(dir, 'instance.env'))
    assert.equal(config.auditLog, join(homedir(), 'sparring-audit.jsonl'))
  } finally {
    // The folder holds one small file made by this test.
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the server never picks up a ".env" from the folder it is started in', () => {
  const dir = folderWith({ '.env': `SERVICENOW_INSTANCE_URL=https://elsewhere.example\nSERVICENOW_TOKEN=theirs\n` })

  // Started by an MCP client inside some project folder: nothing is read.
  assert.throws(() => loadSettings({}, dir), isConfigError)
  // Even with credentials in the environment, a stray file cannot supply the address they are sent to.
  assert.throws(() => loadSettings({ SERVICENOW_USERNAME: 'reader', SERVICENOW_PASSWORD: 'secret' }, dir, { cwdFile: true }), isConfigError)
  // The npm scripts, run by a person in a folder they chose, may use it when nothing else is set.
  assert.equal(loadSettings({}, dir, { cwdFile: true }).instanceUrl, 'https://elsewhere.example')
})

test('a renewed token is read again from the env file', () => {
  const dir = folderWith({ 'instance.env': `SERVICENOW_INSTANCE_URL=${base.SERVICENOW_INSTANCE_URL}\nSERVICENOW_TOKEN=first\n` })
  const config = loadSettings({ SERVICENOW_ENV_FILE: 'instance.env' }, dir)
  assert.deepEqual(config.auth, { kind: 'bearer', token: 'first' })

  writeFileSync(join(dir, 'instance.env'), `SERVICENOW_INSTANCE_URL=${base.SERVICENOW_INSTANCE_URL}\nSERVICENOW_TOKEN=second\n`)
  assert.deepEqual(config.reloadAuth?.(), { kind: 'bearer', token: 'second' })
  assert.equal(loadConfig(base).reloadAuth, undefined)
})
