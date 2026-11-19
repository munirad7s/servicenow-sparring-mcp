import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Page, Row } from '../client.js'
import { validation } from '../errors.js'
import { ORIGIN_CAVEATS } from '../limitations.js'
import { assertSysId } from '../query.js'
import { fail, labelOf, ok, rawOf, rowSchema, source, sourceShape, tally, tidy } from '../result.js'
import { errorKind, READ_ONLY, type Context } from './shared.js'

const UPDATE_NAME = /^[A-Za-z0-9_.-]{1,250}$/

/** Who delivered the record, read from the class of the package it belongs to. */
const PROVENANCE: Record<string, string> = {
  sys_package: 'vendor',
  sys_plugins: 'vendor',
  sys_store_app: 'installed_application',
  sys_app: 'custom_application',
  sys_scope: 'global_scope',
}

const CUSTOMER_SOURCES = new Set(['sys_update_set', 'sys_remote_update_set'])

const EXPLANATIONS: Record<string, string> = {
  out_of_box_as_captured: 'Delivered by a vendor package, and no customer change is captured for it on this instance.',
  customized: 'Delivered by a vendor package and changed on this instance: customer update rows exist for it.',
  customer_created: 'Belongs to no package (global scope) and customer update rows exist for it: created on or for this instance.',
  custom_application_file: 'Part of a custom application developed on this instance.',
  deleted_here: 'The record no longer exists, and a captured customer update deleted it.',
  not_found: 'No application file with this identity is readable. It may not exist, may be a data record, or this account may not see it.',
  unknown: 'The evidence does not decide it. See the evidence and the caveats.',
}

export function registerOriginTool(server: McpServer, ctx: Context) {
  const { sn } = ctx

  server.registerTool(
    'sn_origin',
    {
      title: 'Is this record out-of-the-box or custom?',
      description:
        'Judge one application file (a business rule, a field, an ACL, a UI action, any configuration record). Answers ' +
        'two questions separately: who delivered it (provenance, from the package it belongs to) and whether it was ' +
        'changed on this instance (divergence, from captured customer updates and version history). Returns a verdict, ' +
        'the evidence rows and the caveats. The verdict is "unknown" when the evidence does not decide it. Identify the ' +
        'record by sysId, or by updateName such as "sys_script_<sys_id>". Find sys_ids with sn_query or sn_dependencies.',
      inputSchema: {
        sysId: z.string().optional().describe('sys_id of the record (32 hex characters).'),
        updateName: z.string().optional().describe('Update name of the record, e.g. "sys_script_<sys_id>" or "sys_dictionary_incident_u_field".'),
      },
      outputSchema: {
        ...sourceShape,
        verdict: z.enum([
          'out_of_box_as_captured',
          'customized',
          'customer_created',
          'custom_application_file',
          'deleted_here',
          'not_found',
          'unknown',
        ]),
        explanation: z.string(),
        provenance: z.enum(['vendor', 'installed_application', 'custom_application', 'global_scope', 'unknown']),
        divergence: z.enum(['customer_changes_captured', 'no_customer_changes_captured', 'unknown']),
        record: rowSchema.nullable(),
        evidence: z.object({
          customerUpdates: z.object({ total: z.number().nullable(), rows: z.array(rowSchema), readable: z.boolean() }),
          versions: z.object({
            total: z.number().nullable(),
            bySource: z.record(z.string(), z.number()),
            rows: z.array(rowSchema),
            readable: z.boolean(),
          }),
        }),
        caveats: z.array(z.string()),
      },
      annotations: READ_ONLY,
    },
    async ({ sysId, updateName }) => {
      try {
        if (!sysId && !updateName) throw validation('Give sysId or updateName.')
        if (sysId) assertSysId(sysId)
        if (updateName && !UPDATE_NAME.test(updateName)) {
          throw validation('updateName may contain only letters, digits, underscore, dot and hyphen.')
        }

        const warnings: string[] = []
        const found = await sn.query<Row>({
          table: 'sys_metadata',
          query: sysId ? `sys_id=${sysId}` : `sys_update_name=${updateName}`,
          fields: [
            'sys_id',
            'sys_class_name',
            'sys_name',
            'sys_update_name',
            'sys_package',
            'sys_package.sys_class_name',
            'sys_package.source',
            'sys_scope',
            'sys_policy',
            'sys_created_on',
            'sys_created_by',
            'sys_updated_on',
            'sys_updated_by',
            'sys_mod_count',
          ],
          limit: 1,
          display: true,
        })

        const record = found.records[0] ? tidy(found.records[0]) : null
        const name = record ? rawOf(record.sys_update_name) : updateName
        if (record && !name) {
          warnings.push('This record has no update name: its type is not tracked in sys_update_xml, so a local change to it would not be captured.')
        }

        const read = async (table: string, query: string, fields: string[]): Promise<Page<Row> | null> => {
          try {
            return await sn.query<Row>({ table, query, fields, limit: 50, display: true })
          } catch (error) {
            warnings.push(`${table} could not be read (${errorKind(error)}), so that part of the evidence is missing.`)
            return null
          }
        }

        const [updates, versions] = name
          ? await Promise.all([
              read('sys_update_xml', `name=${name}^ORDERBYDESCsys_updated_on`, [
                'name',
                'action',
                'type',
                'update_set',
                'sys_created_by',
                'sys_created_on',
                'sys_updated_on',
              ]),
              read('sys_update_version', `name=${name}^ORDERBYDESCsys_created_on`, [
                'state',
                'source_table',
                'source',
                'sys_created_by',
                'sys_created_on',
              ]),
            ])
          : [null, null]

        const updateRows = updates?.records.map(tidy) ?? []
        const versionRows = versions?.records.map(tidy) ?? []
        const customerVersions = versionRows.filter((row) => CUSTOMER_SOURCES.has(rawOf(row.source_table))).length
        const changed = (updates?.total ?? updateRows.length) > 0 || customerVersions > 0

        const divergence = changed
          ? 'customer_changes_captured'
          : updates && versions
            ? 'no_customer_changes_captured'
            : 'unknown'

        const packageClass = record ? rawOf(record['sys_package.sys_class_name']) : ''
        const provenance = PROVENANCE[packageClass] ?? 'unknown'

        let verdict: keyof typeof EXPLANATIONS = 'unknown'
        if (!record) {
          verdict = updateRows.some((row) => rawOf(row.action) === 'DELETE') ? 'deleted_here' : 'not_found'
        } else if (provenance === 'vendor' || provenance === 'installed_application') {
          if (changed) verdict = 'customized'
          else if (divergence === 'no_customer_changes_captured') verdict = 'out_of_box_as_captured'
        } else if (provenance === 'custom_application') {
          verdict = 'custom_application_file'
        } else if (provenance === 'global_scope' && changed) {
          verdict = 'customer_created'
        }

        return ok({
          ...source(sn, warnings),
          verdict,
          explanation: EXPLANATIONS[verdict],
          provenance,
          divergence,
          record: record && {
            sysId: rawOf(record.sys_id),
            table: rawOf(record.sys_class_name),
            name: rawOf(record.sys_name),
            updateName: name,
            package: labelOf(record.sys_package),
            packageClass,
            packageSource: rawOf(record['sys_package.source']),
            scope: labelOf(record.sys_scope),
            protection: rawOf(record.sys_policy),
            createdOn: rawOf(record.sys_created_on),
            createdBy: rawOf(record.sys_created_by),
            updatedOn: rawOf(record.sys_updated_on),
            updatedBy: rawOf(record.sys_updated_by),
            modCount: rawOf(record.sys_mod_count),
          },
          evidence: {
            customerUpdates: { total: updates?.total ?? null, rows: updateRows.slice(0, 10), readable: updates !== null },
            versions: {
              total: versions?.total ?? null,
              bySource: tally(versionRows, (row) => rawOf(row.source_table)),
              rows: versionRows.slice(0, 10),
              readable: versions !== null,
            },
          },
          caveats: ORIGIN_CAVEATS,
        })
      } catch (error) {
        return fail(error, 'sys_metadata')
      }
    },
  )
}
