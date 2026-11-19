#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ServiceNowClient } from './client.js'
import { loadConfig, loadEnvFile } from './config.js'
import { buildServer, NAME } from './server.js'

async function main() {
  loadEnvFile()
  const sn = new ServiceNowClient(loadConfig())
  await buildServer(sn).connect(new StdioServerTransport())
  // stdout carries the protocol, so status goes to stderr.
  console.error(`${NAME} ready: ${sn.host} (read-only)`)
}

main().catch((error) => {
  console.error(`${NAME} failed to start: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
})
