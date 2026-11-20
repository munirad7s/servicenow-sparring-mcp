import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Page, Row, ServiceNowClient } from '../client.js'
import { validation } from '../errors.js'
import { ORIGIN_CAVEATS } from '../limitations.js'
import { assertSysId, isGeneratedSysId, isTableName } from '../query.js'
import { fail, labelOf, ok, rawOf, rowSchema, source, sourceShape, tidy, withheldWarning } from '../result.js'
import { traced } from '../trace.js'
import { CLOSED_NAME, errorKind, isClosedRecord, isSystemAccount, NO_CONNECTION, READ_ONLY, withPeopleOnly, type Context } from './shared.js'
import { skipCodes } from './upgrade.js'

const UPDATE_NAME = /^[A-Za-z0-9_.-]{1,250}$/
/** What a sys_id read from the instance must look like before it goes into a query. */
const SAFE_ID = /^[0-9A-Za-z_]{1,32}$/

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
  sys_dictionary: (row) => (row.name ? `sys_dictionary_${row.name}_${row.element || 'null'}` : ''),
  sys_documentation: (row) => (row.name && row.language ? `sys_documentation_${row.name}_${row.element ?? ''}_${row.language}` : ''),
}
const NAME_BY_CONTENT = /^(sys_dictionary|sys_documentation)_([a-z0-9_]+)$/

/**
 * The fields the platform adds to every table. Measured: their dictionary entries
 * and labels belong to no package, and they are nine in ten of all entries without one.
 */
const SYSTEM_FIELDS = new Set(['sys_id', 'sys_created_on', 'sys_created_by', 'sys_updated_on', 'sys_updated_by', 'sys_mod_count', 'sys_class_name', 'sys_class_path', 'sys_domain', 'sys_domain_path'])

const FILE_FIELDS = [
  'sys_id',
  'sys_class_name',
  'sys_name',
  'sys_update_name',
  'sys_package',
  'sys_package.sys_class_name',
  'sys_scope',
  'sys_scope.scope',
  'sys_policy',
  'sys_created_on',
  'sys_created_by',
  'sys_updated_on',
  'sys_updated_by',
]

/** true if rows that match were not returned: access rules hide them from the account. */
const hidesRows = (page: Page<unknown> | null) =>
  Boolean(page && page.total !== null && page.records.length < Math.min(page.limit, Math.max(page.total - page.offset, 0)))

/** true if more rows match than the page holds, or if that cannot be ruled out because the instance gave no total. */
const mayHaveMore = (page: Page<unknown> | null) => Boolean(page && (page.total !== null ? page.total > page.offset + page.records.length : page.records.length >= page.limit))

/**
 * The query that finds the record such a name was built from. The name does not
 * say where the table name ends and the field name begins, so every split is a
 * candidate; the caller keeps the row whose name comes out the same.
 */
export function queryByContent(updateName: string): { table: string; query: string } | null {
  const match = NAME_BY_CONTENT.exec(updateName)
  if (!match) return null
  const [, table] = match
  let body = match[2]
  let language = ''
  if (table === 'sys_documentation') {
    // Measured: the languages of an instance are two letters each (en, de, pb, zt), without an underscore.
    const cut = body.lastIndexOf('_')
    language = body.slice(cut + 1)
    body = cut < 0 ? '' : body.slice(0, cut)
    if (!language) return null
  }

  const splits = [...body.matchAll(/_/g)].map((at) => [body.slice(0, at.index), body.slice(at.index + 1)]).filter(([name]) => isTableName(name))
  // The entry of a table itself has no element: it is named "..._null", and its label "...__<language>".
  const none = (element: string) => element === '' || (table === 'sys_dictionary' && element === 'null')
  const elements = [...new Set(splits.map(([, element]) => element).filter((element) => !none(element)))]
  const element = [elements.length ? `elementIN${elements.join(',')}` : '', splits.some(([, item]) => none(item)) ? 'elementISEMPTY' : ''].filter(Boolean).join('^OR')
  if (!element) return null

  const names = [...new Set(splits.map(([name]) => name))]
  return { table, query: [`nameIN${names.join(',')}`, element, language ? `language=${language}` : ''].filter(Boolean).join('^') }
}

/** Where a version came from. A version from an upgrade or an app installation is the vendor's own. */
const VENDOR_SOURCES = new Set(['sys_upgrade_history', 'sys_store_app'])
const CUSTOMER_SOURCES = new Set(['sys_update_set', 'sys_remote_update_set', 'sys_app_customization'])

type Provenance = 'vendor' | 'installed_application' | 'company_application' | 'custom_application' | 'global_scope' | 'unknown'
type Divergence = 'customer_changes_captured' | 'changed_without_capture' | 'no_customer_changes_captured' | 'unknown'
type Verdict = keyof typeof EXPLANATIONS

const EXPLANATIONS = {
  out_of_box_as_captured: 'Delivered with the platform or an installed application, and no customer change is captured for it on this instance.',
  customized: 'Delivered with the platform or an installed application, and changed on this instance.',
  customer_created: 'Created on or for this instance. It is not part of what the vendor delivered.',
  custom_application_file: 'Part of an application developed on this instance.',
  deleted_here: 'The record no longer exists, and the last captured customer update deleted it.',
  not_found: 'No record with this identity is readable, and no change is captured for it. It may not exist, or it may be a data record that is not tracked.',
  unknown: 'The evidence does not decide it. See the evidence, the warnings and the caveats.',
}
const COMPANY_APPLICATION =
  "Part of an application this company develops: its scope carries the company's own prefix. It was installed here from the company's repository, so it is neither the vendor's nor a change to a vendor's file."

const seconds = (stamp: string) => (stamp ? Date.parse(`${stamp.replace(' ', 'T')}Z`) / 1000 : NaN)

/** Leaves out what is empty, so that the evidence stays short. */
const compact = <T extends Row>(row: T): T => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== '' && value !== null && value !== undefined)) as T

const prefixCache = new WeakMap<ServiceNowClient, Promise<string>>()

/**
 * The prefix the applications of this company carry in their scope: "x_<code>_".
 * An application a company develops on one instance and installs on another from
 * its repository arrives there like one from the store. The prefix is what tells
 * them apart. Empty if the property cannot be read.
 */
function companyPrefix(sn: ServiceNowClient): Promise<string> {
  let known = prefixCache.get(sn)
  if (!known) {
    known = sn
      .query<Record<string, string>>({ table: 'sys_properties', query: 'name=glide.appcreator.company.code', fields: ['name', 'value'], limit: 1 })
      .then((page) => page.records.find((row) => row.name === 'glide.appcreator.company.code')?.value ?? '')
      .then((code) => (/^[a-z0-9]{1,40}$/i.test(code) ? `x_${code.toLowerCase()}_` : ''))
      .catch(() => '')
    prefixCache.set(sn, known)
  }
  return known
}

export function registerOriginTool(server: McpServer, ctx: Context) {
  const { sn } = ctx

  server.registerTool(
    'sn_origin',
    {
      title: 'Is this record out-of-the-box or custom?',
      description:
        'Judge one configuration record (a business rule, a field, an ACL, a UI action). Answers separately: who ' +
        'delivered it (from the package it belongs to), whether it was changed here (customer update rows, the ' +
        'current version, and whether an upgrade refused to overwrite it), whether it was created here or delivered ' +
        '(baseline version and creation time), and whether people or only system accounts made the captured changes. Returns a verdict with the evidence rows ' +
        'and the queries behind them. The verdict is "unknown" when the evidence does not decide it, and the ' +
        'explanation then says why. Identify the record by sysId, or by updateName such as "sys_script_<sys_id>" or ' +
        '"sys_dictionary_incident_u_field". Find sys_ids with sn_query or sn_dependencies.',
      inputSchema: {
        sysId: z.string().max(32).optional().describe('sys_id of the record. Give this or updateName, not both.'),
        updateName: z.string().max(250).optional().describe('Update name of the record, e.g. "sys_script_<sys_id>" or "sys_dictionary_incident_u_field".'),
      },
      outputSchema: {
        ...sourceShape,
        verdict: z.enum(['out_of_box_as_captured', 'customized', 'customer_created', 'custom_application_file', 'deleted_here', 'not_found', 'unknown']),
        explanation: z.string(),
        provenance: z
          .enum(['vendor', 'installed_application', 'company_application', 'custom_application', 'global_scope', 'unknown'])
          .describe(
            'Kind of package the record belongs to. "company_application": an installed application whose scope carries this company\'s own prefix, so the company develops it elsewhere. ' +
              '"unknown": no package, or one that could not be read.',
          ),
        divergence: z
          .enum(['customer_changes_captured', 'changed_without_capture', 'no_customer_changes_captured', 'unknown'])
          .describe('"changed_without_capture": no customer update exists, but an upgrade skipped the record because it differs from the vendor version.'),
        created: z
          .enum(['here', 'delivered', 'unknown'])
          .describe(
            '"delivered" if a vendor version of the record exists, or if it belongs to a delivered package and is older than its first captured change. ' +
              '"here" if no vendor version exists and the record is as old as its first captured change, or belongs to no package and was changed here. "unknown" otherwise.',
          ),
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
            .describe('Upgrades that did not overwrite this record. The upgrade engine compares content, so it also finds changes nobody captured. "target" is the name the upgrade gives the record.'),
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
            // A wrong login or an unreachable instance is not a missing piece of evidence: the call fails.
            if (NO_CONNECTION.has(errorKind(error))) throw error
            warnings.push(`${table} could not be read (${errorKind(error)}), so that part of the evidence is missing.`)
            return null
          }
        }

        // ---------------------------------------------------------------- the record

        const found = await read('sys_metadata', sysId ? `sys_id=${sysId}` : `sys_update_name=${updateName}`, FILE_FIELDS, 1)
        let file = found?.records[0] ? tidy(found.records[0]) : null
        const hidden = Boolean(found) && !file && (found?.total ?? 0) > 0
        // true where it could not be established whether the record exists: then "not found" is not an answer.
        let untraceable = !found || (!file && found.total === null)
        let name = ''
        // For a dictionary entry or a label: the table and the field it describes. "asked" if that was already looked up.
        let describes: Record<string, string> | null = null
        let asked = false

        // A dictionary entry or a label that was never captured stores no update name. Asked for by the name it would
        // get, it is found by what it describes. Measured: two in three dictionary entries of an instance are like that.
        const described = !file && !hidden && found && updateName ? queryByContent(updateName) : null
        if (described && updateName) {
          const own = await sn
            .query<Row>({ table: described.table, query: described.query, fields: [...FILE_FIELDS, 'name', 'element', 'language'], limit: 50, display: true })
            .catch((error) => errorKind(error))
          const what = (row: Row) => ({ name: rawOf(row.name), element: rawOf(row.element), language: rawOf(row.language) })
          const hit = typeof own === 'string' ? undefined : own.records.map(tidy).find((row) => NAMED_BY_CONTENT[described.table](what(row)) === updateName)
          if (hit) {
            file = hit
            name = updateName
            describes = what(hit)
            asked = true
          } else if (typeof own === 'string' ? own !== 'not_found' : hidesRows(own) || mayHaveMore(own)) {
            untraceable = true
            warnings.push(`${described.table} could not be read completely, so it is not known whether a record of this name exists.`)
          }
        }
        if (hidden) warnings.push('The record exists, but this account may not read it (row-level access rule). Nothing about it could be checked.')

        // The update name is the key of all evidence. Read from the instance, it is checked before it goes into a query.
        if (!name) name = file ? rawOf(file.sys_update_name) : (updateName ?? '')
        const kind = file ? rawOf(file.sys_class_name) : ''
        const fileId = file && SAFE_ID.test(rawOf(file.sys_id)) ? rawOf(file.sys_id) : ''
        if (file && !name) {
          if (!NAMED_BY_CONTENT[kind]) {
            warnings.push('This record carries no update name. Records of this kind are captured as part of another record, or not at all, so its change history cannot be looked up.')
          } else {
            const own = fileId
              ? await sn.query<Record<string, string>>({ table: kind, query: `sys_id=${fileId}`, fields: ['name', 'element', 'language'], limit: 1 }).catch((error) => errorKind(error))
              : 'invalid_response'
            asked = true
            describes = typeof own === 'string' ? null : (own.records[0] ?? null)
            name = describes ? NAMED_BY_CONTENT[kind](describes) : ''
            if (!name) {
              warnings.push(
                `The update name of this record is built from the table and field it describes, and those could not be read from ${kind}` +
                  `${typeof own === 'string' ? ` (${own})` : ''}, so its change history was not looked up.`,
              )
            }
          }
        }
        if (name && !UPDATE_NAME.test(name)) {
          warnings.push('The update name of this record contains characters that cannot be placed into a query, so its change history was not read.')
          name = ''
        }

        // Not an application file, or deleted: its update rows still carry the sys_id at the end of their name.
        if (!file && !hidden && sysId && !name) {
          if (isGeneratedSysId(sysId)) {
            const trace = await read('sys_update_xml', `nameENDSWITH_${sysId}^ORDERBYDESCsys_updated_on`, ['name'], 1)
            const tracedName = trace?.records[0] ? rawOf(tidy(trace.records[0]).name) : ''
            if (UPDATE_NAME.test(tracedName)) name = tracedName
            // Not readable, or rows exist that this account cannot see: then "no trace" is not established.
            if (!trace || (!trace.records.length && trace.total !== 0)) untraceable = true
          } else {
            // A word like "category" at the end of a name would match the update rows of other records.
            untraceable = true
            warnings.push('This sys_id is not of the generated form (32 hexadecimal digits), so customer updates could not be searched for by it. Give the update name instead.')
          }
        }

        // A tracked record outside sys_metadata, for example a choice: read it from its own table.
        let ownTable = ''
        const tail = /^(.+)_([0-9a-f]{32})$/.exec(name)
        if (!file && !hidden && tail && isTableName(tail[1])) {
          const own = await sn
            .query<Row>({ table: tail[1], query: `sys_id=${tail[2]}`, fields: ['sys_id', 'sys_created_on', 'sys_created_by', 'sys_updated_on', 'sys_updated_by'], limit: 1, display: true })
            .catch((error) => errorKind(error))
          if (typeof own !== 'string' && own.records[0]) {
            file = tidy(own.records[0])
            ownTable = tail[1]
            // The record is at hand: that sys_metadata could not be asked no longer leaves its existence open.
            untraceable = false
          } else if (typeof own === 'string' ? own !== 'not_found' : own.total !== 0) {
            // The table exists but could not be read, or the row is hidden: "no such record" is not established.
            untraceable = true
            warnings.push(`The record could not be read from "${tail[1]}", so it is not known whether it still exists.`)
          }
        }

        // -------------------------------------------------------------- the evidence

        const updatesQuery = `name=${name}^ORDERBYDESCsys_updated_on`
        const versionsQuery = `name=${name}^ORDERBYstate^ORDERBYDESCsys_created_on`
        const skipsQuery = `upgrade_detail.file_name=${name}^ORDERBYDESCsys_created_on`
        const [updates, versions, skips] = name
          ? await Promise.all([
              read('sys_update_xml', updatesQuery, ['name', 'action', 'type', 'update_set', 'replace_on_upgrade', 'sys_created_by', 'sys_created_on', 'sys_updated_by', 'sys_updated_on'], 20),
              // Sorted by state, the version marked "current" comes first among the states an instance has by default.
              read('sys_update_version', versionsQuery, ['state', 'source_table', 'source', 'sys_created_by', 'sys_created_on'], 10),
              // Not a warning if this fails: it is one more witness, and many accounts cannot read it.
              sn
                .query<Row>({
                  table: 'upgrade_history_task',
                  query: skipsQuery,
                  fields: ['upgrade_detail.disposition', 'upgrade_detail.target_name', 'upgrade_detail.upgrade_history.to_version', 'state', 'sys_created_on'],
                  limit: 10,
                  display: true,
                })
                .catch(() => null),
            ])
          : [null, null, null]

        if (updates) withheldWarning('Customer updates', updates, warnings)
        if (versions) withheldWarning('Versions', versions, warnings)
        const updateRows = updates?.records.map(tidy) ?? []
        const versionRows = versions?.records.map(tidy) ?? []
        const everyVersionShown = Boolean(versions) && !hidesRows(versions) && !mayHaveMore(versions)

        // The version marked current. With more versions than the page holds it is asked for by its state.
        let current = versionRows.find((row) => rawOf(row.state) === 'current') ?? null
        let currentHidden = !current && hidesRows(versions)
        if (!current && versions && !everyVersionShown && !currentHidden) {
          const marked = await read('sys_update_version', `name=${name}^state=current^ORDERBYDESCsys_created_on`, ['state', 'source_table', 'source', 'sys_created_by', 'sys_created_on'], 1)
          current = marked?.records[0] ? tidy(marked.records[0]) : null
          currentHidden = !marked || hidesRows(marked)
        }

        // Versions per source. Counted here when every version is in view, asked for otherwise.
        let sources: Record<string, number> | null = null
        if (everyVersionShown) {
          sources = {}
          for (const row of versionRows) sources[rawOf(row.source_table) || 'unknown'] = (sources[rawOf(row.source_table) || 'unknown'] ?? 0) + 1
        } else if (versions) {
          const counted = await sn.groupCount('sys_update_version', 'source_table', `name=${name}`).catch(() => null)
          sources = counted && Object.fromEntries(counted.map((group) => [group.value || 'unknown', group.count]))
        }
        const sum = (wanted: Set<string>) => (sources ? Object.entries(sources).filter(([table]) => wanted.has(table)).reduce((total, [, count]) => total + count, 0) : null)
        const vendorVersions = sum(VENDOR_SOURCES)
        const customerVersions = sum(CUSTOMER_SOURCES)
        const otherSources = sources ? Object.keys(sources).filter((table) => !VENDOR_SOURCES.has(table) && !CUSTOMER_SOURCES.has(table)) : []
        if (otherSources.length) warnings.push(`Some versions come from a source this tool does not classify: ${otherSources.join(', ')}.`)
        if (versions && !sources) warnings.push('The versions per source could not be counted (Aggregate API), so it is not known whether a vendor version of this record exists.')

        // --------------------------------------------------------- was it changed here

        // Rows known to exist. null if that is not known: no total, and a full page.
        const captured = !updates ? null : (updates.total ?? (mayHaveMore(updates) ? null : updateRows.length))
        const hasUpdates = updateRows.length > 0 || (captured ?? 0) > 0
        const currentSource = current ? rawOf(current.source_table) : ''
        const currentFromCustomer = CUSTOMER_SOURCES.has(currentSource)
        // A current version from a source that is neither the vendor's nor an update set: whose content it is, is not known.
        const currentUnclassified = Boolean(current) && !currentFromCustomer && !VENDOR_SOURCES.has(currentSource)
        let divergence: Divergence = 'unknown'
        if (hasUpdates || currentFromCustomer) divergence = 'customer_changes_captured'
        else if (captured === 0 && versions && sources && !currentHidden && !currentUnclassified) divergence = 'no_customer_changes_captured'

        // The upgrade engine compares content. A record it skipped and nobody reverted differs from the vendor's version.
        // The decision is made on the stored codes: the labels come in the language of the account.
        const skipRecords = skips?.records.map(tidy) ?? []
        const codes = skipRecords.length ? await skipCodes(sn) : null
        const skipRows = skipRecords.map((row) => ({
          disposition: labelOf(row['upgrade_detail.disposition']),
          review: labelOf(row.state),
          target: isClosedRecord(sn, name) ? CLOSED_NAME : rawOf(row['upgrade_detail.target_name']),
          upgrade: rawOf(row['upgrade_detail.upgrade_history.to_version']),
          createdOn: rawOf(row.sys_created_on),
        }))
        // The newest entry that says "not overwritten because it differs". A file an upgrade could not apply says nothing.
        const at = skipRecords.findIndex((row) => codes?.skipped.has(rawOf(row['upgrade_detail.disposition'])))
        const skip = at >= 0 ? skipRows[at] : undefined
        const reverted = at >= 0 && Boolean(codes?.reverted.has(rawOf(skipRecords[at].state)))
        // A vendor version that became current after the skip means a later upgrade applied the record: it no longer differs.
        const appliedSince = Boolean(skip) && VENDOR_SOURCES.has(currentSource) && seconds(rawOf(current?.sys_created_on)) > seconds(skip?.createdOn ?? '')
        const skippedAsChanged = Boolean(skip) && !reverted && !appliedSince
        if (divergence === 'no_customer_changes_captured' && !skippedAsChanged && (hidesRows(skips) || (!skip && mayHaveMore(skips)))) {
          divergence = 'unknown'
          warnings.push('An upgrade has an entry for this record that this account cannot see, so it is not known whether the upgrade found it changed.')
        }
        if (divergence === 'no_customer_changes_captured' && skip && skippedAsChanged) {
          divergence = 'changed_without_capture'
          warnings.push(
            `No customer update is captured for this record, but the upgrade to ${skip.upgrade || 'a newer version'} did not overwrite it ("${skip.disposition}"): ` +
              'it differs from the vendor version. Such a change was made without being captured, for example by a script or an installer.',
          )
        }

        if (currentUnclassified) {
          warnings.push(`The version marked current comes from "${currentSource}", a source this tool does not classify, so it is not known whose content the record holds.`)
        }
        if (captured === 0 && currentFromCustomer) {
          warnings.push('The current version came from an update set, but no customer update row exists for the record (its update set was deleted, or the table was cleaned). The content is local, yet an upgrade can overwrite it.')
        }
        if (divergence === 'no_customer_changes_captured' && (customerVersions ?? 0) > 0) {
          warnings.push(`${customerVersions} earlier version(s) came from update sets, but the current version is the vendor's: the change was reverted, or an upgrade replaced it.`)
        }
        // A vendor version that is newer than the last captured change means the record went back to the vendor's state.
        const lastChange = seconds(updateRows.map((row) => rawOf(row.sys_updated_on)).filter(Boolean).sort().at(-1) ?? '')
        if (current && VENDOR_SOURCES.has(currentSource) && seconds(rawOf(current.sys_created_on)) >= lastChange - 5) {
          warnings.push('A customer update row exists, but the version marked current is the vendor\'s and is not older than the last captured change: the record was reverted to the vendor version while the update row stayed. An upgrade still skips it.')
        }
        if (updateRows.some((row) => rawOf(row.replace_on_upgrade) === 'true')) {
          warnings.push('A captured change to this record is marked "replace on upgrade": the next upgrade overwrites the record with the vendor\'s version.')
        }

        // ------------------------------------------------------------ who delivered it

        const packageRef = file && !ownTable ? rawOf(file.sys_package) : ''
        let packageClass = file && !ownTable ? rawOf(file['sys_package.sys_class_name']) : ''
        let packageName = file ? labelOf(file.sys_package) : ''
        // Measured: 492 application files name a package whose own record does not come back.
        const packageUnreadable = Boolean(packageRef) && !packageClass
        if (packageUnreadable) {
          warnings.push('This record names a package, but the package itself did not come back: it no longer exists, or this account may not read it. Who delivered the record is therefore not known.')
        }

        // The entry of a system field such as sys_id, and its label, belong to no package: the platform generates them
        // together with the table. Measured: nine in ten entries without a package are of that kind, and for 131 of 150
        // sampled the table itself had a package. Who delivered such an entry is answered by its table.
        if (file && !ownTable && !packageRef && NAMED_BY_CONTENT[kind]) {
          if (!asked && fileId) {
            describes = await sn
              .query<Record<string, string>>({ table: kind, query: `sys_id=${fileId}`, fields: ['name', 'element'], limit: 1 })
              .then((page) => page.records[0] ?? null)
              .catch(() => null)
          }
          const table = describes?.name
          if (isTableName(table) && SYSTEM_FIELDS.has(String(describes?.element ?? ''))) {
            const owner = await sn
              .query<Row>({ table: 'sys_db_object', query: `name=${table}`, fields: ['sys_package', 'sys_package.sys_class_name'], limit: 1, display: true })
              .then((page) => (page.records[0] ? tidy(page.records[0]) : null))
              .catch(() => null)
            if (owner && rawOf(owner['sys_package.sys_class_name'])) {
              packageClass = rawOf(owner['sys_package.sys_class_name'])
              packageName = labelOf(owner.sys_package)
              warnings.push(
                `This entry belongs to no package itself: it describes a system field, which the platform generates together with the table. ` +
                  `The package named here is that of the table "${table}" (sys_db_object, name=${table}).`,
              )
            }
          }
        }

        let provenance: Provenance = PROVENANCE[packageClass] ?? 'unknown'
        // An application this company develops elsewhere and installed here from its repository looks like one from the
        // store. Its scope tells: it carries the company's own prefix.
        if (provenance === 'installed_application' && file) {
          const prefix = await companyPrefix(sn)
          if (prefix && rawOf(file['sys_scope.scope']).startsWith(prefix)) provenance = 'company_application'
        }
        const inDeliveredPackage = provenance === 'vendor' || provenance === 'installed_application'
        // No package says who delivered it: the global scope, a record outside sys_metadata, or a file without a package.
        const noPackage = provenance === 'global_scope' || (provenance === 'unknown' && !packageRef)

        // ------------------------------------------------- created here, or delivered

        // A vendor version proves delivery. Inside a delivered package, so does a record that is older than its first
        // captured change. Outside one, an old record can as well be the customer's own.
        const createdOn = file ? seconds(rawOf(file.sys_created_on)) : NaN
        let firstCapturedOn = updateRows.map((row) => rawOf(row.sys_created_on)).filter(Boolean).sort()[0] ?? ''
        // Exact if every update row is in view. Otherwise it is the latest moment the first capture can have been.
        let firstCaptureExact = Boolean(updates) && !hidesRows(updates) && !mayHaveMore(updates)
        if (updates && mayHaveMore(updates) && !hidesRows(updates)) {
          const earliest = await read('sys_update_xml', `name=${name}^ORDERBYsys_created_on`, ['sys_created_on'], 1)
          const stamp = earliest?.records[0] ? rawOf(tidy(earliest.records[0]).sys_created_on) : ''
          if (stamp) {
            firstCapturedOn = stamp
            firstCaptureExact = !hidesRows(earliest)
          }
        }
        // No update row is left, but the current version came from an update set: the oldest such version is the latest
        // moment the first change can have been. That is enough to say "created here", not enough to say "delivered".
        if (!firstCapturedOn && currentFromCustomer && everyVersionShown) {
          firstCapturedOn = versionRows.filter((row) => CUSTOMER_SOURCES.has(rawOf(row.source_table))).map((row) => rawOf(row.sys_created_on)).filter(Boolean).sort()[0] ?? ''
          firstCaptureExact = false
        }
        const firstCapture = seconds(firstCapturedOn)
        const dated = !Number.isNaN(createdOn) && !Number.isNaN(firstCapture)
        let created: 'here' | 'delivered' | 'unknown' = 'unknown'
        if ((vendorVersions ?? 0) > 0) created = 'delivered'
        else if (dated && firstCaptureExact && inDeliveredPackage && createdOn < firstCapture - 5) created = 'delivered'
        // "Not older than the first capture" holds for the true first capture as well where only a later one is known.
        else if (vendorVersions === 0 && dated && createdOn >= firstCapture - 5) created = 'here'
        else if (vendorVersions === 0 && noPackage && divergence === 'customer_changes_captured') created = 'here'

        if ((vendorVersions ?? 0) > 0 && dated && createdOn >= firstCapture - 5) {
          warnings.push('A vendor version of this record exists, yet the record was created at the moment of its first captured change. It may have been created here before the vendor delivered a file with the same name.')
        }

        // ---------------------------------------------------------- who captured it

        const authors = updateRows.flatMap((row) => [rawOf(row.sys_created_by), rawOf(row.sys_updated_by)]).filter(Boolean)
        let capturedBy: 'people' | 'system_accounts' | 'nobody' | 'unknown' = !authors.length ? 'nobody' : authors.every(isSystemAccount) ? 'system_accounts' : 'people'
        if (!updates) capturedBy = 'unknown'
        else if (capturedBy !== 'people' && hidesRows(updates)) {
          // Rows that exist but are not visible have authors too: then nothing can be said.
          capturedBy = 'unknown'
        } else if (capturedBy !== 'people' && mayHaveMore(updates)) {
          // More rows than the page shows: whether a person is on any of them is asked, not guessed.
          const byPeople = await sn.query({ table: 'sys_update_xml', query: withPeopleOnly(`name=${name}`), fields: ['sys_id'], limit: 1 }).catch(() => null)
          capturedBy = byPeople?.total === 0 ? 'system_accounts' : byPeople?.total || byPeople?.records.length ? 'people' : 'unknown'
        }
        if (capturedBy === 'system_accounts') {
          warnings.push('Every captured change to this record was made under a system account: an installation, an upgrade or a job, not an edit by a person. The platform still treats the record as customized.')
        }

        // ------------------------------------------------------------------ the verdict

        const changed = divergence === 'customer_changes_captured' || divergence === 'changed_without_capture'
        // An upgrade that has an entry under this name knows a file of it, also where no record answers to the name.
        const upgradeKnows = Boolean(skips) && ((skips?.total ?? 0) > 0 || skipRows.length > 0)
        const noVersions = Boolean(versions) && !mayHaveMore(versions) && !hidesRows(versions) && versionRows.length === 0

        let verdict: Verdict = 'unknown'
        // Why the evidence does not decide, where it does not. An "unknown" without a reason is of no use to anyone.
        let undecided = ''
        if (!file) {
          if (hidden || untraceable) undecided = 'It could not be established whether the record exists, or what it is: see the warnings.'
          // The newest row decides: a record that was deleted and made again later is not deleted.
          else if (rawOf(updateRows[0]?.action) === 'DELETE') verdict = 'deleted_here'
          else if (!name || (updates && captured === 0 && noVersions && !upgradeKnows)) verdict = 'not_found'
          else {
            undecided = 'Something is recorded under this name, but no record answers to it: see the warnings.'
            if (updateRows.length || versionRows.length) {
              warnings.push('Update rows or versions exist under this name, but the record itself is not readable: it was removed without a captured delete, or it lives in a table this account cannot read.')
            }
            if (upgradeKnows) {
              warnings.push(
                'An upgrade has an entry for a file of this name, but no record answers to it. The name of such a file carries the sys_id the vendor gave the record. ' +
                  'A record the platform matches by its name, a system property for example, can exist here under another sys_id: ' +
                  'look for it by the name the upgrade shows ("target" in the upgrade evidence) and judge the record you find.',
              )
            }
          }
        } else if (provenance === 'custom_application' || provenance === 'company_application') {
          verdict = 'custom_application_file'
        } else if (packageClass === 'sys_app_customization') {
          undecided = 'It belongs to an application customization (sys_app_customization): changes a customer made to an installed application. This tool has no rule for such a package yet.'
        } else if (packageUnreadable) {
          undecided = 'The package it names could not be read, so it is not known who delivered it: see the warnings.'
        } else if (changed) {
          if (inDeliveredPackage) {
            // Changed, in a delivered package: created here inside it, or delivered and then changed. Inside an installed
            // application both are common, so an undecided case stays undecided. In a platform package a record made
            // here is rare (measured: 5 of 1,885 changed records), so there the change decides.
            // Without the count of versions "created here" cannot be ruled out, and the rarity is no argument.
            if (created === 'here') verdict = 'customer_created'
            else if (created === 'delivered' || divergence === 'changed_without_capture' || (provenance === 'vendor' && sources !== null)) verdict = 'customized'
            else undecided = 'It was changed on this instance and belongs to a delivered package. Whether it was delivered and then changed, or created here inside that package, could not be told: no vendor version of it was found, and its dates do not decide it.'
          } else if (created === 'delivered') {
            // No package says who delivered it, but a vendor version exists.
            verdict = 'customized'
          } else if (created === 'here') {
            verdict = 'customer_created'
          } else {
            undecided =
              sources === null
                ? 'It was changed on this instance and belongs to no delivered package. Whether a vendor version of it exists could not be established, so it is not known whether it was delivered or created here.'
                : 'An upgrade found it changed, it belongs to no delivered package, and no vendor version of it is recorded. Whether it was delivered or created here cannot be told from that.'
          }
        } else if (divergence === 'no_customer_changes_captured') {
          if (inDeliveredPackage || (vendorVersions ?? 0) > 0) verdict = 'out_of_box_as_captured'
          else {
            // Measured: one application file in nine belongs to no package, and almost none of those was ever captured.
            undecided =
              `No change is captured for it, it belongs to ${provenance === 'global_scope' ? 'the global scope and not to a package' : 'no package'}, and no version from an upgrade or an installation exists. ` +
              'Nothing on the instance says who delivered it: records the platform generates look like this, and so do records a script created. See who created it, and when, in "record".'
          }
        } else {
          undecided = name
            ? 'Whether it was changed on this instance could not be established: part of the evidence is missing or hidden. See the warnings.'
            : 'Its change history could not be looked up, because it has no update name of its own: see the warnings.'
        }

        const explanation = verdict === 'unknown' && undecided ? undecided : provenance === 'company_application' ? COMPANY_APPLICATION : EXPLANATIONS[verdict]

        return ok({
          ...source(sn, warnings),
          verdict,
          explanation,
          provenance,
          divergence,
          created,
          capturedBy,
          record: file && compact({
            sysId: rawOf(file.sys_id),
            table: ownTable || kind,
            name: sn.restricted && isTableName(ownTable || kind) && !sn.allows(ownTable || kind) ? CLOSED_NAME : rawOf(file.sys_name),
            updateName: name,
            package: packageName,
            packageClass,
            scope: labelOf(file.sys_scope),
            protection: rawOf(file.sys_policy),
            createdOn: rawOf(file.sys_created_on),
            createdBy: rawOf(file.sys_created_by),
            updatedOn: rawOf(file.sys_updated_on),
            updatedBy: rawOf(file.sys_updated_by),
          }),
          evidence: {
            customerUpdates: {
              table: 'sys_update_xml',
              query: name ? updatesQuery : '',
              readable: updates !== null,
              total: updates?.total ?? null,
              firstCapturedOn: firstCapturedOn || null,
              rows: updateRows.slice(0, 5).map(compact),
            },
            versions: {
              table: 'sys_update_version',
              query: name ? versionsQuery : '',
              readable: versions !== null,
              total: versions?.total ?? null,
              bySource: sources,
              current: current && compact(current),
              rows: versionRows.slice(0, 5).map(compact),
            },
            upgradeSkips: { table: 'upgrade_history_task', query: name ? skipsQuery : '', readable: skips !== null, total: skips?.total ?? null, rows: skipRows.slice(0, 5) },
          },
          caveats: ORIGIN_CAVEATS,
        })
      } catch (error) {
        return fail(error, 'sys_metadata')
      }
    }),
  )
}
