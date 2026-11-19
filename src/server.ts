import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ServiceNowClient } from './client.js'
import { Dictionary } from './dictionary.js'
import { INSTRUCTIONS, LIMITATIONS_DOCUMENT } from './limitations.js'
import { registerDeltaTool } from './tools/delta.js'
import { registerDependenciesTool } from './tools/dependencies.js'
import { registerInstanceTools } from './tools/instance.js'
import { registerOriginTool } from './tools/origin.js'
import { registerQueryTool } from './tools/query.js'
import { registerSchemaTool } from './tools/schema.js'
import { registerUpgradeTool } from './tools/upgrade.js'

export const NAME = 'servicenow-sparring'
export const VERSION = '0.2.0'

export function buildServer(sn: ServiceNowClient): McpServer {
  const server = new McpServer({ name: NAME, version: VERSION }, { instructions: INSTRUCTIONS })
  const ctx = { sn, dict: new Dictionary(sn) }

  registerInstanceTools(server, ctx)
  registerQueryTool(server, ctx)
  registerSchemaTool(server, ctx)
  registerDeltaTool(server, ctx)
  registerOriginTool(server, ctx)
  registerDependenciesTool(server, ctx)
  registerUpgradeTool(server, ctx)

  server.registerResource(
    'limitations',
    'servicenow-sparring://limitations',
    {
      title: 'What this server cannot know',
      description: 'The exact read-only promise and the known gaps of every tool.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: LIMITATIONS_DOCUMENT }] }),
  )

  server.registerPrompt(
    'verify_claim',
    {
      title: 'Verify a claim about ServiceNow',
      description: 'Check a statement about the platform or this instance against the live instance, with evidence.',
      argsSchema: { claim: z.string().describe('The statement to check, e.g. "The incident table has no field for the business service".') },
    },
    ({ claim }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Verify this claim against the live ServiceNow instance:\n\n"${claim}"\n\n` +
              '1. Call sn_instance and note the release and which sources are readable.\n' +
              '2. Break the claim into statements that a table, a field or a record can confirm or refute.\n' +
              '3. Check each one with the tools. Do not answer any part from memory.\n' +
              '4. Answer with: a verdict (confirmed, refuted, partly, could not be checked); the evidence for each ' +
              'statement with instance, table and query; and what stays unknown, including the gaps the tools reported.',
          },
        },
      ],
    }),
  )

  return server
}
