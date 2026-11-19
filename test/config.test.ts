import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadConfig, loadEnvFile } from '../src/config.js'
import { ServiceNowError } from '../src/errors.js'

const base = { SERVICENOW_INSTANCE_URL: 'https://example.service-now.com', SERVICENOW_USERNAME: 'reader', SERVICENOW_PASSWORD: 'secret' }
const refused = (env: Record<string, string>) =>
  assert.throws(() => loadConfig(env), (error: unknown) => error instanceof ServiceNowError && error.kind === 'config')

test('reads a plain basic-auth configuration', () => {
  const config = loadConfig({ ...base, SERVICENOW_INSTANCE_URL: 'https://example.service-now.com/' })
  assert.equal(config.instanceUrl, 'https://example.service-now.com')
  assert.deepEqual(config.auth, { kind: 'basic', username: 'reader', password: 'secret' })
  assert.equal(config.timeoutMs, 30_000)
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
  refused({})
})

test('http is allowed for a local test server only', () => {
  assert.equal(loadConfig({ ...base, SERVICENOW_INSTANCE_URL: 'http://localhost:8080' }).instanceUrl, 'http://localhost:8080')
})

test('an env file fills gaps and never overrides the environment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sparring-'))
  writeFileSync(join(dir, 'instance.env'), 'SERVICENOW_USERNAME=from_file\nSERVICENOW_PASSWORD="pw with space"\n')
  const env: Record<string, string | undefined> = { SERVICENOW_ENV_FILE: 'instance.env', SERVICENOW_USERNAME: 'from_env' }

  assert.equal(loadEnvFile(env, dir), join(dir, 'instance.env'))
  assert.equal(env.SERVICENOW_USERNAME, 'from_env')
  assert.equal(env.SERVICENOW_PASSWORD, 'pw with space')
  assert.equal(loadEnvFile({}, dir), undefined)
  assert.throws(() => loadEnvFile({ SERVICENOW_ENV_FILE: 'missing.env' }, dir))
})
