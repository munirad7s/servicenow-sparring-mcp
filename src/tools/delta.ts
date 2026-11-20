import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Row } from '../client.js'
import { quoteInstanceText, validation } from '../errors.js'
import { DELTA_GAPS } from '../limitations.js'
import { assertPlainValue } from '../query.js'
import { clip, fail, listing, listShape, ok, rawOf, rowSchema, tidy } from '../result.js'
import { traced } from '../trace.js'
import { BY_SYSTEM_ACCOUNT, CLOSED_NAME, isClosedRecord, isDate, knowRecordTables, READ_ONLY, withPeopleOnly, type Context } from './shared.js'

/** A day or a moment as the caller wrote it, in the one form the instance is asked with: YYYY-MM-DD HH:MM:SS. */
const moment = (given: string) => {
  const [day, time = '00:00:00'] = given.replace('Z', '').split(/[ T]/)
  return `${day} ${time.length === 5 ? `${time}:00` : time}`
}

export function registerDeltaTool(server: McpServer, ctx: Context) {
  const { sn } = ctx

  const total = (query: string) =>
    sn
      .query({ table: 'sys_update_xml', query, fields: ['sys_id'], limit: 1 })
      .then((page) => page.total)
      .catch(() => null)

  const typeCounts = (query: string) =>
    sn
      .groupCount('sys_update_xml', 'type', query)
      .then((groups) =>
        groups
          .map((group) => ({ type: group.value || '(empty)', count: group.count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 30),
      )
      .catch(() => null)

  server.registerTool(
    'sn_delta',
    {
      title: 'List captured customizations',
      description:
        'Return what was changed on this instance, from the Customer Updates table (sys_update_xml): which record, ' +
        'what kind, insert-or-update or delete, by whom, when, in which update set. Also returns exact counts per type ' +
        'for the same filter, and how many of the rows were captured under system accounts (installations, upgrades and ' +
        'jobs) rather than by people. With peopleOnly the list and the counts per type cover the rows a person is on, ' +
        'and the rows that were left out are still counted. Rows, not records: one ' +
        'record can have a row in several update sets. Coverage is partial by design of the platform; the answer lists ' +
        'what the table does not capture. To judge one record use sn_origin. For what an upgrade skipped use sn_upgrade_skips.',
      inputSchema: {
        nameContains: z
          .string()
          .max(120)
          .optional()
          .describe(
            'Text the update name must contain. Update names look like "sys_script_<sys_id>" or ' +
              '"sys_dictionary_incident_u_field". "incident" finds dictionary changes of that table, not its business rules.',
          ),
        type: z
          .string()
          .max(120)
          .optional()
          .describe('Exact type label as it appears in byType, e.g. "Business Rule", "Dictionary", "Access Control". Call without type first to see the labels.'),
        changedBy: z.string().max(120).optional().describe('User name. Matches the user who first captured the change or who changed it last.'),
        since: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?Z?)?$/)
          .optional()
          .describe('Only changes last made at or after this moment: YYYY-MM-DD or YYYY-MM-DD HH:MM:SS, in UTC.'),
        peopleOnly: z.boolean().default(false).describe('true leaves out rows no person is on: first captured and last changed by a system account (system, guest, ServiceNow maintenance logins).'),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      },
      outputSchema: {
        ...listShape,
        byType: z
          .array(z.object({ type: z.string(), count: z.number() }))
          .nullable()
          .describe('Exact counts per type for the whole filter, largest first, at most 30 types. null if the counts could not be read.'),
        capturedBySystemAccounts: z
          .number()
          .nullable()
          .describe('Rows under the same conditions that no person is on: first captured and last changed by a system account. With peopleOnly these are the rows that were left out of the list. null if unknown.'),
        updates: z
          .array(rowSchema)
          .describe('One row per captured change, newest first: name (the update name, which sn_origin takes), type, action, target_name (the readable name of the record), update_set, application, sys_created_by and sys_created_on (first capture), sys_updated_by and sys_updated_on (last change).'),
        notCaptured: z.array(z.string()).describe('What sys_update_xml does not record. Say "captured customizations", never "all".'),
      },
      annotations: READ_ONLY,
    },
    traced('sn_delta', async ({ nameContains, type, changedBy, since, peopleOnly, limit, offset }) => {
      try {
        for (const [label, value] of Object.entries({ nameContains, type, changedBy })) {
          if (value) assertPlainValue(value, label)
        }
        // Measured: with a date it cannot read, the instance does not reject ">=": it matches every row.
        if (since && !isDate(since)) throw validation(`"since" is not a day that exists, or not a time of day: ${since}. Write YYYY-MM-DD or YYYY-MM-DD HH:MM:SS, in UTC.`)

        const withoutType = [
          nameContains ? `nameLIKE${nameContains}` : '',
          changedBy ? `sys_created_by=${changedBy}^ORsys_updated_by=${changedBy}` : '',
          since ? `sys_updated_on>=${moment(since)}` : '',
        ].filter(Boolean)
        const scope = (conditions: string[]) => (peopleOnly ? withPeopleOnly(conditions.join('^')) : conditions.join('^'))
        const filter = scope([...withoutType, type ? `type=${type}` : ''].filter(Boolean))

        const warnings: string[] = []
        const [page, byType, bySystem] = await Promise.all([
          sn.query<Row>({
            table: 'sys_update_xml',
            query: [filter, 'ORDERBYDESCsys_updated_on'].filter(Boolean).join('^'),
            fields: ['name', 'type', 'action', 'target_name', 'update_set', 'application', 'sys_created_by', 'sys_created_on', 'sys_updated_by', 'sys_updated_on'],
            limit,
            offset,
            display: true,
          }),
          typeCounts(filter),
          // Counted under the conditions as given, without the restriction to people: with it the answer would always be 0.
          total([...withoutType, type ? `type=${type}` : '', BY_SYSTEM_ACCOUNT].filter(Boolean).join('^')),
        ])

        if (!byType) warnings.push('The counts per type could not be read (Aggregate API). The list itself is valid.')
        if (page.total === 0 && type) {
          const known = await typeCounts(scope(withoutType))
          if (known?.length) {
            warnings.push(`No row has the type "${type}". The type must be the exact label. Types under this filter: ${known.map((item) => quoteInstanceText(item.type, 60)).join(', ')}.`)
          }
        }
        if (peopleOnly && bySystem) {
          warnings.push(`${bySystem} more row(s) under the same conditions have no person on them (installations, upgrades and jobs) and were left out by peopleOnly. The platform treats those records as customized too.`)
        } else if (page.total && bySystem && bySystem / page.total >= 0.2) {
          warnings.push(
            `${bySystem} of the ${page.total} rows were captured under system accounts: installations, upgrades and jobs, not edits by people. ` +
              'The platform still treats those records as customized.',
          )
        }

        // The readable name of a record in a table that is closed on this machine is not passed on. Which tables
        // the names begin with is asked for the page as a whole.
        await knowRecordTables(ctx, page.records.map((row) => rawOf(tidy(row).name)))
        const rows = await Promise.all(
          page.records.map(tidy).map(async (row) => ((await isClosedRecord(ctx, rawOf(row.name))) ? { ...row, target_name: CLOSED_NAME } : row)),
        )
        const updates = clip(rows, warnings)
        return ok({ ...listing(sn, page, warnings, updates.length), byType, capturedBySystemAccounts: bySystem, updates, notCaptured: DELTA_GAPS })
      } catch (error) {
        return fail(error, 'sys_update_xml')
      }
    }),
  )
}
