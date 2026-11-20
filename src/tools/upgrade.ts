import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Row, ServiceNowClient } from '../client.js'
import { ServiceNowError, validation } from '../errors.js'
import { UPGRADE_NOTES } from '../limitations.js'
import { assertPlainValue } from '../query.js'
import { clip, fail, labelOf, listing, listShape, ok, rawOf, tidy } from '../result.js'
import { traced } from '../trace.js'
import { capturedByName, CLOSED_NAME, errorKind, isClosedRecord, knowRecordTables, leftOutNames, READ_ONLY, type Context } from './shared.js'

/** Used only if the instance does not list its own disposition codes. The answer says when that happened. */
export const FALLBACK_SKIPPED: Record<string, string> = {
  '4': 'Skipped',
  '9': 'Skipped Error',
  '10': 'Skipped Manual Merge',
  '11': 'Skipped Apply Once',
  '104': 'Skipped (second pass)',
}

/** Review states "Reverted" and "Not Reviewed", measured. Used only if the instance does not list its own codes. */
const FALLBACK_REVERTED = ['5']
const FALLBACK_NOT_REVIEWED = ['1']

export interface SkipCodes {
  /** Dispositions that mean "not overwritten because it differs". A file the upgrade could not apply is not among them. */
  skipped: Set<string>
  /** Review states that mean the record was set back to the vendor's version. */
  reverted: Set<string>
  /** Review states that mean nobody has decided yet. */
  notReviewed: Set<string>
}

const codeCache = new WeakMap<ServiceNowClient, { at: number; codes: Promise<SkipCodes> }>()

/**
 * The stored codes behind "Skipped" and "Reverted". The labels an answer carries are in the language of the account,
 * so a decision is made on the code, and the English labels of the choice lists say which codes are meant.
 */
export function skipCodes(sn: ServiceNowClient): Promise<SkipCodes> {
  const hit = codeCache.get(sn)
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.codes

  const fallback = (): SkipCodes => ({
    skipped: new Set(Object.entries(FALLBACK_SKIPPED).filter(([, label]) => !/error/i.test(label)).map(([code]) => code)),
    reverted: new Set(FALLBACK_REVERTED),
    notReviewed: new Set(FALLBACK_NOT_REVIEWED),
  })
  const entry = { at: Date.now(), codes: Promise.resolve(fallback()) }
  entry.codes = sn
    .query<Record<string, string>>({
      table: 'sys_choice',
      query: 'nameINsys_upgrade_history_log,upgrade_history_task^elementINdisposition,state^language=en^inactive=false',
      fields: ['name', 'element', 'value', 'label'],
      limit: 200,
    })
    .then(({ records }) => {
      // A code is a number. A row whose value did not come back says nothing.
      const of = (table: string, element: string, wanted: (label: string) => boolean) =>
        new Set(records.filter((row) => row.name === table && row.element === element && /^\d+$/.test(String(row.value)) && wanted(String(row.label ?? ''))).map((row) => String(row.value)))
      const skipped = of('sys_upgrade_history_log', 'disposition', (label) => label.startsWith('Skipped') && !/error/i.test(label))
      // "Reviewed and Reverted", not "Not Reverted" or "Revert Failed".
      const reverted = of('upgrade_history_task', 'state', (label) => /\breverted\b/i.test(label) && !/\bnot\b|fail/i.test(label))
      const notReviewed = of('upgrade_history_task', 'state', (label) => /^not reviewed$/i.test(label.trim()))
      return {
        skipped: skipped.size ? skipped : fallback().skipped,
        reverted: reverted.size ? reverted : fallback().reverted,
        notReviewed: notReviewed.size ? notReviewed : fallback().notReviewed,
      }
    })
    .catch(() => {
      // The built-in codes answer this call. They are not kept: the next call asks the instance again.
      if (codeCache.get(sn) === entry) codeCache.delete(sn)
      return fallback()
    })
  codeCache.set(sn, entry)
  return entry.codes
}

export interface Upgrade {
  sysId: string
  from: string
  to: string
  finished: string
  /** "family" if the release family changed (for example zurich to australia), "patch" for a patch or hotfix. */
  kind: 'family' | 'patch'
}

const family = (version: string) => /^glide-([a-z0-9]+)-/.exec(version)?.[1] ?? ''

/**
 * Platform upgrades of this instance, newest first. sys_upgrade_history also
 * holds rows for app updates and rollbacks; those are left out.
 */
export async function recentUpgrades(sn: ServiceNowClient): Promise<Upgrade[]> {
  const page = await sn.query<Record<string, string>>({
    table: 'sys_upgrade_history',
    query: 'to_versionSTARTSWITHglide-^ORDERBYDESCupgrade_finished',
    fields: ['sys_id', 'from_version', 'to_version', 'upgrade_finished'],
    limit: 30,
  })
  if (!page.records.length && (page.total ?? 0) > 0) {
    throw new ServiceNowError('sys_upgrade_history has matching rows, but this account may not read them.', 'acl', 'sys_upgrade_history')
  }

  return page.records
    .filter((row) => /^[0-9a-f]{32}$/.test(String(row.sys_id)))
    .map((row) => {
      const from = String(row.from_version ?? '')
      const to = String(row.to_version ?? '')
      return { sysId: row.sys_id, from, to, finished: String(row.upgrade_finished ?? ''), kind: family(from) && family(from) === family(to) ? 'patch' : 'family' }
    })
}

export function registerUpgradeTool(server: McpServer, ctx: Context) {
  const { sn } = ctx

  /** Disposition is an integer choice, and the set of codes differs between releases, so ask the instance. */
  async function dispositions(): Promise<{ all: Record<string, string>; skipped: Record<string, string>; from: 'instance' | 'fallback' }> {
    try {
      const { records } = await sn.query<Record<string, string>>({
        table: 'sys_choice',
        query: 'name=sys_upgrade_history_log^element=disposition^language=en^inactive=false',
        fields: ['value', 'label'],
        limit: 100,
      })
      const all = Object.fromEntries(records.filter((row) => /^\d+$/.test(String(row.value))).map((row) => [String(row.value), String(row.label ?? '')]))
      const skipped = Object.fromEntries(Object.entries(all).filter(([, label]) => label.startsWith('Skipped')))
      if (Object.keys(skipped).length) return { all, skipped, from: 'instance' }
    } catch {
      // fall through to the built-in list, which the answer reports
    }
    return { all: FALLBACK_SKIPPED, skipped: FALLBACK_SKIPPED, from: 'fallback' }
  }

  const upgradeShape = z.object({ from: z.string(), to: z.string(), finished: z.string(), kind: z.enum(['family', 'patch']) })
  const countShape = z.array(z.object({ name: z.string(), count: z.number() }))

  server.registerTool(
    'sn_upgrade_skips',
    {
      title: 'Records an upgrade skipped',
      description:
        'Return the records a platform upgrade did not overwrite. "Skipped" and "Skipped Manual Merge" mean a local ' +
        'change met a newer vendor version and needs a review; "Skipped Error" means the upgrade could not apply the ' +
        'file, which is a failure and not a customization. By default the answer covers the latest family upgrade (for ' +
        'example Zurich to Australia), names it, and lists the patches applied since with their own counts. It gives ' +
        'exact counts per disposition and per type, and how many entries nobody has reviewed. Each entry says who made ' +
        'the captured changes to the record: people, system accounts only, or nobody. Use it for "what do we have to ' +
        'review after the upgrade" and "what did people here change that the upgrade skipped". A skipped record is not ' +
        'a prediction that something breaks. For captured changes regardless of upgrades use sn_delta.',
      inputSchema: {
        upgrade: z
          .string()
          .max(120)
          .default('latest_family')
          .describe(
            '"latest_family" for the most recent change of release family, "latest" for the most recent upgrade of any ' +
              'kind (often a patch), "all" for every upgrade, or text the target version must contain, e.g. "zurich".',
          ),
        onlySkipped: z.boolean().default(true).describe('true lists skipped records only. false lists every record that has a review entry.'),
        excludeErrors: z
          .boolean()
          .default(false)
          .describe('true leaves out "Skipped Error": files the upgrade could not apply. What remains was skipped because it differs from the vendor version.'),
        unreviewedOnly: z.boolean().default(false).describe('true lists only entries in state "Not Reviewed".'),
        fileContains: z
          .string()
          .max(120)
          .optional()
          .describe('Text the file name must contain. File names begin with the table of the record, as in "sys_script_<sys_id>": "sys_script" finds business rules, and script includes and client scripts as well, whose tables begin the same way. A table name such as "incident" finds its dictionary and form entries, not its business rules.'),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      },
      outputSchema: {
        ...listShape,
        upgrade: upgradeShape.nullable().describe('The upgrade the answer covers. null when it covers several or none was found.'),
        laterUpgrades: z
          .array(upgradeShape.extend({ entries: z.number().nullable() }))
          .describe('Upgrades finished after the covered one, with the number of their entries under the same filter. Check them too.'),
        dispositionCodes: z
          .object({ skipped: z.record(z.string(), z.string()), from: z.enum(['instance', 'fallback']) })
          .describe('The disposition codes this instance counts as skipped, with their labels.'),
        byDisposition: countShape.nullable().describe('Exact counts for the whole filter. null if they could not be read.'),
        byType: countShape.nullable().describe('Exact counts for the whole filter, largest first, at most 30 types. null if they could not be read.'),
        notReviewed: z.number().nullable().describe('Entries of the whole filter in state "Not Reviewed". null if unknown.'),
        records: z
          .array(
            z.object({
              file: z.string().describe('Update name of the skipped file, e.g. "sys_script_<sys_id>". Pass it to sn_origin as updateName.'),
              target: z.string().describe('Readable name of the record, as the upgrade recorded it.'),
              type: z.string(),
              disposition: z.string().describe('What the upgrade did with the file, as a label in the language of the account.'),
              review: z.string().describe('Review state of the entry, as a label.'),
              upgrade: z.string().describe('Target version of the upgrade the entry belongs to.'),
              createdOn: z.string(),
              capturedBy: z
                .enum(['people', 'system_accounts', 'nobody'])
                .optional()
                .describe(
                  'Who made the captured changes to this record: "people" if a person is on any of its update rows, "system_accounts" if only installations, upgrades and jobs are, ' +
                    '"nobody" if no change is captured (the record differs all the same: it was changed without capture). Absent if that could not be read.',
                ),
            }),
          )
          .describe('One page of entries, newest first.'),
        capturedBy: z
          .record(z.string(), z.number())
          .describe('How many entries of this page fall under each value of "capturedBy". For the whole filter, page through it.'),
        notes: z.array(z.string()),
      },
      annotations: READ_ONLY,
    },
    traced('sn_upgrade_skips', async ({ upgrade, onlySkipped, excludeErrors, unreviewedOnly, fileContains, limit, offset }) => {
      try {
        assertPlainValue(upgrade, 'upgrade')
        if (!upgrade.trim()) throw validation('"upgrade" needs a value: "latest_family", "latest", "all", or text the target version contains.')
        if (fileContains) assertPlainValue(fileContains, 'fileContains')

        const warnings: string[] = []
        let covered: Upgrade | null = null
        let later: Upgrade[] = []
        let upgradeFilter = ''

        if (upgrade === 'latest_family' || upgrade === 'latest') {
          let upgrades: Upgrade[] = []
          try {
            upgrades = await recentUpgrades(sn)
          } catch (error) {
            warnings.push(`sys_upgrade_history could not be read (${errorKind(error)}), so the answer covers every upgrade and cannot name them.`)
          }
          const index = upgrade === 'latest' ? 0 : upgrades.findIndex((item) => item.kind === 'family')
          if (upgrades.length && index === -1) {
            warnings.push('No change of release family is recorded among the last 30 upgrades, so the answer covers the most recent upgrade instead.')
          }
          covered = upgrades[Math.max(index, 0)] ?? null
          if (covered) {
            later = upgrades.slice(0, Math.max(index, 0))
            upgradeFilter = `upgrade_detail.upgrade_history=${covered.sysId}`
          } else if (!warnings.length) {
            warnings.push('No platform upgrade is recorded in sys_upgrade_history, so the answer covers everything there is.')
          }
        } else if (upgrade !== 'all') {
          upgradeFilter = `upgrade_detail.upgrade_history.to_versionLIKE${upgrade}`
        }

        const disposition = await dispositions()
        if (disposition.from === 'fallback' && (onlySkipped || excludeErrors)) {
          warnings.push(
            `The instance did not list its disposition codes, so a built-in list was used to find ${onlySkipped ? 'skipped records' : 'the files an upgrade could not apply'}. ` +
              'The set of codes differs between releases: check byDisposition.',
          )
        }

        const isError = (code: string) => /error/i.test(disposition.all[code] ?? '')
        const wanted = Object.keys(disposition.skipped).filter((code) => !(excludeErrors && isError(code)))
        const errorCodes = Object.keys(disposition.all).filter(isError)
        if (onlySkipped && !wanted.length) {
          throw validation('On this instance every disposition that says "skipped" is one of a file the upgrade could not apply, so onlySkipped together with excludeErrors leaves nothing to ask for. Drop one of the two.')
        }
        const reviewCodes = await skipCodes(sn)
        // Measured: "NOT IN" leaves out the rows where the field is empty. An entry without a disposition is no error.
        const noErrors = `upgrade_detail.dispositionNOT IN${errorCodes.join(',')}^ORupgrade_detail.dispositionISEMPTY`
        const shared = [
          onlySkipped ? `upgrade_detail.dispositionIN${wanted.join(',')}` : excludeErrors && errorCodes.length ? noErrors : '',
          fileContains ? `upgrade_detail.file_nameLIKE${fileContains}` : '',
          unreviewedOnly ? `stateIN${[...reviewCodes.notReviewed].join(',')}` : '',
        ].filter(Boolean)
        const filter = [upgradeFilter, ...shared].filter(Boolean).join('^')

        const counts = (groupBy: string, query: string, labels = false) => sn.groupCount('upgrade_history_task', groupBy, query, labels).catch(() => null)
        const [page, perDisposition, types, states, perUpgrade] = await Promise.all([
          sn.query<Row>({
            table: 'upgrade_history_task',
            query: [filter, 'ORDERBYDESCsys_created_on'].filter(Boolean).join('^'),
            fields: [
              'upgrade_detail.file_name',
              'upgrade_detail.target_name',
              'upgrade_detail.type',
              'upgrade_detail.disposition',
              'upgrade_detail.upgrade_history.to_version',
              'state',
              'sys_created_on',
            ],
            limit,
            offset,
            display: true,
          }),
          counts('upgrade_detail.disposition', filter),
          // With its label, as the rows carry it.
          counts('upgrade_detail.type', filter, true),
          counts('state', filter),
          later.length ? counts('upgrade_detail.upgrade_history', shared.join('^')) : Promise.resolve([]),
        ])

        // Who made the captured changes to each of these records, asked for the whole page at once.
        const authors = await capturedByName(ctx, page.records.map((row) => rawOf(tidy(row)['upgrade_detail.file_name'])), (kind) =>
          warnings.push(`Who captured the changes to these records could not be read (sys_update_xml: ${kind}), so some entries carry no "capturedBy".`),
        )
        const named = await knowRecordTables(ctx, page.records.map((row) => rawOf(tidy(row)['upgrade_detail.file_name'])))
        warnings.push(...leftOutNames(named))
        const rows = await Promise.all(
          page.records.map(tidy).map(async (row) => ({
            file: rawOf(row['upgrade_detail.file_name']),
            target: (await isClosedRecord(ctx, rawOf(row['upgrade_detail.file_name']), named)) ? CLOSED_NAME : rawOf(row['upgrade_detail.target_name']),
            type: labelOf(row['upgrade_detail.type']),
            disposition: labelOf(row['upgrade_detail.disposition']),
            review: labelOf(row.state),
            upgrade: rawOf(row['upgrade_detail.upgrade_history.to_version']),
            createdOn: rawOf(row.sys_created_on),
            ...(authors.has(rawOf(row['upgrade_detail.file_name'])) ? { capturedBy: authors.get(rawOf(row['upgrade_detail.file_name']))! } : {}),
          })),
        )
        if (rows.length && rows.every((row) => !row.file)) {
          warnings.push('The entries came back without file names: the upgrade details behind them are not readable for this account, so the filter on disposition may not have been applied either.')
        }
        if (!perDisposition || !types || !states) warnings.push('Some of the counts could not be read (Aggregate API). The list itself is valid.')
        // A list that is cut says so: a sum over it is then no total.
        for (const [label, groups] of [['byType', types], ['byDisposition', perDisposition]] as const) {
          if (groups && groups.length > 30) warnings.push(`${label} lists the 30 largest of ${groups.length} groups: "total" counts every entry, a sum over ${label} does not.`)
        }

        const byName = (groups: Array<{ value: string; count: number; display?: string }> | null, name: (group: { value: string; display?: string }) => string, top = 30) =>
          // Groups of the same size in the order of their names, so that the cut is the same on every call.
          groups && groups.map((group) => ({ name: name(group) || '(empty)', count: group.count })).sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).slice(0, top)
        const errors = perDisposition?.filter((group) => isError(group.value)).reduce((sum, group) => sum + group.count, 0) ?? 0
        const records = clip(rows, warnings)
        const perAuthor: Record<string, number> = {}
        for (const row of records) if (row.capturedBy) perAuthor[row.capturedBy] = (perAuthor[row.capturedBy] ?? 0) + 1

        return ok({
          ...listing(sn, page, warnings, records.length),
          upgrade: covered && { from: covered.from, to: covered.to, finished: covered.finished, kind: covered.kind },
          laterUpgrades: later.map((item) => ({
            from: item.from,
            to: item.to,
            finished: item.finished,
            kind: item.kind,
            entries: perUpgrade ? (perUpgrade.find((group) => group.value === item.sysId)?.count ?? 0) : null,
          })),
          dispositionCodes: { skipped: disposition.skipped, from: disposition.from },
          byDisposition: byName(perDisposition, (group) => disposition.all[group.value] ?? group.value),
          byType: byName(types, (group) => group.display ?? group.value),
          notReviewed: states ? states.filter((group) => reviewCodes.notReviewed.has(group.value)).reduce((sum, group) => sum + group.count, 0) : null,
          records,
          capturedBy: perAuthor,
          notes: [
            page.total === 0
              ? fileContains || unreviewedOnly
                ? 'No entry matches this filter. That says nothing about entries outside it.'
                : 'No matching entries. That is expected on an instance that was never upgraded, or for an upgrade that touched no changed record.'
              : 'An entry in state "Not Reviewed" still needs a decision: keep the local version, merge, or revert to the vendor version.',
            ...(errors ? [`${errors} of the entries are "Skipped Error": the upgrade could not apply the file. That is a failure to look into, not a customization.`] : []),
            ...UPGRADE_NOTES,
          ],
        })
      } catch (error) {
        return fail(error, 'upgrade_history_task', sn)
      }
    }),
  )
}
