import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Page, Row, ServiceNowClient } from '../client.js'
import { assertPlainValue } from '../query.js'
import { fail, ok, rowSchema, source, sourceShape } from '../result.js'
import { errorKind, mapLimit, READ_ONLY, type Context } from './shared.js'

/** The tables the tools read. sn_instance and `npm run doctor` report which of them this account can reach. */
export const SOURCES: Array<{ table: string; usedBy: string }> = [
  { table: 'sys_db_object', usedBy: 'sn_schema, field check' },
  { table: 'sys_dictionary', usedBy: 'sn_schema, field check' },
  { table: 'sys_dictionary_override', usedBy: 'sn_schema, sn_dependencies' },
  { table: 'sys_properties', usedBy: 'sn_instance' },
  { table: 'v_plugin', usedBy: 'sn_plugins' },
  { table: 'sys_store_app', usedBy: 'sn_plugins' },
  { table: 'sys_scope', usedBy: 'sn_plugins (fallback for store apps)' },
  { table: 'sys_app', usedBy: 'sn_instance' },
  { table: 'sys_update_xml', usedBy: 'sn_delta, sn_origin, sn_dependencies' },
  { table: 'sys_update_version', usedBy: 'sn_origin' },
  { table: 'sys_metadata', usedBy: 'sn_origin' },
  { table: 'sys_upgrade_history', usedBy: 'sn_upgrade_skips, sn_instance' },
  { table: 'upgrade_history_task', usedBy: 'sn_upgrade_skips' },
  { table: 'sys_choice', usedBy: 'sn_upgrade_skips' },
  { table: 'sys_script', usedBy: 'sn_dependencies' },
  { table: 'sys_script_client', usedBy: 'sn_dependencies' },
  { table: 'sys_ui_policy', usedBy: 'sn_dependencies' },
  { table: 'sys_ui_action', usedBy: 'sn_dependencies' },
  { table: 'sys_data_policy2', usedBy: 'sn_dependencies' },
  { table: 'sys_security_acl', usedBy: 'sn_dependencies' },
  { table: 'sysevent_email_action', usedBy: 'sn_dependencies' },
  { table: 'sysevent_in_email_action', usedBy: 'sn_dependencies' },
  { table: 'sys_flow_record_trigger', usedBy: 'sn_dependencies' },
  { table: 'wf_workflow', usedBy: 'sn_dependencies' },
  { table: 'contract_sla', usedBy: 'sn_dependencies' },
  { table: 'sys_transform_map', usedBy: 'sn_dependencies' },
]

export interface Probe {
  status: string
  total: number | null
}

export async function probe(sn: ServiceNowClient, table: string, query = ''): Promise<Probe> {
  try {
    const page = await sn.query({ table, query, fields: ['sys_id'], limit: 1 })
    return { status: 'readable', total: page.total }
  } catch (error) {
    return { status: errorKind(error), total: null }
  }
}

const part = (page: Page<Row>) => ({
  total: page.total,
  returned: page.records.length,
  truncated: page.total !== null ? page.records.length < page.total : page.records.length === page.limit,
  items: page.records,
})

const partShape = {
  total: z.number().nullable(),
  returned: z.number(),
  truncated: z.boolean(),
  items: z.array(rowSchema),
}

export function registerInstanceTools(server: McpServer, ctx: Context) {
  const { sn } = ctx

  server.registerTool(
    'sn_instance',
    {
      title: 'Identify the instance and what can be read',
      description:
        'Start here. Returns the release and patch of the instance, its last family upgrade, how much it has been ' +
        'customized (number of captured customer updates, store apps, custom apps, active plugins), whether the script ' +
        'sandbox is on, and which source tables this account can read. A source that is not readable means the tools ' +
        'depending on it cannot check their part: report that as "could not be checked".',
      inputSchema: {},
      outputSchema: {
        ...sourceShape,
        release: z.object({
          build: z.string().nullable().describe('Value of the system property glide.war.'),
          family: z.string().nullable(),
        }),
        scriptSandbox: z.string().nullable().describe('Value of glide.script.use.sandbox; null if not readable.'),
        lastFamilyUpgrade: z.object({ from: z.string(), to: z.string(), finished: z.string() }).nullable(),
        counts: z.object({
          customerUpdates: z.number().nullable(),
          storeApps: z.number().nullable(),
          customApps: z.number().nullable(),
          activePlugins: z.number().nullable(),
        }),
        sources: z.record(z.string(), z.string()).describe('Per source table: "readable", or the kind of failure.'),
      },
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const warnings: string[] = []
        const probes = await mapLimit(SOURCES, 4, async ({ table }) => [table, await probe(sn, table)] as const)
        const sources = Object.fromEntries(probes.map(([table, result]) => [table, result.status]))
        const totalOf = (table: string) => probes.find(([name]) => name === table)?.[1].total ?? null

        const [properties, upgrade, storeApps, plugins] = await Promise.all([
          sn
            .query<{ name: string; value: string }>({
              table: 'sys_properties',
              query: 'nameINglide.war,glide.script.use.sandbox',
              fields: ['name', 'value'],
              limit: 5,
            })
            .then((page) => new Map(page.records.map((row) => [row.name, row.value])))
            .catch(() => null),
          sn
            .query<Record<string, string>>({
              table: 'sys_upgrade_history',
              query: 'to_versionSTARTSWITHglide-^ORDERBYDESCupgrade_finished',
              fields: ['from_version', 'to_version', 'upgrade_finished'],
              limit: 1,
            })
            .then((page) => page.records[0] ?? null)
            .catch(() => null),
          probe(sn, 'sys_scope', 'sys_class_name=sys_store_app'),
          probe(sn, 'v_plugin', 'active=active'),
        ])

        const build = properties?.get('glide.war') ?? null
        if (!properties) warnings.push('sys_properties could not be read, so the release is unknown.')
        const unreadable = Object.entries(sources).filter(([, status]) => status !== 'readable')
        if (unreadable.length) {
          warnings.push(`Not readable for this account: ${unreadable.map(([table, status]) => `${table} (${status})`).join(', ')}.`)
        }

        return ok({
          ...source(sn, warnings),
          release: { build, family: build ? (/^glide-([a-z]+)-/.exec(build)?.[1] ?? null) : null },
          scriptSandbox: properties?.get('glide.script.use.sandbox') ?? null,
          lastFamilyUpgrade: upgrade
            ? { from: upgrade.from_version ?? '', to: upgrade.to_version ?? '', finished: upgrade.upgrade_finished ?? '' }
            : null,
          counts: {
            customerUpdates: totalOf('sys_update_xml'),
            storeApps: storeApps.total,
            customApps: totalOf('sys_app'),
            activePlugins: plugins.total,
          },
          sources,
        })
      } catch (error) {
        return fail(error)
      }
    },
  )

  server.registerTool(
    'sn_plugins',
    {
      title: 'List plugins and store apps',
      description:
        'Return the plugins and store applications of the instance with version and active state. Use it to establish ' +
        'which baseline a question is answered against, or whether a product is installed at all. Store apps are read ' +
        'from sys_store_app, or through sys_scope when that table is not readable.',
      inputSchema: {
        filter: z.string().optional().describe('Text the plugin or app name must contain, e.g. "Incident" or "Now Assist".'),
        activeOnly: z.boolean().default(true).describe('true returns only active entries.'),
        limit: z.number().int().min(1).max(200).default(50).describe('Entries per list.'),
      },
      outputSchema: {
        ...sourceShape,
        plugins: z.object(partShape),
        storeApps: z.object({
          ...partShape,
          readFrom: z.string().nullable().describe('Table the store apps came from; null if neither was readable.'),
        }),
      },
      annotations: READ_ONLY,
    },
    async ({ filter, activeOnly, limit }) => {
      try {
        if (filter) assertPlainValue(filter, 'filter')
        const warnings: string[] = []
        // v_plugin.active is a string ("active" / "inactive"); on applications it is a boolean.
        const named = filter ? [`nameLIKE${filter}`] : []
        const conditions = [...named, ...(activeOnly ? ['active=true'] : [])]

        const plugins = await sn.query<Row>({
          table: 'v_plugin',
          query: [...named, ...(activeOnly ? ['active=active'] : [])].join('^'),
          fields: ['id', 'name', 'active', 'version'],
          limit,
        })

        const appFields = ['name', 'scope', 'version', 'active']
        let readFrom: string | null = 'sys_store_app'
        let apps: Page<Row> | null = await sn
          .query<Row>({ table: 'sys_store_app', query: conditions.join('^'), fields: appFields, limit })
          .catch(() => null)

        if (!apps) {
          readFrom = 'sys_scope'
          apps = await sn
            .query<Row>({
              table: 'sys_scope',
              query: ['sys_class_name=sys_store_app', ...conditions].join('^'),
              fields: appFields,
              limit,
            })
            .catch(() => null)
        }
        if (!apps) {
          readFrom = null
          warnings.push('Store apps could not be read from sys_store_app or sys_scope. The plugin list is still valid.')
        }

        return ok({
          ...source(sn, warnings),
          plugins: part(plugins),
          storeApps: apps ? { ...part(apps), readFrom } : { total: null, returned: 0, truncated: false, items: [], readFrom },
        })
      } catch (error) {
        return fail(error, 'v_plugin')
      }
    },
  )
}
