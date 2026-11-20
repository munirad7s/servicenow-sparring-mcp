import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Page, Row, ServiceNowClient } from '../client.js'
import { ServiceNowError } from '../errors.js'
import { assertPlainValue, isPlainValue } from '../query.js'
import { fail, ok, rowSchema, source, sourceShape, withheldWarning } from '../result.js'
import { traced } from '../trace.js'
import { errorKind, mapLimit, READ_ONLY, type Context } from './shared.js'
import { recentUpgrades } from './upgrade.js'

/** The tables the tools read. sn_instance and the doctor command report which of them this account can reach. */
export const SOURCES: Array<{ table: string; usedBy: string }> = [
  { table: 'sys_db_object', usedBy: 'sn_schema, field check' },
  { table: 'sys_dictionary', usedBy: 'sn_schema, field check' },
  { table: 'sys_dictionary_override', usedBy: 'sn_schema, sn_dependencies' },
  { table: 'sys_choice', usedBy: 'check of choice values, sn_upgrade_skips' },
  { table: 'sys_db_view', usedBy: 'sn_schema and field check for database views' },
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
]

/** Failures that say the instance could not be used at all, as opposed to one table being closed. */
export const NO_CONNECTION = new Set(['auth', 'network', 'timeout', 'redirect', 'invalid_response', 'rate_limited'])

export interface Probe {
  /** "readable", "row_restricted" (rows exist, none is visible to this account), or the kind of failure. */
  status: string
  total: number | null
}

export async function probe(sn: ServiceNowClient, table: string, query = ''): Promise<Probe> {
  try {
    const page = await sn.query({ table, query, fields: ['sys_id'], limit: 1 })
    return { status: page.records.length === 0 && (page.total ?? 0) > 0 ? 'row_restricted' : 'readable', total: page.total }
  } catch (error) {
    return { status: errorKind(error), total: null }
  }
}

/** What the instance says about the account the server logs in with. null if that could not be read. */
export async function accountRoles(sn: ServiceNowClient): Promise<{ roles: number; admin: boolean; readOnlyRole: boolean } | null> {
  const user = sn.username
  if (!user || !isPlainValue(user)) return null
  try {
    const { records, total, complete } = await sn.all<Record<string, string>>(
      { table: 'sys_user_has_role', query: `user.user_name=${user}^state=active`, fields: ['role.name'] },
      2_000,
    )
    if (!complete || (total !== null && records.length < total)) return null
    const names = new Set(records.map((row) => row['role.name']).filter(Boolean))
    // Rows without a role name: the name is hidden from this account, so the roles are not known.
    if (records.length && !names.size) return null
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
        'their part: report that as "could not be checked". The tool sends about 45 requests.',
      inputSchema: {},
      outputSchema: {
        ...sourceShape,
        release: z.object({
          build: z.string().nullable().describe('Value of the system property glide.war. null if it could not be read.'),
          family: z.string().nullable(),
        }),
        scriptSandbox: z.string().nullable().describe('Value of glide.script.use.sandbox. null if it was not returned: hidden, or not set.'),
        lastUpgrade: upgradeShape.nullable().describe('Most recent platform upgrade of any kind. null if none is recorded or readable.'),
        lastFamilyUpgrade: upgradeShape.nullable().describe('Most recent change of release family among the last 30 upgrades.'),
        counts: z.object({
          customerUpdates: z.number().nullable().describe('Rows in sys_update_xml: captured changes, by people and by system accounts.'),
          storeApps: z.number().nullable().describe('Active applications installed from a store or repository.'),
          customApps: z.number().nullable().describe('Applications developed on this instance (sys_app).'),
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
        // One request first: wrong credentials or a wrong address should fail once, not once per source.
        const first = await probe(sn, SOURCES[0].table)
        if (NO_CONNECTION.has(first.status)) {
          await sn.query({ table: SOURCES[0].table, fields: ['sys_id'], limit: 1 })
        }

        const warnings: string[] = []
        const rest = await mapLimit(SOURCES.slice(1), 4, async ({ table }) => [table, await probe(sn, table)] as const)
        const probes = [[SOURCES[0].table, first] as const, ...rest]
        const sources = Object.fromEntries(probes.map(([table, result]) => [table, result.status]))
        const totalOf = (table: string) => probes.find(([name]) => name === table)?.[1].total ?? null

        const [properties, upgrades, storeApps, scopeApps, plugins, account] = await Promise.all([
          sn
            .query<{ name: string; value: string }>({
              table: 'sys_properties',
              query: 'nameINglide.war,glide.script.use.sandbox',
              fields: ['name', 'value'],
              limit: 5,
            })
            .then((page) => new Map(page.records.map((row) => [row.name, row.value])))
            .catch(() => null),
          recentUpgrades(sn).catch(() => null),
          probe(sn, 'sys_store_app', 'active=true'),
          probe(sn, 'sys_scope', 'sys_class_name=sys_store_app^active=true'),
          probe(sn, 'v_plugin', 'active=active'),
          accountRoles(sn),
        ])

        const build = properties?.get('glide.war') ?? null
        if (!properties) warnings.push('sys_properties could not be read, so the release is unknown.')
        else if (!build) warnings.push('The system property glide.war was not returned (hidden from this account, or not set), so the release is unknown.')
        if (!upgrades) warnings.push('sys_upgrade_history could not be read, so the upgrades are unknown.')

        const closed = SOURCES.filter(({ table }) => sources[table] !== 'readable')
        if (closed.length) {
          warnings.push(`Not readable for this account: ${closed.map(({ table, usedBy }) => `${table} (${sources[table]}; used by ${usedBy})`).join('; ')}.`)
        }
        if (account?.admin && !account.readOnlyRole) {
          warnings.push(
            'The account of this server has the admin role and not snc_read_only. The server only ever reads, but the ' +
              'instance would accept a write from this account. With a read-only account the instance enforces that too.',
          )
        } else if (account && !account.readOnlyRole) {
          warnings.push('The account of this server does not have the role snc_read_only, so the instance itself does not prevent writes from it. The server only ever reads.')
        }

        return ok({
          ...source(sn, warnings),
          release: { build, family: build ? (/^glide-([a-z0-9]+)-/.exec(build)?.[1] ?? null) : null },
          scriptSandbox: properties?.get('glide.script.use.sandbox') ?? null,
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
        'read from sys_store_app, or through sys_scope when that table is not readable.',
      inputSchema: {
        filter: z.string().max(120).optional().describe('Text the name, plugin id or application scope must contain, e.g. "Incident", "com.snc.incident", "sn_hr_core".'),
        activeOnly: z.boolean().default(true).describe('true returns only active entries.'),
        limit: z.number().int().min(1).max(200).default(50).describe('Entries per list.'),
      },
      outputSchema: {
        ...sourceShape,
        plugins: z.object(partShape),
        storeApps: z.object(partShape),
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
        if (!apps || hidden(apps)) {
          apps = await attempt(sn.query<Row>({ table: 'sys_scope', query: appQuery('sys_class_name=sys_store_app'), fields: appFields, limit }))
        }
        if (!apps) warnings.push('Installed applications could not be read from sys_store_app or sys_scope. That is "could not be checked", not "none installed".')
        else withheldWarning('Installed applications', apps, warnings)

        // Nothing could be read at all: that is an error, with the reason of the first failure.
        if (!plugins && !apps) throw failures[0] ?? new ServiceNowError('Neither plugins nor applications could be read.', 'unknown')

        return ok({
          ...source(sn, warnings),
          plugins: plugins ? part(plugins) : unread,
          storeApps: apps ? part(apps) : unread,
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
