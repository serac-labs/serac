import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

const OPERATOR_MAP: Record<string, string> = {
  is: "=",
  is_not: "!=",
  is_empty: "ISEMPTY",
  is_not_empty: "ISNOTEMPTY",
  contains: "LIKE",
  does_not_contain: "NOT LIKE",
  greater_than: ">",
  less_than: "<",
}

function extractSysId(value: unknown): string {
  if (!value) return ""
  if (typeof value === "object" && value !== null && "value" in value)
    return String((value as Record<string, unknown>).value)
  return String(value)
}

async function resolveVariable(
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  identifier: string,
  catItem: string,
): Promise<string> {
  if (/^[a-f0-9]{32}$/.test(identifier)) return `IO:${identifier}`

  const queries = [`name=${identifier}^cat_item=${catItem}`, `name=${identifier}^cat_itemISEMPTY`, `name=${identifier}`]

  for (const query of queries) {
    const response = await client.get("/api/now/table/item_option_new", {
      params: {
        sysparm_query: query,
        sysparm_limit: 1,
        sysparm_fields: "sys_id",
      },
    })
    const results = response.data?.result
    if (results && results.length > 0) return `IO:${extractSysId(results[0].sys_id)}`
  }

  throw new Error(`Variable '${identifier}' not found for catalog item '${catItem}'`)
}

function buildConditionString(
  conditions: Array<{
    catalog_variable: string
    operation?: string
    value?: string
    and_or?: string
  }>,
  resolved: string[],
): string {
  const parts: string[] = []

  for (let i = 0; i < conditions.length; i++) {
    const cond = conditions[i]!
    const variable = resolved[i]!
    const operator = OPERATOR_MAP[(cond.operation || "is").toLowerCase().trim()] || cond.operation || "="

    const part =
      operator === "ISEMPTY" || operator === "ISNOTEMPTY"
        ? `${variable}${operator}`
        : `${variable}${operator}${cond.value || ""}`

    parts.push(part)

    if (i < conditions.length - 1) {
      parts.push(cond.and_or?.toUpperCase() === "OR" ? "^OR" : "^")
    }
  }

  return parts.join("")
}

function toTriState(val: unknown): string {
  if (val === true) return "true"
  if (val === false) return "false"
  return "ignore"
}

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_catalog_ui_policy",
  description:
    "Creates comprehensive UI policies for catalog items with conditions and actions to control form behavior dynamically.",
  category: "itsm",
  subcategory: "service-catalog",
  use_cases: ["catalog", "ui-policies", "form-control"],
  complexity: "advanced",
  frequency: "medium",
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      cat_item: { type: "string", description: "Catalog item sys_id" },
      short_description: { type: "string", description: "Policy name" },
      condition: { type: "string", description: "Legacy condition script (optional if conditions array provided)" },
      applies_to: { type: "string", description: "Applies to: item, set, or variable" },
      active: { type: "boolean", description: "Active status", default: true },
      on_load: { type: "boolean", description: "Run on form load", default: true },
      reverse_if_false: { type: "boolean", description: "Reverse actions if false", default: true },
      conditions: {
        type: "array",
        description: "Array of condition objects for dynamic policy evaluation",
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              description: "Condition type (catalog_variable, javascript)",
              default: "catalog_variable",
            },
            catalog_variable: { type: "string", description: "Target catalog variable sys_id or name" },
            operation: {
              type: "string",
              description: "Comparison operation: is, is_not, is_empty, is_not_empty, contains, does_not_contain",
              default: "is",
            },
            value: { type: "string", description: "Comparison value" },
            and_or: { type: "string", description: "Logical operator with next condition: AND, OR", default: "AND" },
          },
          required: ["catalog_variable", "operation"],
        },
      },
      actions: {
        type: "array",
        description: "Array of action objects to execute when conditions are met",
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              description: "Action type: set_mandatory, set_visible, set_readonly, set_value",
              default: "set_visible",
            },
            catalog_variable: { type: "string", description: "Target catalog variable sys_id or name" },
            mandatory: { type: "boolean", description: "Set field as mandatory (for set_mandatory type)" },
            visible: { type: "boolean", description: "Set field visibility (for set_visible type)" },
            readonly: { type: "boolean", description: "Set field as readonly (for set_readonly type)" },
            cleared: { type: "boolean", description: "Clear the variable value" },
            value: { type: "string", description: "Value to set (for set_value type)" },
          },
          required: ["type", "catalog_variable"],
        },
      },
    },
    required: ["cat_item", "short_description"],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  try {
    const client = await getAuthenticatedClient(context)
    const catItem = args.cat_item as string
    const conditions = args.conditions as
      | Array<{
          catalog_variable: string
          operation?: string
          value?: string
          and_or?: string
        }>
      | undefined
    const actions = args.actions as
      | Array<{
          type?: string
          catalog_variable: string
          mandatory?: boolean
          visible?: boolean
          readonly?: boolean
          cleared?: boolean
          value?: string
        }>
      | undefined

    let catalogConditions = (args.condition as string) || ""

    if (conditions && Array.isArray(conditions) && conditions.length > 0) {
      const resolved = await Promise.all(
        conditions.map(function (c) {
          return resolveVariable(client, c.catalog_variable, catItem)
        }),
      )
      catalogConditions = buildConditionString(conditions, resolved)
    }

    const policyData: Record<string, unknown> = {
      catalog_item: catItem,
      short_description: args.short_description,
      applies_catalog: true,
      active: args.active !== false,
      applies_on: args.on_load !== false ? "true" : "false",
      reverse_if_false: args.reverse_if_false !== false,
    }

    if (catalogConditions) policyData.catalog_conditions = catalogConditions

    const policyResponse = await client.post("/api/now/table/catalog_ui_policy", policyData)
    const policyId = extractSysId(policyResponse.data.result.sys_id)

    const created: Array<Record<string, unknown>> = []

    if (actions && Array.isArray(actions)) {
      for (let i = 0; i < actions.length; i++) {
        const act = actions[i]!
        const variable = await resolveVariable(client, act.catalog_variable, catItem)

        const actionData: Record<string, unknown> = {
          ui_policy: policyId,
          catalog_item: catItem,
          catalog_variable: variable,
          active: true,
          order: (i + 1) * 100,
          visible: toTriState(act.visible),
          mandatory: toTriState(act.mandatory),
          disabled: toTriState(act.readonly),
        }

        if (act.cleared !== undefined) actionData.cleared = toTriState(act.cleared)
        if (act.value !== undefined) actionData.value = String(act.value)

        const response = await client.post("/api/now/table/catalog_ui_policy_action", actionData)
        created.push(response.data.result)
      }
    }

    return createSuccessResult(
      {
        created: true,
        policy: policyResponse.data.result,
        policy_sys_id: policyId,
        actions: created,
        actions_count: created.length,
      },
      {
        operation: "create_catalog_ui_policy",
        name: args.short_description,
        actions_created: created.length,
      },
    )
  } catch (error: unknown) {
    return createErrorResult(error instanceof Error ? error.message : String(error))
  }
}

export const version = "2.0.0"
export const author = "Serac"
