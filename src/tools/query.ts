import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Row } from '../client.js'
import { assertTableName } from '../query.js'
import { clip, fail, listing, listShape, ok, rowSchema, tidy } from '../result.js'
import { guardFields, READ_ONLY, type Context } from './shared.js'

export function registerQueryTool(server: McpServer, ctx: Context) {
  server.registerTool(
    'sn_query',
    {
      title: 'Query a ServiceNow table',
      description:
        'Read records from any table with an encoded query. Use it to look at real data and configuration instead of ' +
        'assuming. Every field name in the query and in "fields" is checked against the instance dictionary first: a ' +
        'query on a field that does not exist is refused, because ServiceNow would ignore that condition and answer ' +
        'unfiltered. Queries containing "javascript:" are refused. The answer reports how many rows match in total. ' +
        'For table structure use sn_schema.',
      inputSchema: {
        table: z.string().min(1).describe('Table name, e.g. "incident", "sys_script", "sys_properties".'),
        query: z
          .string()
          .optional()
          .describe(
            'Encoded query, e.g. "active=true^priorityIN1,2^ORDERBYDESCsys_created_on". Lowercase field names, ' +
              'dot-walking allowed. Dates as fixed values, "YYYY-MM-DD HH:MM:SS" in UTC.',
          ),
        fields: z
          .array(z.string())
          .optional()
          .describe('Fields to return. Name them: answers stay small, and a missing field is reported instead of ignored.'),
        limit: z.number().int().min(1).max(200).default(20).describe('Rows per page, at most 200.'),
        offset: z.number().int().min(0).default(0).describe('Rows to skip. Use nextOffset from the previous answer.'),
        displayValue: z
          .boolean()
          .default(false)
          .describe('true adds display values: a reference or choice comes back as {value, display}.'),
      },
      outputSchema: {
        ...listShape,
        fieldCheck: z.string().describe('Whether the field names could be verified before the query was sent.'),
        records: z.array(rowSchema),
      },
      annotations: READ_ONLY,
    },
    async ({ table, query = '', fields, limit, offset, displayValue }) => {
      try {
        assertTableName(table)
        const fieldCheck = await guardFields(ctx, table, query, fields)
        const page = await ctx.sn.query<Row>({ table, query, fields, limit, offset, display: displayValue })

        const warnings: string[] = []
        const records = clip(displayValue ? page.records.map(tidy) : page.records, warnings)
        return ok({ ...listing(ctx.sn, page, warnings), fieldCheck, records })
      } catch (error) {
        return fail(error, table)
      }
    },
  )
}
