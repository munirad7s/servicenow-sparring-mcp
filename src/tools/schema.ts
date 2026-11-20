import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ServiceNowError, unlessNoConnection } from '../errors.js'
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
        'overrides applied, each with the table that defines it and the label it has on this table. Use "filter" to ' +
        'look for one field: unless a warning says the dictionary was only partly readable, a field that is not in the ' +
        'answer does not exist on the table. Also answers for database views, whose fields carry the prefix of the ' +
        'table they come from ("joinedFrom"); for a view, dictionary overrides and the labels of child tables are not ' +
        'applied, so ask for the joined table to see those. Reports the chain of parent tables and the kind of table. "mandatory" and "readOnly" are ' +
        'what the dictionary says: UI policies, data policies and client scripts can change both on a form, which ' +
        'sn_dependencies with "field" lists. A field is three kinds of record, each judged on its own by sn_origin: ' +
        'the dictionary entry (updateName "sys_dictionary_<definedOn>_<name>"), its label ' +
        '("sys_documentation_<labelFrom or definedOn>_<name>_en"), and each dictionary override (the sysId under ' +
        '"overrideRecords"). The dictionary is read anew for every call. Structure only; for records use sn_query.',
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
            label: z.string().describe('The English label the field has on this table.'),
            type: z.string(),
            definedOn: z.string().describe('The table that defines the field: the table itself or one in its parent chain. For a field of a database view: the table that defines it among the joined table and its parents.'),
            joinedFrom: z.string().optional().describe('For a field of a database view: the table the view joins that the field comes from.'),
            sourceField: z.string().optional().describe('For a field of a database view: its name on the table it comes from, without the prefix of the view. Use it in place of "name" in an update name.'),
            labelFrom: z.string().optional().describe('The table whose label record gives the field this label, where that is not definedOn: a child table can relabel an inherited field.'),
            reference: z.string().optional().describe('Table a reference field points to.'),
            maxLength: z.number().optional(),
            mandatory: z.literal(true).optional().describe('Present only when true.'),
            readOnly: z.literal(true).optional().describe('Present only when true.'),
            choice: z.literal(true).optional().describe('Present when the field takes its values from a choice list. Queries need the stored value, not the label.'),
            inactive: z.literal(true).optional().describe('Present when the dictionary entry is deactivated.'),
            overriddenOn: z.string().optional().describe('Nearest table whose dictionary override changes the field.'),
            overrides: z.array(z.string()).optional().describe('What the overrides along the chain change, taken together: mandatory, read_only, default_value, reference_qual, attributes, dependent, calculation, display.'),
            overrideRecords: z
              .array(z.object({ table: z.string(), sysId: z.string(), changes: z.array(z.string()) }))
              .optional()
              .describe('Each dictionary override that applies, nearest table first. An override is a record of its own (sys_dictionary_override): pass its sysId to sn_origin.'),
          }),
        ),
      },
      annotations: READ_ONLY,
    },
    traced('sn_schema', async ({ table, filter, includeInherited }) => {
      try {
        assertTableName(table)
        if (filter) assertPlainValue(filter, 'filter')
        // Asked for the structure itself, a person expects what is there now, not what was read ten minutes ago.
        // Forgotten first: whether the table is closed is then judged by what it extends and joins now, too.
        ctx.dict.forget(table)
        // For a database view the same goes for the tables it joins: one of them can have been made a child table
        // of a closed one in the meantime.
        const before = await ctx.dict.table(table).catch(unlessNoConnection(null))
        for (const member of before?.members ?? []) ctx.dict.forget(member.table)
        // A table that is closed on this machine is not described either: its fields, its labels, its overrides.
        const closed = await ctx.closed.reason(table)
        if (closed) throw new ServiceNowError(`${closed[0].toUpperCase()}${closed.slice(1)}. Nothing was sent.`, 'blocked', table)
        const info = await ctx.dict.table(table)
        if (!info) {
          throw new ServiceNowError(`"${table}" is neither a table in sys_db_object nor a database view on this instance.`, 'not_found', table)
        }
        const effective = await ctx.dict.effectiveColumns(table)
        const all = effective?.columns ?? []
        // A view defines no fields of its own: all of them come from the tables it joins.
        const own = info.kind === 'database_view' ? all : all.filter((column) => column.definedOn === table)

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
        if (info.kind === 'database_view') {
          warnings.push('This is a database view. Its fields are listed as the joined tables define them: dictionary overrides, and the labels a child table gives to a field it inherits, are not applied. Ask for the joined table to see those.')
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
            definedOn: column.sourceDefinedOn ?? column.definedOn,
            ...(column.sourceField ? { joinedFrom: column.definedOn } : {}),
            ...(column.reference ? { reference: column.reference } : {}),
            ...(column.maxLength !== null ? { maxLength: column.maxLength } : {}),
            ...(column.mandatory ? { mandatory: true as const } : {}),
            ...(column.readOnly ? { readOnly: true as const } : {}),
            ...(column.choice ? { choice: true as const } : {}),
            ...(column.active ? {} : { inactive: true as const }),
            ...(column.sourceField ? { sourceField: column.sourceField } : {}),
            ...(column.labelFrom ? { labelFrom: column.labelFrom } : {}),
            ...(column.overriddenOn ? { overriddenOn: column.overriddenOn, overrides: column.overrides, overrideRecords: column.overrideRecords } : {}),
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
        return fail(error, table, ctx.sn)
      }
    }),
  )
}
