import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Row } from '../client.js'
import { noConnection, ServiceNowError, unlessNoConnection, validation } from '../errors.js'
import { DEPENDENCIES_NOT_COVERED, FIELD_DEPENDENCIES_NOT_COVERED } from '../limitations.js'
import { assertTableName, fieldsInEncodedQuery, isPlainValue } from '../query.js'
import { fail, labelOf, ok, rawOf, source, sourceShape, tidy } from '../result.js'
import { traced } from '../trace.js'
import { capturedByName, errorKind, mapLimit, READ_ONLY, type CapturedBy, type Context } from './shared.js'

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
  match?: (table: string, chain: string[], field: string) => string
  /** Field of the artifact that names the field it is about. Used when one field is inspected. */
  fieldField?: string
  /** Condition added when only active items are wanted. Default "active=true". */
  active?: string | null
  /** Condition added in every case. */
  always?: string
  /** Extra fields worth showing. */
  show?: string[]
  /** Fields that make a better name than the record's display name, joined with a dot. */
  label?: string[]
  /** Name of an item whose label fields are all empty. */
  unnamed?: string
  /** Fields read along because another one is built from them. */
  also?: string[]
  /**
   * The name a change to the item is captured under, where the item itself carries none. Measured: the choices of
   * a field are captured together as "sys_choice_<table>_<field>", a form section as "sys_ui_section_<sys_id>".
   */
  updateName?: (row: Row) => string
  /** true where the items of the nearest table in the parent chain replace those of the tables above it. */
  nearestWins?: boolean
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
  // Only the published version of a workflow runs. That holds whether or not inactive ones are asked for.
  { key: 'workflows', table: 'wf_workflow_version', tableField: 'table', parents: 'always', active: 'active=true', always: 'published=true', label: ['name'] },
  { key: 'relatedLists', table: 'sys_relationship', tableField: 'basic_apply_to', parents: 'always', active: null, label: ['name'], show: ['basic_query_from'] },
  { key: 'databaseViews', table: 'sys_db_view_table', tableField: 'table', parents: 'never', label: ['view'] },
  { key: 'dictionaryOverrides', table: 'sys_dictionary_override', tableField: 'name', parents: 'always', active: null, show: ['base_table'], label: ['name', 'element'] },
  {
    key: 'referencedBy',
    table: 'sys_dictionary',
    tableField: 'reference',
    parents: 'always',
    // Fields that point at this table itself. A field that points at a parent, at task for example, can hold any
    // record of that parent: asking for the parent lists those.
    match: (table) => `reference=${table}^internal_typeINreference,glide_list`,
    show: ['internal_type'],
    label: ['name', 'element'],
  },
]

/** What is tied to one field of a table. */
const FIELD_CATEGORIES: Category[] = [
  // An action or a rule reaches a child table only if its policy is marked to be inherited.
  { key: 'uiPolicyActions', table: 'sys_ui_policy_action', tableField: 'table', fieldField: 'field', parents: { flag: 'ui_policy.inherit' }, active: 'ui_policy.active=true', label: ['ui_policy'], show: ['mandatory', 'visible', 'disabled'] },
  { key: 'clientScripts', table: 'sys_script_client', tableField: 'table', fieldField: 'field', parents: { flag: 'applies_extended' }, show: ['type'] },
  { key: 'dataPolicyRules', table: 'sys_data_policy_rule', tableField: 'table', fieldField: 'field', parents: { flag: 'sys_data_policy.inherit' }, active: 'sys_data_policy.active=true', label: ['sys_data_policy'], show: ['mandatory', 'disabled'] },
  {
    key: 'accessControls',
    table: 'sys_security_acl',
    tableField: 'name',
    parents: 'always',
    match: (_table, chain, field) => `nameIN${chain.map((name) => `${name}.${field}`).join(',')}`,
    show: ['operation', 'type', 'decision_type'],
    label: ['name'],
  },
  { key: 'dictionaryOverrides', table: 'sys_dictionary_override', tableField: 'name', fieldField: 'element', parents: 'always', active: null, label: ['name', 'element'] },
  {
    key: 'choices',
    table: 'sys_choice',
    tableField: 'name',
    fieldField: 'element',
    parents: 'always',
    // A table that has choices of its own for a field does not use those of its parent.
    nearestWins: true,
    active: 'inactive=false',
    // One label per choice: the English one. Without this every language would be listed, as often as it has labels.
    always: 'language=en',
    label: ['label'],
    show: ['value'],
    updateName: (row) => (rawOf(row.name) && rawOf(row.element) ? `sys_choice_${rawOf(row.name)}_${rawOf(row.element)}` : ''),
  },
  {
    key: 'formSections',
    table: 'sys_ui_element',
    tableField: 'sys_ui_section.name',
    fieldField: 'element',
    parents: 'always',
    active: null,
    label: ['sys_ui_section.view_name'],
    unnamed: 'default view',
    show: ['sys_ui_section.caption'],
    also: ['sys_ui_section'],
    updateName: (row) => (rawOf(row.sys_ui_section) ? `sys_ui_section_${rawOf(row.sys_ui_section)}` : ''),
  },
  { key: 'listLayouts', table: 'sys_ui_list_element', tableField: 'list_id.name', fieldField: 'element', parents: 'always', active: null, label: ['list_id.view_name'], unnamed: 'default view', show: ['list_id.parent'] },
  { key: 'dependentFields', table: 'sys_dictionary', tableField: 'name', fieldField: 'dependent_on_field', parents: 'always', label: ['name', 'element'] },
]

const TABLE_KEYS = CATEGORIES.map((category) => category.key)
const FIELD_KEYS = FIELD_CATEGORIES.map((category) => category.key)
const KEYS = [...new Set([...TABLE_KEYS, ...FIELD_KEYS])] as [string, ...string[]]

const itemSchema = z.object({
  name: z.string(),
  sysId: z.string(),
  definedOn: z.string().optional().describe('The inspected table or parent the item is attached to.'),
  active: z.boolean().optional(),
  customerUpdate: z
    .boolean()
    .optional()
    .describe('true if a captured change exists for this item, whoever made it: an installation or an upgrade counts as well. false does not mean "delivered by the vendor": a file of an application installed from a repository has none either. Absent if it could not be told. For a verdict see sn_origin.'),
  capturedBy: z
    .enum(['people', 'system_accounts'])
    .optional()
    .describe('With customerUpdate true: "people" if a person is on any captured change of the item, "system_accounts" if only installations, upgrades and jobs are.'),
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

/** How many levels below a table its child tables are counted. */
const DESCENDANT_LEVELS = 9

export function registerDependenciesTool(server: McpServer, ctx: Context) {
  const { sn, dict } = ctx

  function queryFor(category: Category, table: string, chain: string[], field: string, activeOnly: boolean): string {
    const active = activeOnly ? (category.active === undefined ? 'active=true' : category.active) : null
    const about = field && category.fieldField ? `${category.fieldField}=${field}` : null
    const branch = (condition: string) => [condition, about, active, category.always].filter(Boolean).join('^')
    const parents = chain.slice(1)
    const attachedTo = category.tableField

    if (category.match) return branch(category.match(table, chain, field))
    if (category.parents === 'always' || !parents.length) return branch(`${attachedTo}IN${chain.join(',')}`)
    if (category.parents === 'never') return branch(`${attachedTo}=${table}`)
    // On the table itself, or on a parent with the flag that passes it down.
    return [branch(`${attachedTo}=${table}`), branch(`${attachedTo}IN${parents.join(',')}^${category.parents.flag}=true`)].join('^NQ')
  }

  async function readCategory(category: Category, table: string, all: string[], field: string, limit: number, activeOnly: boolean): Promise<{ result: CategoryResult; rows: Row[] }> {
    let chain = all
    let uncounted = ''
    if (category.nearestWins && all.length > 1) {
      // Which tables of the chain have any items: the nearest of them is the one that counts.
      const perTable = await sn.groupCount(category.table, category.tableField, queryFor(category, table, all, field, activeOnly)).catch((error) => {
        if (noConnection(error)) throw error
        uncounted = errorKind(error)
        return null
      })
      const nearest = perTable && all.find((name) => perTable.some((group) => group.value === name && group.count > 0))
      if (nearest) chain = [nearest]
    }
    const query = queryFor(category, table, chain, field, activeOnly)
    const empty = { table: category.table, query, total: null, returned: 0, truncated: false, items: [] }
    const notChecked = (reason: string) => ({ result: { status: 'not_checked' as const, reason, ...empty }, rows: [] })
    // Without the count per table the items of a parent cannot be told from those that apply: both would be listed as one.
    if (uncounted) return notChecked(`it could not be counted which table of ${all.join(', ')} the items belong to (${category.table}: ${uncounted}), and only those of the nearest one apply`)

    try {
      // Every field the query names. If the instance does not know one, it would have ignored that condition.
      const required = fieldsInEncodedQuery(query)
      const page = await sn.query<Row>({
        table: category.table,
        query,
        fields: [...new Set(['sys_id', 'sys_name', 'sys_update_name', 'active', ...required, ...(category.show ?? []), ...(category.label ?? []), ...(category.also ?? [])])],
        limit,
        display: true,
      })

      // The answer verifies its own query: a row that lacks a field of the condition means the
      // instance does not know that field and ignored the condition.
      const first = page.records[0]
      if (first) {
        const missing = required.filter((field) => !Object.hasOwn(first, field))
        if (missing.length) return notChecked(`"${category.table}" has no field ${missing.join(', ')} on this instance, so the condition would have been ignored`)
      } else if ((page.total ?? 0) > 0) {
        return notChecked(`${page.total} row(s) match, but none is visible to this account`)
      } else if ((await dict.emptyOnInvalidQuery()) !== false) {
        // No row to check the query against, and this instance answers a query it cannot use with no rows too
        // (or does not say whether it does): the fields of the condition are looked up in the dictionary instead.
        const check = await dict.checkFields(category.table, required)
        if (check.unknown.length) {
          return notChecked(`"${category.table}" has no field ${check.unknown.map((item) => item.field).join(', ')} on this instance, and this instance answers a query it cannot use with no rows`)
        }
        if (check.status !== 'checked') return notChecked('no row matched, and it could not be verified that the instance understood the query: it answers a query it cannot use with no rows')
      }
      // A field to name the items by that the instance does not know: then an empty name says nothing, and no name is made up for it.
      const named = (category.label ?? []).every((field) => !first || Object.hasOwn(first, field))

      const rows = page.records.map(tidy)
      const items = rows.map((row): Item => {
        const details = Object.fromEntries((category.show ?? []).map((field) => [field, labelOf(row[field])] as const).filter(([, value]) => value))
        // An access control is named "incident" or "incident.number": the table is the part before the dot.
        const attachedTo = rawOf(row[category.tableField]).split('.')[0]
        return {
          name: (category.label ?? []).map((field) => labelOf(row[field])).filter(Boolean).join('.') || (named && category.unnamed) || rawOf(row.sys_name) || rawOf(row.sys_id),
          sysId: rawOf(row.sys_id),
          ...(all.includes(attachedTo) ? { definedOn: attachedTo } : {}),
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
          // As it was sent: with tables closed on this machine, the rows of closed child tables are left out of it.
          query: page.query,
          total: page.total,
          returned: items.length,
          truncated: page.total !== null ? limit < page.total : items.length === limit,
          items,
        },
        rows,
      }
    } catch (error) {
      // A login that was rejected, or an instance that does not answer, is not a category that could not be read:
      // every one of them would say so, and the call would pass for an answer.
      if (noConnection(error)) throw error
      return notChecked(`${category.table} could not be read (${errorKind(error)})`)
    }
  }

  server.registerTool(
    'sn_dependencies',
    {
      title: 'Configuration attached to a table or a field',
      description:
        'List the configuration attached to a table, the first step of an impact analysis: business rules, client ' +
        'scripts, UI policies, UI actions and workspace actions, data policies, access controls, data filters, ' +
        'notifications, inbound email actions, SLA definitions, assignment rules, data lookups, transform maps, record ' +
        'producers, flow record triggers, published workflows, related lists, database views, dictionary overrides, ' +
        'the fields of other tables that reference it, and its child tables. With "field" it lists what is tied to that ' +
        'one field instead: UI policy actions, client scripts, data policy rules, access controls, dictionary ' +
        'overrides, choices, the forms and lists that show it, and the fields that depend on it. Parent tables are ' +
        'included, because their logic applies to the table too; client scripts, UI policies, data policies and flow ' +
        'triggers of a parent only when they are marked to apply to child tables. Every category names the table and ' +
        'query it came from: where a category holds more items than are listed, read on with sn_query and that query. ' +
        'Each item is flagged if a captured change exists for it, with who captured it: people, or system accounts ' +
        'only. This is not everything that touches a table or a field: the answer lists what is not covered. A ' +
        'category that could not be read is marked not_checked. For a table, not for a database view.',
      inputSchema: {
        table: z.string().min(1).max(80).describe('Table name, e.g. "incident".'),
        field: z.string().max(80).optional().describe('A field of the table, e.g. "category". The answer then covers what is tied to that field.'),
        categories: z
          .array(z.enum(KEYS))
          .max(KEYS.length)
          .optional()
          .describe(`Only these categories. Leave out for all of them. For a table: ${TABLE_KEYS.join(', ')}. For a field: ${FIELD_KEYS.join(', ')}.`),
        includeParents: z.boolean().default(true).describe('true also covers the parent tables, e.g. task for incident.'),
        activeOnly: z.boolean().default(true).describe('true counts and lists only active items where the artifact has an active flag.'),
        limit: z.number().int().min(1).max(50).default(10).describe('Items listed per category. "total" counts every match on the server.'),
      },
      outputSchema: {
        ...sourceShape,
        table: z.string(),
        field: z.string().optional().describe('The field the answer is about, when one was given.'),
        tablesCovered: z.array(z.string()),
        categories: z.record(z.string(), categorySchema),
        childTables: z.object({
          direct: z.number().nullable().describe('Tables that extend this table directly.'),
          descendants: z.number().nullable().describe('Tables that extend it, down to nine levels below. Configuration on the table reaches all of them. A warning says if there are tables at the ninth level, below which nothing was counted.'),
          names: z.array(z.string()).describe('Direct child tables, at most 50.'),
          truncated: z.boolean(),
        }),
        notCovered: z.array(z.string()),
      },
      annotations: READ_ONLY,
    },
    traced('sn_dependencies', async ({ table, field = '', categories, includeParents, activeOnly, limit }) => {
      try {
        assertTableName(table)
        // What is attached to a table that is closed on this machine is not listed either.
        const closed = await ctx.closed.reason(table)
        if (closed) throw new ServiceNowError(`${closed[0].toUpperCase()}${closed.slice(1)}. The request was not sent.`, 'blocked', table)
        const info = await dict.table(table)
        if (!info || info.kind === 'database_view') {
          throw new ServiceNowError(
            info ? `"${table}" is a database view. Ask for one of the tables it joins.` : `Table "${table}" has no entry in sys_db_object on this instance.`,
            info ? 'validation' : 'not_found',
            table,
          )
        }
        const chain = includeParents ? info.chain : [table]
        const warnings: string[] = []

        if (field) {
          if (!/^[a-z_][a-z0-9_]{0,79}$/.test(field)) throw validation('"field" is the name of one field of the table, without a dot.', table)
          const check = await dict.checkFields(table, [field])
          const unknown = check.unknown[0]
          if (unknown) {
            throw validation(`${unknown.reason}${unknown.suggestions.length ? ` (similar: ${unknown.suggestions.join(', ')})` : ''}.`, table)
          }
          if (check.status !== 'checked') {
            warnings.push(`It could not be verified that "${field}" is a field of "${table}" (${check.reason ?? 'the dictionary could not be used'}). For a field that does not exist every category is empty.`)
          }
        }
        const available = field ? FIELD_CATEGORIES : CATEGORIES
        const foreign = (categories ?? []).filter((key) => !available.some((category) => category.key === key))
        if (foreign.length) {
          throw validation(`${foreign.join(', ')} ${foreign.length === 1 ? 'is' : 'are'} not available ${field ? 'for a field' : 'without "field"'}. Available: ${available.map((category) => category.key).join(', ')}.`, table)
        }
        const wanted = available.filter((category) => !categories?.length || categories.includes(category.key))
        // Nine levels are as far as one condition walks. Measured on one instance: of the 1,348 tables below "cmdb",
        // 95 are more than five levels down, and none more than eight.
        const levels = Array.from({ length: DESCENDANT_LEVELS }, (_, depth) => `${'super_class.'.repeat(depth + 1)}name=${table}`)

        const [read, children, descendants, deepest] = await Promise.all([
          mapLimit(wanted, 4, async (category) => [category, await readCategory(category, table, chain, field, limit, activeOnly)] as const),
          sn.query<Row>({ table: 'sys_db_object', query: `super_class.name=${table}^ORDERBYname`, fields: ['name'], limit: 50 }).catch(unlessNoConnection(null)),
          sn.query<Row>({ table: 'sys_db_object', query: levels.join('^OR'), fields: ['sys_id'], limit: 1 }).catch(unlessNoConnection(null)),
          sn.query<Row>({ table: 'sys_db_object', query: levels[DESCENDANT_LEVELS - 1], fields: ['sys_id'], limit: 1 }).catch(unlessNoConnection(null)),
        ])

        const nameOf = (category: Category, row: Row) => (category.updateName ? category.updateName(row) : rawOf(row.sys_update_name))
        const names = read.flatMap(([category, { rows }]) => rows.map((row) => nameOf(category, row))).filter(isPlainValue)
        const captured = names.length
          ? await capturedByName(ctx, names, (kind) => warnings.push(`Customer updates could not be looked up (${kind}), so some items carry no customerUpdate flag.`))
          : new Map<string, CapturedBy>()
        for (const [category, { result, rows }] of read) {
          result.items = result.items.map((item, index) => {
            const who = captured.get(nameOf(category, rows[index]))
            return who === undefined ? item : { ...item, customerUpdate: who !== 'nobody', ...(who === 'nobody' ? {} : { capturedBy: who }) }
          })
        }

        const skipped = read.filter(([, { result }]) => result.status === 'not_checked').map(([category]) => category.key)
        if (skipped.length) warnings.push(`Not checked: ${skipped.join(', ')}. See the reason in each category. That is "could not be checked", not "none".`)
        const hiding = read.filter(([, { result }]) => result.status === 'checked' && result.reason).map(([category]) => category.key)
        if (hiding.length) warnings.push(`Rows are hidden from this account in: ${hiding.join(', ')}.`)
        if (!children) warnings.push('Child tables could not be read.')
        if (descendants && (deepest?.total ?? deepest?.records.length)) {
          warnings.push(`Tables extend "${table}" ${DESCENDANT_LEVELS} levels below it, which is as deep as was counted: there can be more below those, and "descendants" does not count them.`)
        }
        if (info.kind === 'remote_table') warnings.push('This is a remote table: reading its records runs a script on the instance.')

        return ok({
          ...source(sn, warnings),
          table,
          ...(field ? { field } : {}),
          tablesCovered: chain,
          categories: Object.fromEntries(read.map(([category, { result }]) => [category.key, result])),
          childTables: {
            direct: children?.total ?? null,
            descendants: descendants?.total ?? null,
            names: children?.records.map((row) => String(row.name ?? '')).filter(Boolean) ?? [],
            truncated: children ? (children.total === null ? children.records.length === 50 : children.total > 50) : false,
          },
          notCovered: field ? FIELD_DEPENDENCIES_NOT_COVERED : DEPENDENCIES_NOT_COVERED,
        })
      } catch (error) {
        return fail(error, table, sn)
      }
    }),
  )
}
