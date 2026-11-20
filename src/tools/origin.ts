import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { GroupCount, Page, Row } from '../client.js'
import { validation } from '../errors.js'
import { ORIGIN_CAVEATS } from '../limitations.js'
import { assertSysId, isTableName } from '../query.js'
import { fail, labelOf, ok, rawOf, rowSchema, source, sourceShape, tidy } from '../result.js'
import { traced } from '../trace.js'
import { errorKind, isSystemAccount, READ_ONLY, type Context } from './shared.js'

const UPDATE_NAME = /^[A-Za-z0-9_.-]{1,250}$/

/** Who delivered the record, read from the class of the package it belongs to. */
const PROVENANCE: Record<string, Provenance> = {
  sys_package: 'vendor',
  sys_plugins: 'vendor',
  sys_store_app: 'installed_application',
  sys_app: 'custom_application',
  sys_scope: 'global_scope',
}

/**
 * Dictionary entries and field labels are captured under a name built from what
 * they describe, and that name is stored on the record only once it was captured.
 * Measured: the stored names follow these patterns, a table label has an empty
 * element, and the entry of a table itself is named "..._null".
 */
const NAMED_BY_CONTENT: Record<string, (row: Record<string, string>) => string> = {
  sys_dictionary: (row) => `sys_dictionary_${row.name}_${row.element || 'null'}`,
  sys_documentation: (row) => `sys_documentation_${row.name}_${row.element ?? ''}_${row.language}`,
}

/** Where a version came from. A version from an upgrade or an app installation is the vendor's own. */
const VENDOR_SOURCES = new Set(['sys_upgrade_history', 'sys_store_app'])
const CUSTOMER_SOURCES = new Set(['sys_update_set', 'sys_remote_update_set', 'sys_app_customization'])

type Provenance = 'vendor' | 'installed_application' | 'custom_application' | 'global_scope' | 'unknown'
type Divergence = 'customer_changes_captured' | 'changed_without_capture' | 'no_customer_changes_captured' | 'unknown'
type Verdict = keyof typeof EXPLANATIONS

const EXPLANATIONS = {
  out_of_box_as_captured: 'Delivered with the platform or an installed application, and no customer change is captured for it on this instance.',
  customized: 'Delivered with the platform or an installed application, and changed on this instance.',
  customer_created: 'Created on or for this instance. It is not part of what the vendor delivered.',
  custom_application_file: 'Part of an application developed on this instance.',
  deleted_here: 'The record no longer exists, and a captured customer update deleted it.',
  not_found: 'No record with this identity is readable, and no change is captured for it. It may not exist, or it may be a data record that is not tracked.',
  unknown: 'The evidence does not decide it. See the evidence, the warnings and the caveats.',
}

const seconds = (stamp: string) => (stamp ? Date.parse(`${stamp.replace(' ', 'T')}Z`) / 1000 : NaN)

export function registerOriginTool(server: McpServer, ctx: Context) {
  const { sn } = ctx

  server.registerTool(
    'sn_origin',
    {
      title: 'Is this record out-of-the-box or custom?',
      description:
        'Judge one configuration record (a business rule, a field, an ACL, a UI action). Answers separately: who ' +
        'delivered it (from the package it belongs to), whether it was changed here (customer update rows, the ' +
        'current version, and whether the last upgrade skipped it), whether it was created here or delivered ' +
        '(baseline version and creation time), and whether people or only system accounts made the captured changes. Returns a verdict with the evidence rows ' +
        'and the queries behind them. The verdict is "unknown" when the evidence does not decide it. Identify the ' +
        'record by sysId, or by updateName such as "sys_script_<sys_id>" or "sys_dictionary_incident_u_field". Find ' +
        'sys_ids with sn_query or sn_dependencies.',
      inputSchema: {
        sysId: z.string().max(32).optional().describe('sys_id of the record. Give this or updateName, not both.'),
        updateName: z.string().max(250).optional().describe('Update name of the record, e.g. "sys_script_<sys_id>" or "sys_dictionary_incident_u_field".'),
      },
      outputSchema: {
        ...sourceShape,
        verdict: z.enum(['out_of_box_as_captured', 'customized', 'customer_created', 'custom_application_file', 'deleted_here', 'not_found', 'unknown']),
        explanation: z.string(),
        provenance: z.enum(['vendor', 'installed_application', 'custom_application', 'global_scope', 'unknown']).describe('Kind of package the record belongs to.'),
        divergence: z
          .enum(['customer_changes_captured', 'changed_without_capture', 'no_customer_changes_captured', 'unknown'])
          .describe('"changed_without_capture": no customer update exists, but an upgrade skipped the record because it differs from the vendor version.'),
        created: z
          .enum(['here', 'delivered', 'unknown'])
          .describe('"delivered" if a vendor version of the record exists or the record is older than its first captured change; "here" if neither holds.'),
        capturedBy: z
          .enum(['people', 'system_accounts', 'nobody', 'unknown'])
          .describe('Who made the captured changes. "system_accounts" means installations, upgrades or jobs, not an edit by a person.'),
        record: rowSchema.nullable(),
        evidence: z.object({
          customerUpdates: z.object({
            table: z.literal('sys_update_xml'),
            query: z.string(),
            readable: z.boolean(),
            total: z.number().nullable(),
            firstCapturedOn: z.string().nullable(),
            rows: z.array(rowSchema),
          }),
          versions: z.object({
            table: z.literal('sys_update_version'),
            query: z.string(),
            readable: z.boolean(),
            total: z.number().nullable(),
            bySource: z.record(z.string(), z.number()).nullable().describe('Exact number of versions per source table. null if it could not be read.'),
            current: rowSchema.nullable().describe('The version marked current. A source of sys_upgrade_history or sys_store_app is the vendor\'s own version.'),
            rows: z.array(rowSchema),
          }),
          upgradeSkips: z
            .object({
              table: z.literal('upgrade_history_task'),
              query: z.string(),
              readable: z.boolean(),
              total: z.number().nullable(),
              rows: z.array(rowSchema),
            })
            .describe('Upgrades that did not overwrite this record. The upgrade engine compares content, so it also finds changes nobody captured.'),
        }),
        caveats: z.array(z.string()),
      },
      annotations: READ_ONLY,
    },
    traced('sn_origin', async ({ sysId, updateName }) => {
      try {
        if (!sysId && !updateName) throw validation('Give sysId or updateName.')
        if (sysId && updateName) throw validation('Give sysId or updateName, not both: they could name two different records.')
        if (sysId) assertSysId(sysId)
        if (updateName && !UPDATE_NAME.test(updateName)) {
          throw validation('updateName may contain only letters, digits, underscore, dot and hyphen.')
        }

        const warnings: string[] = []
        const read = async (table: string, query: string, fields: string[], limit: number): Promise<Page<Row> | null> => {
          try {
            return await sn.query<Row>({ table, query, fields, limit, display: true })
          } catch (error) {
            warnings.push(`${table} could not be read (${errorKind(error)}), so that part of the evidence is missing.`)
            return null
          }
        }

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
            'sys_scope',
            'sys_policy',
            'sys_created_on',
            'sys_created_by',
            'sys_updated_on',
            'sys_updated_by',
          ],
          limit: 1,
          display: true,
        })
        let file = found.records[0] ? tidy(found.records[0]) : null
        const hidden = !file && (found.total ?? 0) > 0
        if (hidden) warnings.push('The record exists, but this account may not read it (row-level access rule). Nothing about it could be checked.')

        // The update name is the key of all evidence. Read from the instance, it is checked before it goes into a query.
        let name = file ? rawOf(file.sys_update_name) : (updateName ?? '')
        if (file && !name) {
          const kind = rawOf(file.sys_class_name)
          const own = NAMED_BY_CONTENT[kind]
            ? await sn.query<Record<string, string>>({ table: kind, query: `sys_id=${rawOf(file.sys_id)}`, fields: ['name', 'element', 'language'], limit: 1 }).catch(() => null)
            : null
          name = own?.records[0] ? NAMED_BY_CONTENT[kind](own.records[0]) : ''
          if (!name) {
            warnings.push('This record carries no update name. Records of this kind are captured as part of another record, or not at all, so its change history cannot be looked up.')
          }
        }
        if (name && !UPDATE_NAME.test(name)) {
          warnings.push('The update name of this record contains characters that cannot be placed into a query, so its change history was not read.')
          name = ''
        }

        // Not an application file, or deleted: its update rows still carry the sys_id at the end of their name.
        if (!file && !hidden && sysId && !name) {
          const trace = await read('sys_update_xml', `nameENDSWITH_${sysId}^ORDERBYDESCsys_updated_on`, ['name'], 1)
          const tracedName = trace?.records[0] ? rawOf(tidy(trace.records[0]).name) : ''
          if (UPDATE_NAME.test(tracedName)) name = tracedName
        }

        // A tracked record outside sys_metadata, for example a choice: read it from its own table.
        let ownTable = ''
        const tail = /^(.+)_([0-9a-f]{32})$/.exec(name)
        if (!file && !hidden && tail && isTableName(tail[1])) {
          const own = await sn
            .query<Row>({ table: tail[1], query: `sys_id=${tail[2]}`, fields: ['sys_id', 'sys_created_on', 'sys_created_by', 'sys_updated_on', 'sys_updated_by'], limit: 1, display: true })
            .catch(() => null)
          if (own?.records[0]) {
            file = tidy(own.records[0])
            ownTable = tail[1]
          }
        }

        const updatesQuery = `name=${name}^ORDERBYDESCsys_updated_on`
        const versionsQuery = `name=${name}^ORDERBYstate^ORDERBYDESCsys_created_on`
        const skipsQuery = `upgrade_detail.file_name=${name}^ORDERBYDESCsys_created_on`
        const [updates, versions, bySource, skips] = name
          ? await Promise.all([
              read('sys_update_xml', updatesQuery, ['name', 'action', 'type', 'update_set', 'sys_created_by', 'sys_created_on', 'sys_updated_by', 'sys_updated_on'], 20),
              // Sorted by state, the version marked "current" comes first.
              read('sys_update_version', versionsQuery, ['state', 'source_table', 'source', 'sys_created_by', 'sys_created_on'], 10),
              sn.groupCount('sys_update_version', 'source_table', `name=${name}`).catch(() => null as GroupCount[] | null),
              // Not a warning if this fails: it is one more witness, and many accounts cannot read it.
              sn
                .query<Row>({ table: 'upgrade_history_task', query: skipsQuery, fields: ['upgrade_detail.disposition', 'upgrade_detail.upgrade_history.to_version', 'state', 'sys_created_on'], limit: 5, display: true })
                .catch(() => null),
            ])
          : [null, null, null, null]

        const updateRows = updates?.records.map(tidy) ?? []
        const versionRows = versions?.records.map(tidy) ?? []
        const current = versionRows.find((row) => rawOf(row.state) === 'current') ?? null
        const sources = bySource ? Object.fromEntries(bySource.map((group) => [group.value || 'unknown', group.count])) : null
        const vendorVersions = sources ? Object.entries(sources).filter(([table]) => VENDOR_SOURCES.has(table)).reduce((sum, [, count]) => sum + count, 0) : null
        const customerVersions = sources ? Object.entries(sources).filter(([table]) => CUSTOMER_SOURCES.has(table)).reduce((sum, [, count]) => sum + count, 0) : null
        const otherSources = sources ? Object.keys(sources).filter((table) => !VENDOR_SOURCES.has(table) && !CUSTOMER_SOURCES.has(table)) : []
        if (otherSources.length) warnings.push(`Some versions come from a source this tool does not classify: ${otherSources.join(', ')}.`)
        if (name && !sources) warnings.push('The versions per source could not be counted (Aggregate API), so it is not known whether a vendor version of this record exists.')

        const captured = updates?.total ?? (updates ? updateRows.length : null)
        const currentFromCustomer = current ? CUSTOMER_SOURCES.has(rawOf(current.source_table)) : false
        let divergence: Divergence = 'unknown'
        if ((captured ?? 0) > 0 || currentFromCustomer) divergence = 'customer_changes_captured'
        else if (captured === 0 && versions && sources) divergence = 'no_customer_changes_captured'

        // The upgrade engine compares content. A record it skipped and nobody reverted differs from the vendor's version.
        const skipRows = (skips?.records.map(tidy) ?? []).map((row) => ({
          disposition: labelOf(row['upgrade_detail.disposition']),
          review: labelOf(row.state),
          upgrade: rawOf(row['upgrade_detail.upgrade_history.to_version']),
          createdOn: rawOf(row.sys_created_on),
        }))
        const skip = skipRows[0]
        const skippedAsChanged = Boolean(skip) && /^Skipped/.test(skip.disposition) && !/error/i.test(skip.disposition) && !/reverted/i.test(skip.review)
        if (divergence === 'no_customer_changes_captured' && skippedAsChanged) {
          divergence = 'changed_without_capture'
          warnings.push(
            `No customer update is captured for this record, but the upgrade to ${skip.upgrade || 'a newer version'} did not overwrite it ("${skip.disposition}"): ` +
              'it differs from the vendor version. Such a change was made without being captured, for example by a script or an installer.',
          )
        }

        if (captured === 0 && currentFromCustomer) {
          warnings.push('The current version came from an update set, but no customer update row exists for the record (its update set was deleted, or the table was cleaned). The content is local, yet an upgrade can overwrite it.')
        }
        if (divergence === 'no_customer_changes_captured' && (customerVersions ?? 0) > 0) {
          warnings.push(`${customerVersions} earlier version(s) came from update sets, but the current version is the vendor's: the change was reverted, or an upgrade replaced it.`)
        }
        // A vendor version that is newer than the last captured change means the record went back to the vendor's state.
        const lastChange = seconds(updateRows.map((row) => rawOf(row.sys_updated_on)).filter(Boolean).sort().at(-1) ?? '')
        if (current && VENDOR_SOURCES.has(rawOf(current.source_table)) && seconds(rawOf(current.sys_created_on)) >= lastChange - 5) {
          warnings.push('A customer update row exists, but the version marked current is the vendor\'s and is not older than the last captured change: the record was reverted to the vendor version while the update row stayed. An upgrade still skips it.')
        }

        // Created here, or delivered? A vendor version proves delivery. So does a record that is older than its first captured change.
        const createdOn = file ? seconds(rawOf(file.sys_created_on)) : NaN
        let firstCapturedOn = updateRows.map((row) => rawOf(row.sys_created_on)).filter(Boolean).sort()[0] ?? ''
        if (updates && (updates.total ?? 0) > updateRows.length) {
          const earliest = await read('sys_update_xml', `name=${name}^ORDERBYsys_created_on`, ['sys_created_on'], 1)
          firstCapturedOn = earliest?.records[0] ? rawOf(tidy(earliest.records[0]).sys_created_on) : ''
        }
        const firstCapture = seconds(firstCapturedOn)
        let created: 'here' | 'delivered' | 'unknown' = 'unknown'
        if ((vendorVersions ?? 0) > 0) created = 'delivered'
        else if (!Number.isNaN(createdOn) && !Number.isNaN(firstCapture)) created = createdOn < firstCapture - 5 ? 'delivered' : vendorVersions === 0 ? 'here' : 'unknown'

        if ((vendorVersions ?? 0) > 0 && !Number.isNaN(createdOn) && !Number.isNaN(firstCapture) && createdOn >= firstCapture - 5) {
          warnings.push('A vendor version of this record exists, yet the record was created at the moment of its first captured change. It may have been created here before the vendor delivered a file with the same name.')
        }

        const authors = updateRows.flatMap((row) => [rawOf(row.sys_created_by), rawOf(row.sys_updated_by)]).filter(Boolean)
        const capturedBy = !updates ? 'unknown' : !authors.length ? 'nobody' : authors.every(isSystemAccount) ? 'system_accounts' : 'people'
        if (capturedBy === 'system_accounts') {
          warnings.push('Every captured change to this record was made under a system account: an installation, an upgrade or a job, not an edit by a person. The platform still treats the record as customized.')
        }

        const packageClass = file && !ownTable ? rawOf(file['sys_package.sys_class_name']) : ''
        const provenance: Provenance = PROVENANCE[packageClass] ?? 'unknown'
        const changed = divergence === 'customer_changes_captured' || divergence === 'changed_without_capture'

        let verdict: Verdict = 'unknown'
        if (!file) {
          if (hidden) verdict = 'unknown'
          else if (updateRows.some((row) => rawOf(row.action) === 'DELETE')) verdict = 'deleted_here'
          else if (!name || (updates && versions && captured === 0 && !versionRows.length)) verdict = 'not_found'
          else if (updateRows.length || versionRows.length) {
            warnings.push('Changes are captured under this name, but the record itself is not readable: it was removed without a captured delete, or it lives in a table this account cannot read.')
          }
        } else if (provenance === 'custom_application') {
          verdict = 'custom_application_file'
        } else if (changed) {
          const delivered = (vendorVersions ?? 0) > 0
          if (provenance === 'vendor' || provenance === 'installed_application') verdict = created === 'here' ? 'customer_created' : 'customized'
          else if (delivered) verdict = 'customized'
          else if (provenance === 'global_scope' || created === 'here') verdict = 'customer_created'
        } else if (divergence === 'no_customer_changes_captured') {
          if (provenance === 'vendor' || provenance === 'installed_application' || (vendorVersions ?? 0) > 0) verdict = 'out_of_box_as_captured'
        }

        return ok({
          ...source(sn, warnings),
          verdict,
          explanation: EXPLANATIONS[verdict],
          provenance,
          divergence,
          created,
          capturedBy,
          record: file && {
            sysId: rawOf(file.sys_id),
            table: ownTable || rawOf(file.sys_class_name),
            name: rawOf(file.sys_name),
            updateName: name,
            package: labelOf(file.sys_package),
            packageClass,
            scope: labelOf(file.sys_scope),
            protection: rawOf(file.sys_policy),
            createdOn: rawOf(file.sys_created_on),
            createdBy: rawOf(file.sys_created_by),
            updatedOn: rawOf(file.sys_updated_on),
            updatedBy: rawOf(file.sys_updated_by),
          },
          evidence: {
            customerUpdates: {
              table: 'sys_update_xml',
              query: name ? updatesQuery : '',
              readable: updates !== null,
              total: updates?.total ?? null,
              firstCapturedOn: firstCapturedOn || null,
              rows: updateRows.slice(0, 10),
            },
            versions: {
              table: 'sys_update_version',
              query: name ? versionsQuery : '',
              readable: versions !== null,
              total: versions?.total ?? null,
              bySource: sources,
              current,
              rows: versionRows,
            },
            upgradeSkips: { table: 'upgrade_history_task', query: name ? skipsQuery : '', readable: skips !== null, total: skips?.total ?? null, rows: skipRows },
          },
          caveats: ORIGIN_CAVEATS,
        })
      } catch (error) {
        return fail(error, 'sys_metadata')
      }
    }),
  )
}
