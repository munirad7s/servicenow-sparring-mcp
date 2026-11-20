#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { auditWriter } from './audit.js'
import { ServiceNowClient } from './client.js'
import { loadSettings } from './config.js'
import { runDoctor } from './doctor.js'
import { buildServer } from './server.js'
import { NAME, VERSION } from './version.js'

const USAGE = `${NAME} ${VERSION}: read-only MCP server for checking claims about ServiceNow against a live instance

Usage:
  ${NAME}             start the MCP server on stdio (this is what an MCP client runs)
  ${NAME} doctor      check the address, the login and what the account can read
  ${NAME} --version
  ${NAME} --help

Configuration (environment variables, or a file named by SERVICENOW_ENV_FILE):
  SERVICENOW_INSTANCE_URL    https://example.service-now.com
  SERVICENOW_USERNAME, SERVICENOW_PASSWORD, or SERVICENOW_TOKEN
  SERVICENOW_TABLE_ALLOW, SERVICENOW_TABLE_DENY, SERVICENOW_AUDIT_LOG, SERVICENOW_TIMEOUT_MS (optional)`

async function main() {
  const [command] = process.argv.slice(2)
  if (command === '--version' || command === '-v') return console.log(VERSION)
  if (command === '--help' || command === '-h') return console.log(USAGE)
  if (command === 'doctor') return runDoctor()
  if (command) throw new Error(`Unknown command "${command}". Try --help.`)

  const config = loadSettings()
  const sn = new ServiceNowClient(config, undefined, { audit: config.auditLog ? auditWriter(config.auditLog) : undefined })
  await buildServer(sn).connect(new StdioServerTransport())
  // stdout carries the protocol, so status goes to stderr.
  console.error(`${NAME} ${VERSION} ready: ${sn.host} (read-only)`)
}

main().catch((error) => {
  console.error(`${NAME}: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
})
