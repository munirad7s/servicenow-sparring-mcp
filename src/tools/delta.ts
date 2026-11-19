import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Row } from '../client.js'
import { DELTA_GAPS } from '../limitations.js'
import { assertPlainValue } from '../query.js'
import { clip, fail, listing, listShape, ok, rowSchema, tidy } from '../result.js'
import { READ_ONLY, type Context } from './shared.js'

export function registerDeltaTool(server: McpServer, ctx: Context) {
  const { sn } = ctx

  server.registerTool(
    'sn_delta',
    {
      title: 'List captured customizations',
      description:
        'Return what was changed on this instance, from the Customer Updates table (sys_update_xml): which record, ' +
        'what kind, insert-or-update or delete, by whom, when, in which update set. Also returns exact counts per type ' +
        'for the same filter, so "how customized is this instance" needs one call. Coverage is partial by design of ' +
        'the platform; the answer lists what the table does not capture. To judge one record use sn_origin. For what ' +
        'an upgrade skipped use sn_upgrade_skips.',
      inputSchema: {
        nameContains: z
          .string()
          .optional()
          .describe(
            'Text the update name must contain. Update names look like "sys_script_<sys_id>" or ' +
              '"sys_dictionary_incident_u_field". "incident" finds dictionary changes of that table, not its business rules.',
          ),
        type: z.string().optional().describe('Exact type label, e.g. "Business Rule", "Dictionary", "Access Control".'),
        createdBy: z.string().optional().describe('User name of the author.'),
        since: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe('Only updates created on or after this day, YYYY-MM-DD (UTC).'),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      },
      outputSchema: {
        ...listShape,
        byType: z
          .array(z.object({ type: z.string(), count: z.number() }))
          .nullable()
          .describe('Exact counts per type for the whole filter, largest first, at most 30 types. null if the counts could not be read.'),
        updates: z.array(rowSchema),
        notCaptured: z.array(z.string()).describe('What sys_update_xml does not record. Say "captured customizations", never "all".'),
      },
      annotations: READ_ONLY,
    },
    async ({ nameContains, type, createdBy, since, limit, offset }) => {
      try {
        for (const [label, value] of Object.entries({ nameContains, type, createdBy })) {
          if (value) assertPlainValue(value, label)
        }

        const filter = [
          nameContains ? `nameLIKE${nameContains}` : '',
          type ? `type=${type}` : '',
          createdBy ? `sys_created_by=${createdBy}` : '',
          since ? `sys_created_on>=${since} 00:00:00` : '',
        ]
          .filter(Boolean)
          .join('^')

        const warnings: string[] = []
        const [page, byType] = await Promise.all([
          sn.query<Row>({
            table: 'sys_update_xml',
            query: [filter, 'ORDERBYDESCsys_created_on'].filter(Boolean).join('^'),
            fields: ['name', 'type', 'action', 'target_name', 'update_set', 'application', 'sys_created_by', 'sys_created_on'],
            limit,
            offset,
            display: true,
          }),
          sn
            .groupCount('sys_update_xml', 'type', filter)
            .then((groups) =>
              groups
                .map((group) => ({ type: group.value || '(empty)', count: group.count }))
                .sort((a, b) => b.count - a.count)
                .slice(0, 30),
            )
            .catch(() => null),
        ])

        if (!byType) warnings.push('The counts per type could not be read (Aggregate API). The list itself is valid.')
        const updates = clip(page.records.map(tidy), warnings)

        return ok({ ...listing(sn, page, warnings), byType, updates, notCaptured: DELTA_GAPS })
      } catch (error) {
        return fail(error, 'sys_update_xml')
      }
    },
  )
}
