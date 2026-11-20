import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ServiceNowError } from '../errors.js'
import { assertPlainValue, assertTableName } from '../query.js'
import { fail, ok, source, sourceShape } from '../result.js'
import { traced } from '../trace.js'
import { READ_ONLY, type Context } from './shared.js'

const MAX_COLUMNS_CHARS = 60_000

export function registerSchemaTool(server: McpServer, ctx: Context) {
  server.registerTool(
    'sn_schema',
    {
      title: 'Inspect a table structure',
      description:
        'Return the fields of a table as they apply to it: the fields of all parent tables included, dictionary ' +
        'overrides applied, each with the table that defines it. Use "filter" to look for one field; a field that is ' +
        'not in the answer does not exist on the table. Also answers for database views. Reports the chain of parent ' +
        'tables and the kind of table. To judge a single field with sn_origin, pass the update name ' +
        '"sys_dictionary_<definedOn>_<name>". Structure only; for records use sn_query.',
      inputSchema: {
        table: z.string().min(1).max(80).describe('Table name, e.g. "incident".'),
        filter: z.string().max(80).optional().describe('Text the field name or label must contain, e.g. "business" or "assign".'),
        includeInherited: z
          .boolean()
          .default(true)
          .describe('false lists only the fields this table defines itself. Leave true to check whether a field exists.'),
      },
      outputSchema: {
        ...sourceShape,
        table: z.object({
          name: z.string(),
          label: z.string(),
          kind: z.enum(['table', 'remote_table', 'database_view']),
          extends: z.array(z.string()).describe('Parent tables, nearest first.'),
          joins: z.array(z.object({ table: z.string(), prefix: z.string() })).optional().describe('For a database view: the tables it joins.'),
        }),
        fieldCount: z.number().describe('Fields that apply to the table, inherited ones included.'),
        ownFieldCount: z.number().describe('Fields the table defines itself.'),
        returned: z.number().describe('Fields in this answer, after includeInherited and filter.'),
        columns: z.array(
          z.object({
            name: z.string(),
            label: z.string(),
            type: z.string(),
            definedOn: z.string(),
            reference: z.string().optional().describe('Table a reference field points to.'),
            maxLength: z.number().optional(),
            mandatory: z.literal(true).optional().describe('Present only when true.'),
            readOnly: z.literal(true).optional().describe('Present only when true.'),
            choice: z.literal(true).optional().describe('Present when the field takes its values from a choice list. Queries need the stored value, not the label.'),
            inactive: z.literal(true).optional().describe('Present when the dictionary entry is deactivated.'),
            overriddenOn: z.string().optional().describe('Nearest table whose dictionary override changes the field.'),
            overrides: z.array(z.string()).optional(),
          }),
        ),
      },
      annotations: READ_ONLY,
    },
    traced('sn_schema', async ({ table, filter, includeInherited }) => {
      try {
        assertTableName(table)
        if (filter) assertPlainValue(filter, 'filter')

        const info = await ctx.dict.table(table)
        if (!info) {
          throw new ServiceNowError(`"${table}" is neither a table in sys_db_object nor a database view on this instance.`, 'not_found', table)
        }
        const effective = await ctx.dict.effectiveColumns(table)
        const all = effective?.columns ?? []
        const own = all.filter((column) => column.definedOn === table)

        const warnings: string[] = []
        if (effective && !effective.complete) {
          warnings.push('The dictionary of this table is only partly readable for this account. Fields may be missing from the answer: a missing field does not prove that it does not exist.')
        }
        if (effective && !effective.overridesRead) {
          warnings.push('sys_dictionary_override could not be read completely, so overrides of mandatory and read-only may be missing.')
        }
        if (effective && !effective.labelsRead) {
          warnings.push('sys_documentation could not be read completely, so a label can be the one of the parent table where this table has its own.')
        }
        if (info.kind === 'remote_table') {
          warnings.push('This is a remote table. Reading its records runs a script on the instance, which usually calls another system.')
        }
        if (!includeInherited && all.length > own.length) {
          warnings.push(`${all.length - own.length} inherited field(s) are left out, because includeInherited is false. They exist on this table too.`)
        }

        const needle = filter?.toLowerCase()
        const selected = (includeInherited ? all : own)
          .filter((column) => !needle || column.name.toLowerCase().includes(needle) || column.label.toLowerCase().includes(needle))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((column) => ({
            name: column.name,
            label: column.label,
            type: column.type,
            definedOn: column.definedOn,
            ...(column.reference ? { reference: column.reference } : {}),
            ...(column.maxLength !== null ? { maxLength: column.maxLength } : {}),
            ...(column.mandatory ? { mandatory: true as const } : {}),
            ...(column.readOnly ? { readOnly: true as const } : {}),
            ...(column.choice ? { choice: true as const } : {}),
            ...(column.active ? {} : { inactive: true as const }),
            ...(column.overriddenOn ? { overriddenOn: column.overriddenOn, overrides: column.overrides } : {}),
          }))

        let size = 0
        const fits = selected.findIndex((column) => (size += JSON.stringify(column).length) > MAX_COLUMNS_CHARS)
        const columns = fits === -1 ? selected : selected.slice(0, fits)
        if (fits !== -1) {
          warnings.push(`Only the first ${columns.length} of ${selected.length} fields are shown, because the answer would be too large. Use filter to find a field.`)
        }

        return ok({
          ...source(ctx.sn, warnings),
          table: {
            name: info.name,
            label: info.label,
            kind: info.kind,
            extends: info.chain.slice(1),
            ...(info.members ? { joins: info.members } : {}),
          },
          fieldCount: all.length,
          ownFieldCount: own.length,
          returned: columns.length,
          columns,
        })
      } catch (error) {
        return fail(error, table)
      }
    }),
  )
}
