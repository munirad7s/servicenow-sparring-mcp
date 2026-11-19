import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Row } from '../client.js'
import { UPGRADE_NOTES } from '../limitations.js'
import { assertPlainValue } from '../query.js'
import { clip, fail, labelOf, listing, listShape, ok, rawOf, rowSchema, tally, tidy } from '../result.js'
import { READ_ONLY, type Context } from './shared.js'

/** Used only if the instance does not list its own disposition codes. The answer says when that happened. */
const FALLBACK_SKIPPED_CODES = ['9', '10', '11', '104']

export function registerUpgradeTool(server: McpServer, ctx: Context) {
  const { sn } = ctx

  /** Disposition is an integer choice, and the set of codes differs between releases, so ask the instance. */
  async function skippedCodes(): Promise<{ codes: string[]; from: 'instance' | 'fallback' }> {
    try {
      const { records } = await sn.query<{ value: string }>({
        table: 'sys_choice',
        query: 'name=sys_upgrade_history_log^element=disposition^labelLIKESkipped',
        fields: ['value', 'label'],
        limit: 50,
      })
      const codes = [...new Set(records.map((row) => String(row.value)).filter((code) => /^\d+$/.test(code)))]
      if (codes.length) return { codes, from: 'instance' }
    } catch {
      // fall through to the fallback, which the answer reports
    }
    return { codes: FALLBACK_SKIPPED_CODES, from: 'fallback' }
  }

  server.registerTool(
    'sn_upgrade_skips',
    {
      title: 'Records an upgrade skipped',
      description:
        'Return the records an upgrade did not overwrite because they were customized. Each one is a place where a ' +
        'local change met a newer vendor version and still needs a review. By default the answer covers the latest ' +
        'family upgrade and names it; pass upgrade "all" for every upgrade, or part of a version name. Use it for ' +
        '"what do we have to review after the upgrade" and as input for upgrade risk. A skipped record needs review; it ' +
        'is not a prediction that something breaks. For captured changes regardless of upgrades use sn_delta.',
      inputSchema: {
        upgrade: z
          .string()
          .default('latest')
          .describe('"latest" for the most recent family upgrade, "all" for every upgrade, or text the target version must contain, e.g. "zurich".'),
        onlySkipped: z.boolean().default(true).describe('true lists skipped records only. false also lists what was merged or reverted.'),
        unreviewedOnly: z.boolean().default(false).describe('true lists only entries nobody has reviewed yet.'),
        fileContains: z.string().optional().describe('Text the file name must contain, e.g. "sys_script" or "incident".'),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      },
      outputSchema: {
        ...listShape,
        upgrade: z
          .object({ from: z.string(), to: z.string(), finished: z.string() })
          .nullable()
          .describe('The upgrade the answer covers. null when it covers all upgrades or none was found.'),
        dispositionCodes: z.object({ codes: z.array(z.string()), from: z.enum(['instance', 'fallback', 'not_used']) }),
        byDisposition: z.record(z.string(), z.number()).describe('Counts within the returned rows.'),
        byType: z.record(z.string(), z.number()).describe('Counts within the returned rows.'),
        records: z.array(rowSchema),
        notes: z.array(z.string()),
      },
      annotations: READ_ONLY,
    },
    async ({ upgrade, onlySkipped, unreviewedOnly, fileContains, limit, offset }) => {
      try {
        assertPlainValue(upgrade, 'upgrade')
        if (fileContains) assertPlainValue(fileContains, 'fileContains')

        const warnings: string[] = []
        let covered: { from: string; to: string; finished: string } | null = null
        let upgradeFilter = ''

        if (upgrade === 'latest') {
          const { records } = await sn.query<Record<string, string>>({
            table: 'sys_upgrade_history',
            query: 'to_versionSTARTSWITHglide-^ORDERBYDESCupgrade_finished',
            fields: ['sys_id', 'from_version', 'to_version', 'upgrade_finished'],
            limit: 1,
          })
          const latest = records[0]
          if (latest) {
            covered = { from: latest.from_version ?? '', to: latest.to_version ?? '', finished: latest.upgrade_finished ?? '' }
            upgradeFilter = `upgrade_detail.upgrade_history=${latest.sys_id}`
          } else {
            warnings.push('No family upgrade was found in sys_upgrade_history, so the answer covers all upgrades.')
          }
        } else if (upgrade !== 'all') {
          upgradeFilter = `upgrade_detail.upgrade_history.to_versionLIKE${upgrade}`
        }

        const disposition = onlySkipped ? await skippedCodes() : { codes: [] as string[], from: 'not_used' as const }
        if (disposition.from === 'fallback') {
          warnings.push(
            'The instance did not list its disposition codes, so a built-in list was used to find skipped records. ' +
              'The set of codes differs between releases: check the byDisposition labels.',
          )
        }

        const page = await sn.query<Row>({
          table: 'upgrade_history_task',
          query: [
            upgradeFilter,
            onlySkipped ? `upgrade_detail.dispositionIN${disposition.codes.join(',')}` : '',
            unreviewedOnly ? 'state=1' : '',
            fileContains ? `upgrade_detail.file_nameLIKE${fileContains}` : '',
            'ORDERBYDESCsys_created_on',
          ]
            .filter(Boolean)
            .join('^'),
          fields: [
            'upgrade_detail.file_name',
            'upgrade_detail.type',
            'upgrade_detail.disposition',
            'upgrade_detail.upgrade_history.to_version',
            'state',
            'sys_created_on',
          ],
          limit,
          offset,
          display: true,
        })

        const rows = page.records.map(tidy).map((row) => ({
          file: rawOf(row['upgrade_detail.file_name']),
          type: labelOf(row['upgrade_detail.type']),
          disposition: row['upgrade_detail.disposition'],
          reviewState: row.state,
          upgrade: rawOf(row['upgrade_detail.upgrade_history.to_version']),
          createdOn: rawOf(row.sys_created_on),
        }))

        return ok({
          ...listing(sn, page, warnings),
          upgrade: covered,
          dispositionCodes: disposition,
          byDisposition: tally(rows, (row) => labelOf(row.disposition)),
          byType: tally(rows, (row) => row.type),
          records: clip(rows, warnings),
          notes: [
            page.total === 0
              ? 'No matching entries. That is expected on an instance that was never upgraded, or when everything was reviewed.'
              : 'Each entry needs a decision: keep the local version, merge, or revert to the vendor version.',
            ...UPGRADE_NOTES,
          ],
        })
      } catch (error) {
        return fail(error, 'upgrade_history_task')
      }
    },
  )
}
