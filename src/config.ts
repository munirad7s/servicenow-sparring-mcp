import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
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
  /** Tables the server may ask for on this machine. An empty allow list means every table. deny always wins. */
  tables: { allow: string[]; deny: string[] }
  /** File that receives one line per request. */
  auditLog?: string
  /** The env file the settings came from, if any. */
  envFile?: string
  /** Reads the credentials again, for a token that was renewed in the env file. */
  reloadAuth?: () => Auth | undefined
}

type Env = Record<string, string | undefined>

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024
const MAX_ENV_FILE_BYTES = 64 * 1024
const PREFIX = 'SERVICENOW_'

const fail = (message: string) => new ServiceNowError(message, 'config')

/**
 * Reads the settings from the environment and, if one is named, from an env file.
 *
 * The environment wins over the file, so an MCP client's own "env" block has the
 * last word. Only SERVICENOW_* keys are taken from a file, and nothing is written
 * back to the process environment: a stray file can never switch off certificate
 * checks or set a proxy.
 *
 * A ".env" in the working directory is read only when the caller asks for it (the
 * npm scripts do) and only when no SERVICENOW_* variable is set. The server itself
 * never reads it: an MCP client may start the server inside any project folder.
 */
export function loadSettings(env: Env = process.env, cwd: string = process.cwd(), options: { cwdFile?: boolean } = {}): InstanceConfig {
  const fromEnvironment = pick(env)
  const explicit = expandHome(fromEnvironment.SERVICENOW_ENV_FILE)
  delete fromEnvironment.SERVICENOW_ENV_FILE

  let file: string | undefined
  if (explicit) {
    file = resolve(cwd, explicit)
    if (!isReadableFile(file)) throw fail(`SERVICENOW_ENV_FILE points to "${file}", which is not a readable file.`)
  } else if (options.cwdFile && Object.keys(fromEnvironment).length === 0 && isReadableFile(resolve(cwd, '.env'))) {
    file = resolve(cwd, '.env')
  }

  const merged = (): Env => ({ ...(file ? readEnvFile(file) : {}), ...fromEnvironment })
  const config = loadConfig(merged())
  if (!file) return config

  return {
    ...config,
    envFile: file,
    reloadAuth: () => {
      try {
        return readAuth(merged())
      } catch {
        return undefined
      }
    },
  }
}

/** Builds the configuration from a set of variables. Reads no file. */
export function loadConfig(env: Env): InstanceConfig {
  const rawUrl = env.SERVICENOW_INSTANCE_URL?.trim()
  if (!rawUrl) {
    throw fail(
      'SERVICENOW_INSTANCE_URL is not set. Set the SERVICENOW_* variables where the server is started (for an MCP ' +
        'client: in its "env" block), or set SERVICENOW_ENV_FILE to the absolute path of an env file.',
    )
  }

  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    // The value is not repeated: a mistyped address can contain a password.
    throw fail('SERVICENOW_INSTANCE_URL is not a URL. Example: https://example.service-now.com')
  }

  if (url.username || url.password) {
    throw fail('Do not put credentials into SERVICENOW_INSTANCE_URL. Use SERVICENOW_USERNAME and SERVICENOW_PASSWORD.')
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw fail('SERVICENOW_INSTANCE_URL must use https, because the credentials travel with every request.')
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw fail('SERVICENOW_INSTANCE_URL must be the bare instance address, without a path or query.')
  }

  const auditLog = expandHome(env.SERVICENOW_AUDIT_LOG?.trim())
  return {
    instanceUrl: url.origin,
    auth: readAuth(env),
    timeoutMs: readTimeout(env.SERVICENOW_TIMEOUT_MS),
    maxResponseBytes: MAX_RESPONSE_BYTES,
    tables: { allow: readPatterns(env, 'SERVICENOW_TABLE_ALLOW'), deny: readPatterns(env, 'SERVICENOW_TABLE_DENY') },
    ...(auditLog ? { auditLog: resolve(auditLog) } : {}),
  }
}

function readAuth(env: Env): Auth {
  const token = env.SERVICENOW_TOKEN?.trim()
  if (token) {
    // A token goes into a header as it is. Anything but printable ASCII would make the request fail with the token in the message.
    if (!/^[\x21-\x7e]+$/.test(token)) throw fail('SERVICENOW_TOKEN contains spaces, line breaks or other characters a token cannot have.')
    return { kind: 'bearer', token }
  }

  const username = env.SERVICENOW_USERNAME?.trim()
  const password = env.SERVICENOW_PASSWORD
  if (username && password) {
    if (/[\u0000-\u001f\u007f]/.test(username + password) || username.includes(':')) {
      throw fail('SERVICENOW_USERNAME or SERVICENOW_PASSWORD contains a line break or control character, or the user name contains a colon.')
    }
    return { kind: 'basic', username, password }
  }

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

/** A list of table names. A name may end with * to cover every table that starts with it. */
function readPatterns(env: Env, key: string): string[] {
  const patterns = (env[key] ?? '').split(/[\s,]+/).filter(Boolean)
  const bad = patterns.find((pattern) => !/^[a-z0-9_]{1,80}\*?$/.test(pattern))
  if (bad) throw fail(`${key} contains "${bad.slice(0, 80)}", which is not a table name. Use names like sys_script, or a prefix like sys_*.`)
  return patterns
}

/** The SERVICENOW_* variables that have a value. An empty variable counts as not set. */
function pick(env: Env): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[0].startsWith(PREFIX) && typeof entry[1] === 'string' && entry[1].trim() !== ''),
  )
}

function readEnvFile(path: string): Record<string, string> {
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
  // A SERVICENOW_ENV_FILE inside the file is not followed: the file to read is named by the environment alone.
  return pick(parseEnv(text) as Env)
}

function isReadableFile(path: string): boolean {
  try {
    const stats = statSync(path)
    if (!stats.isFile()) return false
    if (stats.size > MAX_ENV_FILE_BYTES) throw fail(`"${path}" is larger than ${MAX_ENV_FILE_BYTES} bytes. That is not an env file.`)
    return true
  } catch (error) {
    if (error instanceof ServiceNowError) throw error
    return false
  }
}

function expandHome(path: string | undefined): string | undefined {
  if (!path) return undefined
  const trimmed = path.trim()
  if (trimmed === '~') return homedir()
  return /^~[\\/]/.test(trimmed) ? join(homedir(), trimmed.slice(2)) : trimmed
}
