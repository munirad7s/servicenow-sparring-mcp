/**
 * Calls one tool from the shell and prints what an agent would receive:
 *
 *   npm run call                                        lists the tools
 *   npm run call -- sn_instance
 *   npm run call -- sn_query '{"table":"sys_db_object","query":"name=incident"}'
 *
 * The call goes through the real MCP server over an in-memory transport. It only reads.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ServiceNowClient } from './client.js'
import { loadSettings } from './config.js'
import { buildServer } from './server.js'

async function main() {
  const [name, json = '{}'] = process.argv.slice(2)

  let args: Record<string, unknown>
  try {
    args = JSON.parse(json)
  } catch {
    throw new Error(`The arguments are not JSON: ${json}`)
  }

  const sn = new ServiceNowClient(loadSettings(process.env, process.cwd(), { cwdFile: true }))
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'call', version: '1.0.0' })
  await Promise.all([client.connect(clientTransport), buildServer(sn).connect(serverTransport)])

  if (!name) {
    const { tools } = await client.listTools()
    for (const tool of tools) console.log(`${tool.name.padEnd(18)} ${tool.title ?? ''}`)
    return
  }

  const result = await client.callTool({ name, arguments: args })
  const text = (result.content as Array<{ text?: string }>)[0]?.text ?? ''
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2))
  } catch {
    console.log(text)
  }
  console.error(`\n${sn.requestCount} request(s) to ${sn.host}, all GET.`)
  if (result.isError) process.exitCode = 1
}

main().catch((error) => {
  console.error(`call failed: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
})
