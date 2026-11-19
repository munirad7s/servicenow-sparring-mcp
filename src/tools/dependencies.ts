import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Row } from '../client.js'
import { ServiceNowError } from '../errors.js'
import { DEPENDENCIES_NOT_COVERED } from '../limitations.js'
import { assertTableName } from '../query.js'
import { fail, ok, source, sourceShape } from '../result.js'
import { errorKind, mapLimit, READ_ONLY, type Context } from './shared.js'

interface Category {
  key: string
  /** Table that holds the artifacts. */
  table: string
  /** Builds the condition that ties an artifact to one of the inspected tables. */
  match: (tables: string[]) => string
  /** Field of the artifact that names the table it is attached to, if any. */
  tableField?: string
  /** Fields the query relies on. Checked against the dictionary before the category is read. */
  needs: string[]
  /** Extra fields worth showing. Missing ones are left out by the instance. */
  show?: string[]
  /** Fields that make a better name than the record's display name, joined with a dot. */
  label?: string[]
  hasActive?: boolean
}

const byField = (field: string) => (tables: string[]) => `${field}IN${tables.join(',')}`

const CATEGORIES: Category[] = [
  { key: 'businessRules', table: 'sys_script', tableField: 'collection', match: byField('collection'), needs: ['collection'], show: ['when', 'order'], hasActive: true },
  { key: 'clientScripts', table: 'sys_script_client', tableField: 'table', match: byField('table'), needs: ['table'], show: ['type'], hasActive: true },
  { key: 'uiPolicies', table: 'sys_ui_policy', tableField: 'table', match: byField('table'), needs: ['table'], hasActive: true },
  { key: 'uiActions', table: 'sys_ui_action', tableField: 'table', match: byField('table'), needs: ['table'], hasActive: true },
  { key: 'dataPolicies', table: 'sys_data_policy2', tableField: 'model_table', match: byField('model_table'), needs: ['model_table'], hasActive: true },
  {
    key: 'accessControls',
    table: 'sys_security_acl',
    match: (tables) => [`nameIN${tables.join(',')}`, ...tables.map((table) => `ORnameSTARTSWITH${table}.`)].join('^'),
    needs: ['name'],
    show: ['operation', 'type'],
    label: ['name'],
    hasActive: true,
  },
  { key: 'notifications', table: 'sysevent_email_action', tableField: 'collection', match: byField('collection'), needs: ['collection'], hasActive: true },
  { key: 'inboundEmailActions', table: 'sysevent_in_email_action', tableField: 'table', match: byField('table'), needs: ['table'], hasActive: true },
  { key: 'slaDefinitions', table: 'contract_sla', tableField: 'collection', match: byField('collection'), needs: ['collection'], hasActive: true },
  { key: 'transformMaps', table: 'sys_transform_map', tableField: 'target_table', match: byField('target_table'), needs: ['target_table'], show: ['source_table'], hasActive: true },
  { key: 'flowRecordTriggers', table: 'sys_flow_record_trigger', tableField: 'table', match: byField('table'), needs: ['table'], hasActive: true },
  { key: 'workflows', table: 'wf_workflow', tableField: 'table', match: byField('table'), needs: ['table'] },
  { key: 'dictionaryOverrides', table: 'sys_dictionary_override', tableField: 'name', match: byField('name'), needs: ['name'], show: ['base_table'], label: ['name', 'element'] },
  {
    key: 'referencedBy',
    table: 'sys_dictionary',
    match: (tables) => `referenceIN${tables.join(',')}^internal_type=reference`,
    needs: ['reference', 'internal_type'],
    show: ['reference'],
    label: ['name', 'element'],
  },
]

const itemSchema = z.object({
  name: z.string(),
  sysId: z.string(),
  definedOn: z.string().optional().describe('The inspected table or parent the item is attached to.'),
  active: z.boolean().optional(),
  customerUpdate: z.boolean().optional().describe('true if a captured customer update exists for this item. See sn_origin for a verdict.'),
  details: z.record(z.string(), z.string()).optional(),
})

const categorySchema = z.object({
  status: z.enum(['checked', 'not_checked']),
  reason: z.string().optional(),
  total: z.number().nullable(),
  returned: z.number(),
  truncated: z.boolean(),
  items: z.array(itemSchema),
})

type CategoryResult = z.infer<typeof categorySchema>

export function registerDependenciesTool(server: McpServer, ctx: Context) {
  const { sn, dict } = ctx

  const notChecked = (reason: string): CategoryResult => ({
    status: 'not_checked',
    reason,
    total: null,
    returned: 0,
    truncated: false,
    items: [],
  })

  async function readCategory(category: Category, tables: string[], limit: number, activeOnly: boolean): Promise<CategoryResult> {
    try {
      const filterActive = activeOnly && category.hasActive
      const check = await dict.checkFields(category.table, [...category.needs, ...(filterActive ? ['active'] : [])])
      if (check.status !== 'checked') return notChecked(`fields could not be verified: ${check.reason}`)
      if (check.unknown.length) return notChecked(check.unknown.map((item) => item.reason).join('; '))

      const page = await sn.query<Record<string, string>>({
        table: category.table,
        query: [category.match(tables), filterActive ? 'active=true' : ''].filter(Boolean).join('^'),
        fields: [
          ...new Set(['sys_id', 'sys_name', 'sys_update_name', 'active', category.tableField ?? 'sys_id', ...(category.show ?? []), ...(category.label ?? [])]),
        ],
        limit,
      })

      const updateNames = page.records.map((row) => row.sys_update_name).filter(Boolean)
      let touched: Set<string> | null = null
      if (updateNames.length) {
        touched = await sn
          .all<{ name: string }>({ table: 'sys_update_xml', query: `nameIN${updateNames.join(',')}`, fields: ['name'] }, 1_000)
          .then((result) => new Set(result.records.map((row) => row.name)))
          .catch(() => null)
      }

      const items = page.records.map((row) => {
        const details = Object.fromEntries((category.show ?? []).filter((field) => row[field]).map((field) => [field, row[field]]))
        return {
          name: (category.label ?? []).map((field) => row[field]).filter(Boolean).join('.') || row.sys_name || row.sys_id,
          sysId: row.sys_id,
          ...(category.tableField && row[category.tableField] ? { definedOn: row[category.tableField] } : {}),
          ...(row.active ? { active: row.active === 'true' } : {}),
          ...(touched && row.sys_update_name ? { customerUpdate: touched.has(row.sys_update_name) } : {}),
          ...(Object.keys(details).length ? { details } : {}),
        }
      })

      return {
        status: 'checked',
        total: page.total,
        returned: items.length,
        truncated: page.total !== null ? items.length < page.total : items.length === limit,
        items,
      }
    } catch (error) {
      return notChecked(`${category.table} could not be read (${errorKind(error)})`)
    }
  }

  server.registerTool(
    'sn_dependencies',
    {
      title: 'Configuration attached to a table',
      description:
        'List the configuration attached to a table, the first step of an impact analysis: business rules, client ' +
        'scripts, UI policies, UI actions, data policies, access controls, notifications, inbound email actions, SLA ' +
        'definitions, transform maps, flow record triggers, workflows, dictionary overrides, the fields of other tables ' +
        'that reference it, and its child tables. Parent tables are included by default, because their logic applies ' +
        'to the table too. Each item is flagged if a captured customer update exists for it. This is not everything ' +
        'that touches a table: the answer lists what is not covered. A category that could not be read is marked ' +
        'not_checked.',
      inputSchema: {
        table: z.string().min(1).describe('Table name, e.g. "incident".'),
        includeParents: z.boolean().default(true).describe('true also covers the parent tables, e.g. task for incident.'),
        activeOnly: z.boolean().default(true).describe('true counts and lists only active items where the artifact has an active flag.'),
        limit: z.number().int().min(1).max(50).default(10).describe('Items listed per category. Totals are always exact.'),
      },
      outputSchema: {
        ...sourceShape,
        table: z.string(),
        tablesCovered: z.array(z.string()),
        categories: z.record(z.string(), categorySchema),
        childTables: z.object({ total: z.number().nullable(), names: z.array(z.string()) }),
        notCovered: z.array(z.string()),
      },
      annotations: READ_ONLY,
    },
    async ({ table, includeParents, activeOnly, limit }) => {
      try {
        assertTableName(table)
        const info = await dict.table(table)
        if (!info) {
          throw new ServiceNowError(`Table "${table}" has no entry in sys_db_object on this instance.`, 'not_found', table)
        }
        const tables = includeParents ? info.chain : [table]

        const [results, children] = await Promise.all([
          mapLimit(CATEGORIES, 4, async (category) => [category.key, await readCategory(category, tables, limit, activeOnly)] as const),
          sn
            .query<Row>({ table: 'sys_db_object', query: `super_class.name=${table}^ORDERBYname`, fields: ['name'], limit: 50 })
            .catch(() => null),
        ])

        const warnings: string[] = []
        const skipped = results.filter(([, result]) => result.status === 'not_checked').map(([key]) => key)
        if (skipped.length) warnings.push(`Not checked: ${skipped.join(', ')}. See the reason in each category.`)
        if (!children) warnings.push('Child tables could not be read.')

        return ok({
          ...source(sn, warnings),
          table,
          tablesCovered: tables,
          categories: Object.fromEntries(results),
          childTables: { total: children?.total ?? null, names: children?.records.map((row) => String(row.name)) ?? [] },
          notCovered: DEPENDENCIES_NOT_COVERED,
        })
      } catch (error) {
        return fail(error, table)
      }
    },
  )
}
