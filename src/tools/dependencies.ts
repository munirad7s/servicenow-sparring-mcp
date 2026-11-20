import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Row } from '../client.js'
import { ServiceNowError } from '../errors.js'
import { DEPENDENCIES_NOT_COVERED } from '../limitations.js'
import { assertTableName, isPlainValue } from '../query.js'
import { fail, labelOf, ok, rawOf, source, sourceShape, tidy } from '../result.js'
import { traced } from '../trace.js'
import { errorKind, mapLimit, READ_ONLY, type Context } from './shared.js'

interface Category {
  key: string
  /** Table that holds the artifacts. */
  table: string
  /** Field of the artifact that names the table it is attached to. */
  tableField: string
  /**
   * How an artifact on a parent table reaches the inspected table: "always" (a
   * business rule on task runs for incident), "never" (a transform map into task
   * creates no incident), or only when a flag on the artifact is set.
   */
  parents: 'always' | 'never' | { flag: string }
  /** Replaces the usual condition on tableField. */
  match?: (table: string, chain: string[]) => string
  /** Condition added when only active items are wanted. Default "active=true". */
  active?: string | null
  /** Extra fields worth showing. */
  show?: string[]
  /** Fields that make a better name than the record's display name, joined with a dot. */
  label?: string[]
}

const CATEGORIES: Category[] = [
  { key: 'businessRules', table: 'sys_script', tableField: 'collection', parents: 'always', show: ['when', 'order'] },
  { key: 'clientScripts', table: 'sys_script_client', tableField: 'table', parents: { flag: 'applies_extended' }, show: ['type'] },
  { key: 'uiPolicies', table: 'sys_ui_policy', tableField: 'table', parents: { flag: 'inherit' } },
  { key: 'uiActions', table: 'sys_ui_action', tableField: 'table', parents: 'always' },
  { key: 'declarativeActions', table: 'sys_declarative_action_assignment', tableField: 'table', parents: 'always', label: ['label'], show: ['action_name'] },
  { key: 'dataPolicies', table: 'sys_data_policy2', tableField: 'model_table', parents: { flag: 'inherit' } },
  {
    key: 'accessControls',
    table: 'sys_security_acl',
    tableField: 'name',
    parents: 'always',
    // Table rules are named "incident", field rules "incident.number" or "incident.*".
    match: (_table, chain) => [`nameIN${chain.join(',')}`, ...chain.map((name) => `ORnameSTARTSWITH${name}.`)].join('^'),
    show: ['operation', 'type', 'decision_type'],
    label: ['name'],
  },
  { key: 'dataFilters', table: 'sys_security_data_filter', tableField: 'table_name', parents: 'always', show: ['mode'] },
  { key: 'notifications', table: 'sysevent_email_action', tableField: 'collection', parents: 'always' },
  { key: 'inboundEmailActions', table: 'sysevent_in_email_action', tableField: 'table', parents: 'never', show: ['type'] },
  { key: 'slaDefinitions', table: 'contract_sla', tableField: 'collection', parents: 'always' },
  { key: 'assignmentRules', table: 'sysrule_assignment', tableField: 'table', parents: 'always' },
  { key: 'dataLookups', table: 'dl_definition', tableField: 'source_table', parents: 'always', label: ['name'], show: ['matcher_table'] },
  { key: 'transformMaps', table: 'sys_transform_map', tableField: 'target_table', parents: 'never', show: ['source_table'] },
  { key: 'recordProducers', table: 'sc_cat_item_producer', tableField: 'table_name', parents: 'never', label: ['name'] },
  { key: 'flowRecordTriggers', table: 'sys_flow_record_trigger', tableField: 'table', parents: { flag: 'run_on_extended' }, label: ['name'] },
  { key: 'workflows', table: 'wf_workflow_version', tableField: 'table', parents: 'always', active: 'published=true^active=true', label: ['name'] },
  { key: 'relatedLists', table: 'sys_relationship', tableField: 'basic_apply_to', parents: 'always', active: null, label: ['name'], show: ['basic_query_from'] },
  { key: 'databaseViews', table: 'sys_db_view_table', tableField: 'table', parents: 'never', label: ['view'] },
  { key: 'dictionaryOverrides', table: 'sys_dictionary_override', tableField: 'name', parents: 'always', active: null, show: ['base_table'], label: ['name', 'element'] },
  {
    key: 'referencedBy',
    table: 'sys_dictionary',
    tableField: 'reference',
    parents: 'always',
    match: (_table, chain) => `referenceIN${chain.join(',')}^internal_typeINreference,glide_list`,
    show: ['internal_type'],
    label: ['name', 'element'],
  },
]

const KEYS = CATEGORIES.map((category) => category.key) as [string, ...string[]]

const itemSchema = z.object({
  name: z.string(),
  sysId: z.string(),
  definedOn: z.string().optional().describe('The inspected table or parent the item is attached to.'),
  active: z.boolean().optional(),
  customerUpdate: z.boolean().optional().describe('true if a captured customer update exists for this item; absent if that could not be told. See sn_origin for a verdict.'),
  details: z.record(z.string(), z.string()).optional(),
})

const categorySchema = z.object({
  status: z.enum(['checked', 'not_checked']),
  reason: z.string().optional(),
  table: z.string().describe('Table the items were read from.'),
  query: z.string().describe('The encoded query that was sent. Re-run it with sn_query to see more.'),
  total: z.number().nullable().describe('Matching rows on the server, before row-level access rules.'),
  returned: z.number(),
  truncated: z.boolean(),
  items: z.array(itemSchema),
})

type Item = z.infer<typeof itemSchema>
type CategoryResult = z.infer<typeof categorySchema>

export function registerDependenciesTool(server: McpServer, ctx: Context) {
  const { sn, dict } = ctx

  function queryFor(category: Category, table: string, chain: string[], activeOnly: boolean): string {
    const active = activeOnly ? (category.active === undefined ? 'active=true' : category.active) : null
    const branch = (condition: string) => [condition, active].filter(Boolean).join('^')
    const parents = chain.slice(1)
    const field = category.tableField

    if (category.match) return branch(category.match(table, chain))
    if (category.parents === 'always' || !parents.length) return branch(`${field}IN${chain.join(',')}`)
    if (category.parents === 'never') return branch(`${field}=${table}`)
    // On the table itself, or on a parent with the flag that passes it down.
    return [branch(`${field}=${table}`), branch(`${field}IN${parents.join(',')}^${category.parents.flag}=true`)].join('^NQ')
  }

  /** The fields a category's query relies on. If the instance does not know one, it would have ignored the condition. */
  function needs(category: Category, query: string): string[] {
    const flag = typeof category.parents === 'object' ? [category.parents.flag] : []
    const used = ['active', 'published', 'internal_type', ...flag].filter((field) => query.includes(`${field}=`) || query.includes(`${field}IN`))
    return [...new Set([category.tableField, ...used])]
  }

  async function readCategory(category: Category, table: string, chain: string[], limit: number, activeOnly: boolean): Promise<{ result: CategoryResult; rows: Row[] }> {
    const query = queryFor(category, table, chain, activeOnly)
    const empty = { table: category.table, query, total: null, returned: 0, truncated: false, items: [] }
    const notChecked = (reason: string) => ({ result: { status: 'not_checked' as const, reason, ...empty }, rows: [] })

    try {
      const required = needs(category, query)
      const page = await sn.query<Row>({
        table: category.table,
        query,
        fields: [...new Set(['sys_id', 'sys_name', 'sys_update_name', 'active', ...required, ...(category.show ?? []), ...(category.label ?? [])])],
        limit,
        display: true,
      })

      // The answer verifies its own query: a row that lacks a field of the condition means the
      // instance does not know that field and ignored the condition.
      const first = page.records[0]
      if (first) {
        const missing = required.filter((field) => !(field in first))
        if (missing.length) return notChecked(`"${category.table}" has no field ${missing.join(', ')} on this instance, so the condition would have been ignored`)
      } else if ((page.total ?? 0) > 0) {
        return notChecked(`${page.total} row(s) match, but none is visible to this account`)
      }

      const rows = page.records.map(tidy)
      const items = rows.map((row): Item => {
        const details = Object.fromEntries((category.show ?? []).map((field) => [field, labelOf(row[field])] as const).filter(([, value]) => value))
        // An access control is named "incident" or "incident.number": the table is the part before the dot.
        const attachedTo = rawOf(row[category.tableField]).split('.')[0]
        return {
          name: (category.label ?? []).map((field) => labelOf(row[field])).filter(Boolean).join('.') || rawOf(row.sys_name) || rawOf(row.sys_id),
          sysId: rawOf(row.sys_id),
          ...(chain.includes(attachedTo) ? { definedOn: attachedTo } : {}),
          ...(rawOf(row.active) ? { active: rawOf(row.active) === 'true' } : {}),
          ...(Object.keys(details).length ? { details } : {}),
        }
      })

      const expected = page.total === null ? items.length : Math.min(limit, page.total)
      return {
        result: {
          status: 'checked',
          ...(items.length < expected ? { reason: `${expected - items.length} matching row(s) are hidden from this account by row-level access rules` } : {}),
          table: category.table,
          query,
          total: page.total,
          returned: items.length,
          truncated: page.total !== null ? limit < page.total : items.length === limit,
          items,
        },
        rows,
      }
    } catch (error) {
      return notChecked(`${category.table} could not be read (${errorKind(error)})`)
    }
  }

  /** Which of these update names have a captured customer update. null for a name whose lookup failed. */
  async function capturedNames(names: string[], warnings: string[]): Promise<Map<string, boolean>> {
    const known = new Map<string, boolean>()
    const unique = [...new Set(names)]
    for (let start = 0; start < unique.length; start += 50) {
      const chunk = unique.slice(start, start + 50)
      try {
        const groups = await sn.groupCount('sys_update_xml', 'name', `nameIN${chunk.join(',')}`)
        const found = new Set(groups.filter((group) => group.count > 0).map((group) => group.value))
        for (const name of chunk) known.set(name, found.has(name))
      } catch (error) {
        warnings.push(`Customer updates could not be looked up (${errorKind(error)}), so some items carry no customerUpdate flag.`)
        break
      }
    }
    return known
  }

  server.registerTool(
    'sn_dependencies',
    {
      title: 'Configuration attached to a table',
      description:
        'List the configuration attached to a table, the first step of an impact analysis: business rules, client ' +
        'scripts, UI policies, UI actions and workspace actions, data policies, access controls, data filters, ' +
        'notifications, inbound email actions, SLA definitions, assignment rules, data lookups, transform maps, record ' +
        'producers, flow record triggers, published workflows, related lists, database views, dictionary overrides, ' +
        'the fields of other tables that reference it, and its child tables. Parent tables are included, because ' +
        'their logic applies to the table too; client scripts, UI policies, data policies and flow triggers of a ' +
        'parent only when they are marked to apply to child tables. Every category names the table and query it came from. Each item is flagged if ' +
        'a captured customer update exists for it. This is not everything that touches a table: the answer lists what ' +
        'is not covered. A category that could not be read is marked not_checked.',
      inputSchema: {
        table: z.string().min(1).max(80).describe('Table name, e.g. "incident".'),
        categories: z.array(z.enum(KEYS)).max(KEYS.length).optional().describe('Only these categories. Leave out for all of them.'),
        includeParents: z.boolean().default(true).describe('true also covers the parent tables, e.g. task for incident.'),
        activeOnly: z.boolean().default(true).describe('true counts and lists only active items where the artifact has an active flag.'),
        limit: z.number().int().min(1).max(50).default(10).describe('Items listed per category. "total" counts every match on the server.'),
      },
      outputSchema: {
        ...sourceShape,
        table: z.string(),
        tablesCovered: z.array(z.string()),
        categories: z.record(z.string(), categorySchema),
        childTables: z.object({
          direct: z.number().nullable().describe('Tables that extend this table directly.'),
          descendants: z.number().nullable().describe('Tables that extend it over up to five levels. Configuration on the table reaches all of them.'),
          names: z.array(z.string()).describe('Direct child tables, at most 50.'),
          truncated: z.boolean(),
        }),
        notCovered: z.array(z.string()),
      },
      annotations: READ_ONLY,
    },
    traced('sn_dependencies', async ({ table, categories, includeParents, activeOnly, limit }) => {
      try {
        assertTableName(table)
        const info = await dict.table(table)
        if (!info || info.kind === 'database_view') {
          throw new ServiceNowError(
            info ? `"${table}" is a database view. Ask for one of the tables it joins.` : `Table "${table}" has no entry in sys_db_object on this instance.`,
            info ? 'validation' : 'not_found',
            table,
          )
        }
        const chain = includeParents ? info.chain : [table]
        const wanted = CATEGORIES.filter((category) => !categories?.length || categories.includes(category.key))
        const levels = Array.from({ length: 5 }, (_, depth) => `${'super_class.'.repeat(depth + 1)}name=${table}`)

        const [read, children, descendants] = await Promise.all([
          mapLimit(wanted, 4, async (category) => [category, await readCategory(category, table, chain, limit, activeOnly)] as const),
          sn.query<Row>({ table: 'sys_db_object', query: `super_class.name=${table}^ORDERBYname`, fields: ['name'], limit: 50 }).catch(() => null),
          sn.query<Row>({ table: 'sys_db_object', query: levels.join('^OR'), fields: ['sys_id'], limit: 1 }).catch(() => null),
        ])

        const warnings: string[] = []
        const names = read.flatMap(([, { rows }]) => rows.map((row) => rawOf(row.sys_update_name))).filter(isPlainValue)
        const captured = names.length ? await capturedNames(names, warnings) : new Map<string, boolean>()
        for (const [, { result, rows }] of read) {
          result.items = result.items.map((item, index) => {
            const flag = captured.get(rawOf(rows[index].sys_update_name))
            return flag === undefined ? item : { ...item, customerUpdate: flag }
          })
        }

        const skipped = read.filter(([, { result }]) => result.status === 'not_checked').map(([category]) => category.key)
        if (skipped.length) warnings.push(`Not checked: ${skipped.join(', ')}. See the reason in each category. That is "could not be checked", not "none".`)
        const hiding = read.filter(([, { result }]) => result.status === 'checked' && result.reason).map(([category]) => category.key)
        if (hiding.length) warnings.push(`Rows are hidden from this account in: ${hiding.join(', ')}.`)
        if (!children) warnings.push('Child tables could not be read.')
        if (info.kind === 'remote_table') warnings.push('This is a remote table: reading its records runs a script on the instance.')

        return ok({
          ...source(sn, warnings),
          table,
          tablesCovered: chain,
          categories: Object.fromEntries(read.map(([category, { result }]) => [category.key, result])),
          childTables: {
            direct: children?.total ?? null,
            descendants: descendants?.total ?? null,
            names: children?.records.map((row) => String(row.name ?? '')).filter(Boolean) ?? [],
            truncated: children ? (children.total ?? children.records.length) > children.records.length : false,
          },
          notCovered: DEPENDENCIES_NOT_COVERED,
        })
      } catch (error) {
        return fail(error, table)
      }
    }),
  )
}
