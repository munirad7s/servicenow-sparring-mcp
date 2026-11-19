import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ServiceNowError } from '../errors.js'
import { assertTableName } from '../query.js'
import { fail, ok, source, sourceShape } from '../result.js'
import { READ_ONLY, type Context } from './shared.js'

export function registerSchemaTool(server: McpServer, ctx: Context) {
  server.registerTool(
    'sn_schema',
    {
      title: 'Inspect a table structure',
      description:
        'Return the fields of a table: name, label, type, reference target, mandatory and read-only flags, and the ' +
        'table that defines each field. Reports the chain of parent tables. With includeInherited the answer is the ' +
        'effective structure: fields of all parent tables included, dictionary overrides applied. Structure only; for ' +
        'records use sn_query.',
      inputSchema: {
        table: z.string().min(1).describe('Table name, e.g. "incident".'),
        includeInherited: z
          .boolean()
          .default(false)
          .describe('true lists inherited fields too and applies dictionary overrides. false lists only the fields this table defines.'),
      },
      outputSchema: {
        ...sourceShape,
        table: z.object({
          name: z.string(),
          label: z.string(),
          extends: z.array(z.string()).describe('Parent tables, nearest first.'),
        }),
        columnCount: z.number(),
        inheritedColumnCount: z.number().describe('Fields that come from parent tables.'),
        columns: z.array(
          z.object({
            name: z.string(),
            label: z.string(),
            type: z.string(),
            reference: z.string().nullable(),
            mandatory: z.boolean(),
            readOnly: z.boolean(),
            maxLength: z.number().nullable(),
            definedOn: z.string(),
            overriddenOn: z.string().optional(),
            overrides: z.array(z.string()).optional(),
          }),
        ),
      },
      annotations: READ_ONLY,
    },
    async ({ table, includeInherited }) => {
      try {
        assertTableName(table)
        const info = await ctx.dict.table(table)
        if (!info) {
          throw new ServiceNowError(`Table "${table}" has no entry in sys_db_object on this instance.`, 'not_found', table)
        }

        const warnings: string[] = []
        const effective = await ctx.dict.effectiveColumns(table)
        const all = effective?.columns ?? []
        if (effective && !effective.overridesRead) {
          warnings.push('sys_dictionary_override could not be read, so overrides of mandatory and read-only are not applied.')
        }

        const inherited = all.filter((column) => column.definedOn !== table)
        const columns = (includeInherited ? all : all.filter((column) => column.definedOn === table)).sort((a, b) =>
          a.name.localeCompare(b.name),
        )

        return ok({
          ...source(ctx.sn, warnings),
          table: { name: info.name, label: info.label, extends: info.chain.slice(1) },
          columnCount: columns.length,
          inheritedColumnCount: inherited.length,
          columns,
        })
      } catch (error) {
        return fail(error, table)
      }
    },
  )
}
