/**
 * snow_discover_platform_tables - Platform table discovery
 *
 * Discover platform development tables categorized by type
 * (UI, script, policy, security, system).
 *
 * Optimized with:
 * - Parallel API calls for better performance
 * - Per-category timeout handling
 * - Pre-cached common table definitions
 * - Graceful degradation on slow queries
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_discover_platform_tables",
  description:
    "Discover platform development tables by category (ui, script, policy, action, security, system). Optimized for fast parallel queries with timeout handling.",
  // Metadata for tool discovery (not sent to LLM)
  category: "core-operations",
  subcategory: "discovery",
  use_cases: ["table-discovery", "schema-exploration", "platform-development"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Discovery operation - reads metadata
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      category: {
        type: "string",
        enum: ["all", "ui", "script", "policy", "action", "security", "system", "itsm", "cmdb"],
        description: "Filter by table category",
        default: "all",
      },
      limit: {
        type: "number",
        description: "Maximum results per category (default: 25)",
        default: 25,
      },
      use_cache: {
        type: "boolean",
        description: "Use pre-defined common tables instead of querying (faster, but less complete)",
        default: false,
      },
      timeout: {
        type: "number",
        description: "Timeout per category in milliseconds (default: 10000)",
        default: 10000,
      },
    },
  },
}

interface TableCategory {
  category: string
  query: string
  description: string
  commonTables?: string[] // Pre-cached common tables for fast mode
}

const TABLE_CATEGORIES: TableCategory[] = [
  {
    category: "ui",
    query: "nameSTARTSWITHsys_ui^ORnameSTARTSWITHsp_",
    description: "UI pages, forms, lists, and portal widgets",
    commonTables: [
      "sys_ui_page",
      "sys_ui_script",
      "sys_ui_macro",
      "sys_ui_list",
      "sys_ui_form",
      "sys_ui_section",
      "sys_ui_element",
      "sys_ui_view",
      "sp_widget",
      "sp_page",
      "sp_portal",
      "sp_instance",
      "sp_css",
      "sp_header_footer",
      "sp_angular_provider",
    ],
  },
  {
    category: "script",
    query: "nameSTARTSWITHsys_script^ORnameINsys_script_include,sys_processor",
    description: "Scripts, script includes, and processors",
    commonTables: [
      "sys_script",
      "sys_script_include",
      "sys_script_client",
      "sys_script_ajax",
      "sys_processor",
      "sys_script_fix",
    ],
  },
  {
    category: "policy",
    query: "nameINsys_ui_policy,sys_data_policy,sys_ui_policy_action,sys_data_policy_rule",
    description: "UI policies and data policies",
    commonTables: ["sys_ui_policy", "sys_ui_policy_action", "sys_data_policy", "sys_data_policy_rule"],
  },
  {
    category: "action",
    query: "nameINsys_ui_action,sys_ui_context_menu,sys_ui_related_list_entry",
    description: "UI actions and context menus",
    commonTables: ["sys_ui_action", "sys_ui_context_menu", "sys_ui_related_list_entry"],
  },
  {
    category: "security",
    query: "nameSTARTSWITHsys_security^ORnameINsys_user_role,sys_user_group,sys_acl",
    description: "Security policies, roles, and ACLs",
    commonTables: [
      "sys_security_acl",
      "sys_security_acl_role",
      "sys_user_role",
      "sys_user_group",
      "sys_user_role_contains",
      "sys_acl",
    ],
  },
  {
    category: "system",
    query: "nameINsys_dictionary,sys_db_object,sys_choice,sys_documentation,sys_glide_object",
    description: "System tables for schema and data",
    commonTables: [
      "sys_dictionary",
      "sys_db_object",
      "sys_choice",
      "sys_documentation",
      "sys_glide_object",
      "sys_number",
      "sys_properties",
    ],
  },
  {
    category: "itsm",
    query: "nameINincident,problem,change_request,task,sc_request,sc_req_item,sc_task",
    description: "ITSM tables (incidents, problems, changes, requests)",
    commonTables: [
      "incident",
      "problem",
      "change_request",
      "task",
      "sc_request",
      "sc_req_item",
      "sc_task",
      "sn_hr_core_case",
      "kb_knowledge",
    ],
  },
  {
    category: "cmdb",
    query: "nameSTARTSWITHcmdb^ORnameSTARTSWITHcmdb_ci",
    description: "CMDB configuration items and relationships",
    commonTables: [
      "cmdb",
      "cmdb_ci",
      "cmdb_ci_server",
      "cmdb_ci_computer",
      "cmdb_ci_service",
      "cmdb_ci_appl",
      "cmdb_rel_ci",
      "cmdb_ci_db_instance",
    ],
  },
]

/**
 * Query a single category with timeout handling
 */
async function queryCategory(
  client: any,
  cat: TableCategory,
  limit: number,
  timeout: number,
): Promise<{
  category: string
  description: string
  count: number
  tables: any[]
  error?: string
  timedOut?: boolean
}> {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    const response = await client.get("/api/now/table/sys_db_object", {
      params: {
        sysparm_query: cat.query,
        sysparm_limit: limit,
        sysparm_fields: "sys_id,name,label,super_class,is_extendable",
      },
      signal: controller.signal,
      timeout: timeout,
    })

    clearTimeout(timeoutId)

    if (response.data.result && response.data.result.length > 0) {
      return {
        category: cat.category,
        description: cat.description,
        count: response.data.result.length,
        tables: response.data.result.map((table: any) => ({
          name: table.name,
          label: table.label,
          super_class: table.super_class?.value || table.super_class,
          is_extendable: table.is_extendable === "true",
          sys_id: table.sys_id,
        })),
      }
    }

    return {
      category: cat.category,
      description: cat.description,
      count: 0,
      tables: [],
    }
  } catch (error: any) {
    // Check if it was a timeout/abort
    if (error.name === "AbortError" || error.code === "ECONNABORTED" || error.message?.includes("timeout")) {
      return {
        category: cat.category,
        description: cat.description,
        count: 0,
        tables: [],
        timedOut: true,
        error: `Query timed out after ${timeout}ms`,
      }
    }

    return {
      category: cat.category,
      description: cat.description,
      count: 0,
      tables: [],
      error: error.message,
    }
  }
}

/**
 * Get cached table definitions (fast mode)
 */
function getCachedTables(categories: TableCategory[]): any[] {
  return categories.map((cat) => ({
    category: cat.category,
    description: cat.description,
    count: cat.commonTables?.length || 0,
    tables: (cat.commonTables || []).map((name) => ({
      name,
      label: name.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase()),
      cached: true,
    })),
    cached: true,
  }))
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { category = "all", limit = 25, use_cache = false, timeout = 10000 } = args

  try {
    const categoriesToQuery =
      category === "all" ? TABLE_CATEGORIES : TABLE_CATEGORIES.filter((cat) => cat.category === category)

    if (categoriesToQuery.length === 0) {
      return createErrorResult(
        `Unknown category: ${category}. Valid categories: all, ui, script, policy, action, security, system, itsm, cmdb`,
      )
    }

    // Fast mode: return cached tables
    if (use_cache) {
      const cachedResults = getCachedTables(categoriesToQuery)
      const totalTables = cachedResults.reduce((sum, cat) => sum + cat.count, 0)

      return createSuccessResult({
        discovered: true,
        platform_tables: cachedResults,
        summary: {
          total_tables: totalTables,
          categories_found: cachedResults.length,
          filter_applied: category,
          mode: "cached",
        },
        message: `Returned ${totalTables} common platform tables from cache (use use_cache=false for live query)`,
      })
    }

    // Live query mode: parallel queries with timeout handling
    const client = await getAuthenticatedClient(context)

    // Execute all category queries in parallel
    const queryPromises = categoriesToQuery.map((cat) => queryCategory(client, cat, limit, timeout))

    const results = await Promise.all(queryPromises)

    // Separate successful results from errors/timeouts
    const successfulResults = results.filter((r) => r.count > 0 || (!r.error && !r.timedOut))
    const timedOutCategories = results.filter((r) => r.timedOut)
    const errorCategories = results.filter((r) => r.error && !r.timedOut)

    const discoveredTables = results.filter((r) => r.count > 0)
    const totalTables = discoveredTables.reduce((sum, cat) => sum + cat.count, 0)

    const response: any = {
      discovered: true,
      platform_tables: discoveredTables,
      summary: {
        total_tables: totalTables,
        categories_found: discoveredTables.length,
        categories_queried: categoriesToQuery.length,
        filter_applied: category,
        mode: "live",
      },
      message: `Discovered ${totalTables} platform development tables across ${discoveredTables.length} categories`,
    }

    // Add warnings for timeouts
    if (timedOutCategories.length > 0) {
      response.warnings = {
        timed_out: timedOutCategories.map((c) => ({
          category: c.category,
          message: c.error,
        })),
        suggestion: "Use use_cache=true for instant results or increase timeout parameter",
      }
      response.message += ` (${timedOutCategories.length} categories timed out)`
    }

    // Add errors
    if (errorCategories.length > 0) {
      response.errors = errorCategories.map((c) => ({
        category: c.category,
        error: c.error,
      }))
    }

    return createSuccessResult(response)
  } catch (error: any) {
    return createErrorResult(`Platform table discovery failed: ${error.message}`)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
