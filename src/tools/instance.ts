import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Page, Row, ServiceNowClient } from '../client.js'
import { ServiceNowError, unlessNoConnection } from '../errors.js'
import { assertPlainValue, isPlainValue } from '../query.js'
import { fail, ok, rowSchema, source, sourceShape, withheldWarning } from '../result.js'
import { traced } from '../trace.js'
import { errorKind, mapLimit, NO_CONNECTION, READ_ONLY, type Context } from './shared.js'
import { recentUpgrades } from './upgrade.js'

/** The tables the tools read. sn_instance and the doctor command report which of them this account can reach. */
export const SOURCES: Array<{ table: string; usedBy: string }> = [
  { table: 'sys_db_object', usedBy: 'sn_schema, field check' },
  { table: 'sys_dictionary', usedBy: 'sn_schema, field check' },
  { table: 'sys_dictionary_override', usedBy: 'sn_schema, sn_dependencies' },
  { table: 'sys_choice', usedBy: 'check of choice values, sn_upgrade_skips' },
  { table: 'sys_db_view', usedBy: 'sn_schema and field check for database views' },
  { table: 'sys_documentation', usedBy: 'sn_schema (field labels)' },
  { table: 'sys_properties', usedBy: 'sn_instance' },
  { table: 'sys_user_has_role', usedBy: 'sn_instance (roles of this account)' },
  { table: 'v_plugin', usedBy: 'sn_plugins' },
  { table: 'sys_store_app', usedBy: 'sn_plugins' },
  { table: 'sys_scope', usedBy: 'sn_plugins (fallback for store apps)' },
  { table: 'sys_app', usedBy: 'sn_instance' },
  { table: 'sys_update_xml', usedBy: 'sn_delta, sn_origin, sn_dependencies' },
  { table: 'sys_update_version', usedBy: 'sn_origin' },
  { table: 'sys_metadata', usedBy: 'sn_origin' },
  { table: 'sys_upgrade_history', usedBy: 'sn_upgrade_skips, sn_instance' },
  { table: 'upgrade_history_task', usedBy: 'sn_upgrade_skips' },
  { table: 'sys_script', usedBy: 'sn_dependencies' },
  { table: 'sys_script_client', usedBy: 'sn_dependencies' },
  { table: 'sys_ui_policy', usedBy: 'sn_dependencies' },
  { table: 'sys_ui_action', usedBy: 'sn_dependencies' },
  { table: 'sys_data_policy2', usedBy: 'sn_dependencies' },
  { table: 'sys_security_acl', usedBy: 'sn_dependencies' },
  { table: 'sysevent_email_action', usedBy: 'sn_dependencies' },
  { table: 'sysevent_in_email_action', usedBy: 'sn_dependencies' },
  { table: 'sys_flow_record_trigger', usedBy: 'sn_dependencies' },
  { table: 'wf_workflow_version', usedBy: 'sn_dependencies' },
  { table: 'contract_sla', usedBy: 'sn_dependencies' },
  { table: 'sys_transform_map', usedBy: 'sn_dependencies' },
  { table: 'sysrule_assignment', usedBy: 'sn_dependencies' },
  { table: 'dl_definition', usedBy: 'sn_dependencies' },
  { table: 'sys_declarative_action_assignment', usedBy: 'sn_dependencies' },
  { table: 'sys_security_data_filter', usedBy: 'sn_dependencies' },
  { table: 'sc_cat_item_producer', usedBy: 'sn_dependencies' },
  { table: 'sys_relationship', usedBy: 'sn_dependencies' },
  { table: 'sys_db_view_table', usedBy: 'sn_dependencies, database views' },
  { table: 'sys_ui_policy_action', usedBy: 'sn_dependencies for one field' },
  { table: 'sys_data_policy_rule', usedBy: 'sn_dependencies for one field' },
  { table: 'sys_ui_element', usedBy: 'sn_dependencies for one field (forms)' },
  { table: 'sys_ui_list_element', usedBy: 'sn_dependencies for one field (lists)' },
  { table: 'sys_archive', usedBy: 'sn_query (whether records of a table are archived)' },
  { table: 'sys_table_rotation', usedBy: 'sn_query (whether old rows of a table are dropped)' },
]


export interface Probe {
  /** "readable", "row_restricted" (rows exist, none is visible to this account), or the kind of failure. */
  status: string
  total: number | null
  /** The failure itself, where there was one. */
  error?: unknown
}

export async function probe(sn: ServiceNowClient, table: string, query = ''): Promise<Probe> {
  try {
    const page = await sn.query({ table, query, fields: ['sys_id'], limit: 1 })
    return { status: page.records.length === 0 && (page.total ?? 0) > 0 ? 'row_restricted' : 'readable', total: page.total }
  } catch (error) {
    return { status: errorKind(error), total: null, error }
  }
}

/** What the instance says about the account the server logs in with. null if that could not be read. */
export async function accountRoles(sn: ServiceNowClient): Promise<{ roles: number; admin: boolean; readOnlyRole: boolean } | null> {
  const user = sn.username
  // The lookup filters on the user table. Where that is closed on this machine, it is not made.
  if (!user || !isPlainValue(user) || !sn.allows('sys_user')) return null
  try {
    const { records, total, complete } = await sn.all<Record<string, string>>(
      { table: 'sys_user_has_role', query: `user.user_name=${user}^state=active`, fields: ['role.name', 'user.user_name'] },
      2_000,
    )
    if (!complete || (total !== null && records.length < total)) return null
    // No row at all: an account that reads these tables has roles, so the lookup through the user table did not work.
    // A row without a role name: the name is hidden from this account, and it could be the one that matters.
    if (!records.length || records.some((row) => !row['role.name'])) return null
    // The answer checks its own query: a row of another user means the condition on the user was not applied.
    if (records.some((row) => String(row['user.user_name'] ?? '').toLowerCase() !== user.toLowerCase())) return null
    const names = new Set(records.map((row) => row['role.name']))
    return { roles: names.size, admin: names.has('admin'), readOnlyRole: names.has('snc_read_only') }
  } catch {
    return null
  }
}

const part = (page: Page<Row>) => ({
  table: page.table,
  query: page.query,
  total: page.total,
  returned: page.records.length,
  truncated: page.total !== null ? page.limit < page.total : page.records.length === page.limit,
  items: page.records,
})

const partShape = {
  table: z.string().nullable().describe('Table the list came from. null if no source was readable.'),
  query: z.string(),
  total: z.number().nullable().describe('Matching rows on the server, before row-level access rules.'),
  returned: z.number(),
  truncated: z.boolean(),
  items: z.array(rowSchema),
}

const unread = { table: null, query: '', total: null, returned: 0, truncated: false, items: [] }

export function registerInstanceTools(server: McpServer, ctx: Context) {
  const { sn } = ctx
  const upgradeShape = z.object({ from: z.string(), to: z.string(), finished: z.string(), kind: z.enum(['family', 'patch']) })

  server.registerTool(
    'sn_instance',
    {
      title: 'Identify the instance and what can be read',
      description:
        'Call this once at the start of a session. Returns the release of the instance, its last upgrades, how much it ' +
        'has been customized (captured customer updates, active store apps, custom apps, active plugins), whether the ' +
        'script sandbox is on, what the server knows about its own account (admin, read-only role), and which source ' +
        'tables this account can read. A source that is not readable means the tools depending on it cannot check ' +
        'their part: report that as "could not be checked". It also says whether the instance separates data into ' +
        'domains, which limits every answer to the domains of this account. The tool sends about 50 requests.',
      inputSchema: {},
      outputSchema: {
        ...sourceShape,
        release: z.object({
          build: z.string().nullable().describe('Value of the system property glide.war. null if it could not be read.'),
          family: z.string().nullable(),
        }),
        scriptSandbox: z.string().nullable().describe('Value of glide.script.use.sandbox. null if it was not returned: hidden, or not set.'),
        invalidQueryReturnsNoRows: z
          .string()
          .nullable()
          .describe('Value of glide.invalid_query.returns_no_rows. "true" makes the instance answer a query it cannot use with no rows instead of all rows. null if it was not returned: hidden from this account, or not set. Not set means the default, all rows.'),
        queryRulesOnEveryTable: z
          .number()
          .nullable()
          .describe('Active business rules on the table "global" that run on every read of every table. Such a rule can hide rows from this account anywhere. null if it could not be read.'),
        domains: z
          .number()
          .nullable()
          .describe('Rows in the table "domain". More than zero means domain separation: every answer is limited to the domains this account can see. null if the table does not exist (no domain separation) or cannot be read.'),
        lastUpgrade: upgradeShape.nullable().describe('Most recent platform upgrade of any kind. null if none is recorded or readable.'),
        lastFamilyUpgrade: upgradeShape.nullable().describe('Most recent change of release family among the last 30 upgrades.'),
        counts: z.object({
          customerUpdates: z.number().nullable().describe('Rows in sys_update_xml: captured changes, by people and by system accounts.'),
          storeApps: z.number().nullable().describe('Active applications installed from a store or repository, applications of the own company that came from its repository included. null if they could not be counted.'),
          customApps: z.number().nullable().describe('Applications developed on this instance (sys_app), active or not.'),
          activePlugins: z.number().nullable(),
        }),
        account: z
          .object({
            roles: z.number(),
            admin: z.boolean(),
            readOnlyRole: z.boolean().describe('true if the account has snc_read_only, with which the instance itself refuses writes.'),
          })
          .nullable()
          .describe('Roles of the account the server logs in with. null if unknown: a token does not name its user, or the role table is not readable.'),
        sources: z.record(z.string(), z.string()).describe('Per source table: "readable", "row_restricted" (rows exist but none is visible), or the kind of failure.'),
      },
      annotations: READ_ONLY,
    },
    traced('sn_instance', async () => {
      try {
        // One request first, to a table this machine may ask for: wrong credentials or a wrong address should fail
        // once, not once per source.
        const opener = SOURCES.find(({ table }) => sn.allows(table)) ?? SOURCES[0]
        const first = await probe(sn, opener.table)
        if (NO_CONNECTION.has(first.status)) throw first.error

        const warnings: string[] = []
        const probes = await mapLimit(SOURCES, 4, async ({ table }) => [table, table === opener.table ? first : await probe(sn, table)] as const)
        // The applications are rows of their parent table too. Where their own table is closed on this machine, they
        // are not read from there either.
        const appsClosed = Boolean(await ctx.closed.reason('sys_store_app').catch(unlessNoConnection('unknown')))
        const sources: Record<string, string> = Object.fromEntries(probes.map(([table, result]) => [table, result.status]))
        const totalOf = (table: string) => probes.find(([name]) => name === table)?.[1].total ?? null

        const GLOBAL_QUERY_RULES = 'collection=global^action_query=true^active=true'
        const [properties, upgrades, storeApps, scopeApps, plugins, account, domains, globalRules] = await Promise.all([
          sn
            .query<{ name: string; value: string }>({
              table: 'sys_properties',
              query: 'nameINglide.war,glide.script.use.sandbox,glide.invalid_query.returns_no_rows',
              fields: ['name', 'value'],
              limit: 5,
            })
            .then((page) => new Map(page.records.map((row) => [row.name, row.value])))
            .catch(() => null),
          recentUpgrades(sn).catch(() => null),
          probe(sn, 'sys_store_app', 'active=true'),
          appsClosed ? Promise.resolve<Probe>({ status: 'blocked', total: null }) : probe(sn, 'sys_scope', 'sys_class_name=sys_store_app^active=true'),
          probe(sn, 'v_plugin', 'active=active'),
          accountRoles(sn),
          // The table exists only where domain separation is installed.
          probe(sn, 'domain'),
          // Asked for with the field that marks such a rule: a row without it would mean the condition was ignored.
          sn
            .query<Record<string, string>>({ table: 'sys_script', query: GLOBAL_QUERY_RULES, fields: ['sys_id', 'action_query'], limit: 1 })
            .then((page) => (page.records[0] && !('action_query' in page.records[0]) ? null : page.total))
            .catch(() => null),
        ])

        const build = properties?.get('glide.war') ?? null
        if (!properties) warnings.push('sys_properties could not be read, so the release is unknown.')
        else if (!build) warnings.push('The system property glide.war was not returned (hidden from this account, or not set), so the release is unknown.')
        if (!upgrades) warnings.push('sys_upgrade_history could not be read, so the upgrades are unknown.')

        // Not readable is not "no domains": only a table that does not exist says that the instance has none.
        if (domains.status !== 'readable' && domains.status !== 'row_restricted' && domains.status !== 'not_found') {
          warnings.push(`Whether this instance separates its data into domains could not be checked (table "domain": ${domains.status}). If it does, every answer is limited to the domains of this account.`)
        }
        if ((domains.total ?? 0) > 0) {
          warnings.push(
            `This instance separates its data into domains (${domains.total} in the table "domain"). Rows and totals are those of the domains this account can see: ` +
              'a count is not a count over the whole instance.',
          )
        }
        if (globalRules) {
          warnings.push(
            `${globalRules} business rule${globalRules === 1 ? ' runs' : 's run'} on every read of every table (a "before query" rule on the table "global"). ` +
              `Whether ${globalRules === 1 ? 'it hides' : 'they hide'} rows from this account cannot be seen from here. To read ${globalRules === 1 ? 'it' : 'them'}: sys_script, ${GLOBAL_QUERY_RULES}.`,
          )
        }
        if (properties?.get('glide.invalid_query.returns_no_rows') === 'true') {
          warnings.push('glide.invalid_query.returns_no_rows is true: this instance answers a condition it cannot use with no rows, not with all rows. An unexpected zero can mean a condition was not understood.')
        }

        const closed = SOURCES.filter(({ table }) => sources[table] !== 'readable')
        if (closed.length) {
          warnings.push(`Not readable for this account: ${closed.map(({ table, usedBy }) => `${table} (${sources[table]}; used by ${usedBy})`).join('; ')}.`)
        }
        if (account?.admin && !account.readOnlyRole) {
          warnings.push(
            'The account of this server has the admin role and not snc_read_only. The server only ever reads, but the ' +
              'instance would accept a write from this account. With a read-only account the instance enforces that too.',
          )
        }

        return ok({
          ...source(sn, warnings),
          release: { build, family: build ? (/^glide-([a-z0-9]+)-/.exec(build)?.[1] ?? null) : null },
          scriptSandbox: properties?.get('glide.script.use.sandbox') ?? null,
          invalidQueryReturnsNoRows: properties?.get('glide.invalid_query.returns_no_rows') ?? null,
          queryRulesOnEveryTable: globalRules,
          domains: domains.status === 'readable' || domains.status === 'row_restricted' ? domains.total : null,
          lastUpgrade: pick(upgrades?.[0]),
          lastFamilyUpgrade: pick(upgrades?.find((upgrade) => upgrade.kind === 'family')),
          counts: {
            customerUpdates: totalOf('sys_update_xml'),
            storeApps: storeApps.status === 'readable' ? storeApps.total : scopeApps.total,
            customApps: totalOf('sys_app'),
            activePlugins: plugins.total,
          },
          account,
          sources,
        })
      } catch (error) {
        return fail(error)
      }
    }),
  )

  server.registerTool(
    'sn_plugins',
    {
      title: 'List plugins and store apps',
      description:
        'Return the plugins and installed applications of the instance with version and active state. Use it to ' +
        'establish which baseline a question is answered against, or whether a product is installed at all. The filter ' +
        'matches the name, the plugin id (com.snc.incident) and the application scope (sn_hr_core). Applications are ' +
        'read from sys_store_app, or through sys_scope when that table is not readable. They include applications of ' +
        'the own company that were installed from its repository. Applications developed on this instance (sys_app) ' +
        'are listed apart, as customApps.',
      inputSchema: {
        filter: z.string().max(120).optional().describe('Text the name, plugin id or application scope must contain, e.g. "Incident", "com.snc.incident", "sn_hr_core".'),
        activeOnly: z.boolean().default(true).describe('true returns only active entries.'),
        limit: z.number().int().min(1).max(200).default(50).describe('Entries per list.'),
      },
      outputSchema: {
        ...sourceShape,
        plugins: z.object(partShape),
        storeApps: z.object(partShape).describe('Applications installed from a store or a repository.'),
        customApps: z.object(partShape).describe('Applications developed on this instance (sys_app).'),
      },
      annotations: READ_ONLY,
    },
    traced('sn_plugins', async ({ filter, activeOnly, limit }) => {
      try {
        if (filter) assertPlainValue(filter, 'filter')
        const warnings: string[] = []
        const hidden = (page: Page<Row>) => page.records.length === 0 && (page.total ?? 0) > 0
        const failures: unknown[] = []
        const attempt = (run: Promise<Page<Row>>) =>
          run.catch((error) => {
            failures.push(error)
            return null
          })

        // v_plugin.active is a string ("active" / "inactive"); on applications it is a boolean.
        const plugins = await attempt(
          sn.query<Row>({
            table: 'v_plugin',
            query: [filter ? `nameLIKE${filter}^ORidLIKE${filter}` : '', activeOnly ? 'active=active' : ''].filter(Boolean).join('^'),
            fields: ['id', 'name', 'active', 'version'],
            limit,
          }),
        )
        if (!plugins) warnings.push(`The plugin list could not be read (${errorKind(failures[0])}). That is "could not be checked", not "no plugins".`)
        else withheldWarning('Plugins', plugins, warnings)

        const appQuery = (...first: string[]) =>
          [...first, filter ? `nameLIKE${filter}^ORscopeLIKE${filter}` : '', activeOnly ? 'active=true' : ''].filter(Boolean).join('^')
        const appFields = ['name', 'scope', 'version', 'active', 'vendor']

        let apps = await attempt(sn.query<Row>({ table: 'sys_store_app', query: appQuery(), fields: appFields, limit }))
        // The applications are rows of their parent table as well: read from there where the instance does not hand out
        // the table itself. Not where the table is closed on this machine: then they are not to be read at all.
        const appsClosed = Boolean(await ctx.closed.reason('sys_store_app').catch(unlessNoConnection('unknown')))
        if ((!apps || hidden(apps)) && !appsClosed) {
          apps = await attempt(sn.query<Row>({ table: 'sys_scope', query: appQuery('sys_class_name=sys_store_app'), fields: appFields, limit }))
        }
        if (!apps) warnings.push(`Installed applications could not be read${appsClosed ? ': sys_store_app is closed on this machine' : ' from sys_store_app or sys_scope'}. That is "could not be checked", not "none installed".`)
        else withheldWarning('Installed applications', apps, warnings)

        // Applications developed on this instance are rows of another table.
        const custom = await attempt(sn.query<Row>({ table: 'sys_app', query: appQuery(), fields: appFields, limit }))
        if (!custom) warnings.push(`Applications developed on this instance could not be read (sys_app: ${errorKind(failures.at(-1))}). That is "could not be checked", not "none".`)
        else withheldWarning('Applications developed here', custom, warnings)

        // Nothing could be read at all: that is an error, with the reason of the first failure.
        if (!plugins && !apps && !custom) throw failures[0] ?? new ServiceNowError('Neither plugins nor applications could be read.', 'unknown')

        return ok({
          ...source(sn, warnings),
          plugins: plugins ? part(plugins) : unread,
          storeApps: apps ? part(apps) : unread,
          customApps: custom ? part(custom) : unread,
        })
      } catch (error) {
        return fail(error, 'v_plugin')
      }
    }),
  )
}

function pick(upgrade: { from: string; to: string; finished: string; kind: 'family' | 'patch' } | undefined) {
  return upgrade ? { from: upgrade.from, to: upgrade.to, finished: upgrade.finished, kind: upgrade.kind } : null
}
