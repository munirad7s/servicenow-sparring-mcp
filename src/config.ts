import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { ServiceNowError } from './errors.js'

export type Auth =
  | { kind: 'basic'; username: string; password: string }
  | { kind: 'bearer'; token: string }

export interface InstanceConfig {
  /** Origin only, for example https://example.service-now.com */
  instanceUrl: string
  auth: Auth
  timeoutMs: number
  maxResponseBytes: number
}

type Env = Record<string, string | undefined>

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024

const fail = (message: string) => new ServiceNowError(message, 'config')

/**
 * Reads an optional env file into the environment. Variables that are already
 * set win, so an MCP client's own "env" block always has the last word.
 */
export function loadEnvFile(env: Env = process.env, cwd: string = process.cwd()): string | undefined {
  const explicit = env.SERVICENOW_ENV_FILE
  const path = explicit ? resolve(cwd, explicit) : resolve(cwd, '.env')

  if (!existsSync(path)) {
    if (explicit) throw fail(`SERVICENOW_ENV_FILE points to "${path}", which does not exist.`)
    return undefined
  }

  for (const [key, value] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) {
    if (env[key] === undefined) env[key] = value
  }
  return path
}

export function loadConfig(env: Env = process.env): InstanceConfig {
  const rawUrl = env.SERVICENOW_INSTANCE_URL?.trim()
  if (!rawUrl) throw fail('SERVICENOW_INSTANCE_URL is not set. Example: https://example.service-now.com')

  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw fail(`SERVICENOW_INSTANCE_URL is not a URL: "${rawUrl}"`)
  }

  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw fail('SERVICENOW_INSTANCE_URL must use https, because the credentials travel with every request.')
  }
  if (url.username || url.password) {
    throw fail('Do not put credentials into SERVICENOW_INSTANCE_URL. Use SERVICENOW_USERNAME and SERVICENOW_PASSWORD.')
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw fail('SERVICENOW_INSTANCE_URL must be the bare instance address, without a path or query.')
  }

  return {
    instanceUrl: url.origin,
    auth: readAuth(env),
    timeoutMs: readTimeout(env.SERVICENOW_TIMEOUT_MS),
    maxResponseBytes: MAX_RESPONSE_BYTES,
  }
}

function readAuth(env: Env): Auth {
  const token = env.SERVICENOW_TOKEN?.trim()
  if (token) return { kind: 'bearer', token }

  const username = env.SERVICENOW_USERNAME?.trim()
  const password = env.SERVICENOW_PASSWORD
  if (username && password) return { kind: 'basic', username, password }

  if (username) throw fail('SERVICENOW_PASSWORD is not set.')
  throw fail('No credentials. Set SERVICENOW_USERNAME and SERVICENOW_PASSWORD, or SERVICENOW_TOKEN.')
}

function readTimeout(raw: string | undefined): number {
  if (!raw) return DEFAULT_TIMEOUT_MS
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1_000 || value > 120_000) {
    throw fail('SERVICENOW_TIMEOUT_MS must be a whole number between 1000 and 120000.')
  }
  return value
}
