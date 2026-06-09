/**
 * snow_search_artifacts - Search across development artifacts
 *
 * Search ServiceNow development artifacts (widgets, pages, scripts, flows, etc.)
 * with parallel queries and optional table search.
 *
 * NOTE: This tool searches DEVELOPMENT ARTIFACTS, not data tables.
 * For searching data in tables, use snow_query_table or snow_fuzzy_search.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_search_artifacts",
  description:
    "Search ServiceNow development artifacts (widgets, pages, scripts, flows, UI actions, client scripts). For data/table searches, use snow_query_table or snow_fuzzy_search instead.",
  // Metadata for tool discovery (not sent to LLM)
  category: "core-operations",
  subcategory: "search",
  use_cases: ["artifact-search", "development-search", "find-widget", "find-script"],
  complexity: "intermediate",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - Search operation - reads data
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query - matches against name, title, and description fields",
      },
      types: {
        type: "array",
        items: {
          type: "string",
          enum: [
            "widget",
            "page",
            "flow",
            "script_include",
            "business_rule",
            "client_script",
            "ui_action",
            "ui_policy",
            "ui_page",
            "scheduled_job",
            "all",
          ],
        },
        description: "Artifact types to search (default: all)",
        default: ["all"],
      },
      limit: {
        type: "number",
        description: "Maximum results per artifact type (default: 10)",
        default: 10,
        minimum: 1,
        maximum: 50,
      },
      include_inactive: {
        type: "boolean",
        description: "Include inactive/disabled artifacts",
        default: false,
      },
      search_tables: {
        type: "boolean",
        description: "Also search sys_db_object for matching table definitions (slower)",
        default: false,
      },
    },
    required: ["query"],
  },
}

interface ArtifactConfig {
  table: string
  name_field: string
  title_field?: string
  active_field?: string
  description: string
  extra_fields?: string[]
}

const ARTIFACT_TABLES: Record<string, ArtifactConfig> = {
  widget: {
    table: "sp_widget",
    name_field: "id",
    title_field: "name",
    active_field: "active",
    description: "Service Portal widgets",
    extra_fields: ["template", "css"],
  },
  page: {
    table: "sp_page",
    name_field: "id",
    title_field: "title",
    active_field: "active",
    description: "Service Portal pages",
  },
  flow: {
    table: "sys_hub_flow",
    name_field: "name",
    active_field: "active",
    description: "Flow Designer flows",
  },
  script_include: {
    table: "sys_script_include",
    name_field: "name",
    active_field: "active",
    description: "Script Includes (reusable server scripts)",
  },
  business_rule: {
    table: "sys_script",
    name_field: "name",
    active_field: "active",
    description: "Business Rules",
    extra_fields: ["collection", "when"],
  },
  client_script: {
    table: "sys_script_client",
    name_field: "name",
    active_field: "active",
    description: "Client Scripts",
    extra_fields: ["table", "type"],
  },
  ui_action: {
    table: "sys_ui_action",
    name_field: "name",
    active_field: "active",
    description: "UI Actions (buttons, links, context menus)",
    extra_fields: ["table", "action_name"],
  },
  ui_policy: {
    table: "sys_ui_policy",
    name_field: "short_description",
    active_field: "active",
    description: "UI Policies",
    extra_fields: ["table", "conditions"],
  },
  ui_page: {
    table: "sys_ui_page",
    name_field: "name",
    active_field: "active",
    description: "UI Pages (classic UI)",
    extra_fields: ["category"],
  },
  scheduled_job: {
    table: "sysauto_script",
    name_field: "name",
    active_field: "active",
    description: "Scheduled Jobs",
  },
}

/**
 * Search a single artifact type with timeout handling
 */
async function searchArtifactType(
  client: any,
  type: string,
  config: ArtifactConfig,
  query: string,
  limit: number,
  includeInactive: boolean,
): Promise<{ type: string; table: string; description: string; count: number; artifacts: any[]; error?: string }> {
  try {
    // Build search query for name, title, and description
    const searchFields = [config.name_field]
    if (config.title_field) searchFields.push(config.title_field)
    searchFields.push("description")

    const searchConditions = searchFields.map((field) => `${field}LIKE${query}`).join("^NQ") // NQ = OR in ServiceNow

    // Add active filter if not including inactive
    const activeCondition = !includeInactive && config.active_field ? `^${config.active_field}=true` : ""

    const fullQuery = searchConditions + activeCondition

    // Build fields list
    const fields = ["sys_id", ...searchFields, "sys_created_on", "sys_updated_on"]
    if (config.active_field) fields.push(config.active_field)
    if (config.extra_fields) fields.push(...config.extra_fields)

    const response = await client.get(`/api/now/table/${config.table}`, {
      params: {
        sysparm_query: fullQuery,
        sysparm_limit: limit,
        sysparm_fields: [...new Set(fields)].join(","),
      },
      timeout: 10000,
    })

    if (!response.data.result || response.data.result.length === 0) {
      return { type, table: config.table, description: config.description, count: 0, artifacts: [] }
    }

    return {
      type,
      table: config.table,
      description: config.description,
      count: response.data.result.length,
      artifacts: response.data.result.map((r: any) => ({
        sys_id: r.sys_id,
        name: r[config.name_field],
        title: config.title_field ? r[config.title_field] : undefined,
        description: r.description,
        active: config.active_field ? r[config.active_field] === "true" : undefined,
        created: r.sys_created_on,
        updated: r.sys_updated_on,
        // Include extra fields if present
        ...(config.extra_fields?.reduce(
          (acc, field) => {
            if (r[field]) acc[field] = r[field]
            return acc
          },
          {} as Record<string, any>,
        ) || {}),
      })),
    }
  } catch (error: any) {
    return {
      type,
      table: config.table,
      description: config.description,
      count: 0,
      artifacts: [],
      error: error.message,
    }
  }
}

/**
 * Search for table definitions matching the query
 */
async function searchTables(
  client: any,
  query: string,
  limit: number,
): Promise<{ type: string; table: string; description: string; count: number; artifacts: any[]; error?: string }> {
  try {
    const response = await client.get("/api/now/table/sys_db_object", {
      params: {
        sysparm_query: `nameLIKE${query}^ORlabelLIKE${query}`,
        sysparm_limit: limit,
        sysparm_fields: "sys_id,name,label,super_class,is_extendable",
      },
      timeout: 15000,
    })

    if (!response.data.result || response.data.result.length === 0) {
      return { type: "table", table: "sys_db_object", description: "Table definitions", count: 0, artifacts: [] }
    }

    return {
      type: "table",
      table: "sys_db_object",
      description: "Table definitions",
      count: response.data.result.length,
      artifacts: response.data.result.map((r: any) => ({
        sys_id: r.sys_id,
        name: r.name,
        label: r.label,
        super_class: r.super_class?.display_value || r.super_class,
        is_extendable: r.is_extendable === "true",
      })),
    }
  } catch (error: any) {
    return {
      type: "table",
      table: "sys_db_object",
      description: "Table definitions",
      count: 0,
      artifacts: [],
      error: error.message,
    }
  }
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { query, types = ["all"], limit = 10, include_inactive = false, search_tables = false } = args

  if (!query || query.trim().length === 0) {
    return createErrorResult("Search query cannot be empty")
  }

  try {
    const client = await getAuthenticatedClient(context)

    // Determine which artifact types to search
    const searchTypes = types.includes("all")
      ? Object.keys(ARTIFACT_TABLES)
      : types.filter((t: string) => t !== "all" && ARTIFACT_TABLES[t])

    // Execute all searches in parallel
    const searchPromises = searchTypes.map((type: string) =>
      searchArtifactType(client, type, ARTIFACT_TABLES[type], query, limit, include_inactive),
    )

    // Optionally search table definitions
    if (search_tables) {
      searchPromises.push(searchTables(client, query, limit))
    }

    const results = await Promise.all(searchPromises)

    // Aggregate results
    const found = results.filter((r) => r.count > 0)
    const errors = results.filter((r) => r.error)
    const totalFound = found.reduce((sum, r) => sum + r.count, 0)

    const response: any = {
      query,
      summary: {
        total_found: totalFound,
        artifact_types_searched: searchTypes.length + (search_tables ? 1 : 0),
        artifact_types_with_results: found.length,
        include_inactive,
      },
      found: found.map((r) => ({
        type: r.type,
        table: r.table,
        description: r.description,
        count: r.count,
        artifacts: r.artifacts,
      })),
      message:
        totalFound > 0
          ? `Found ${totalFound} artifacts matching "${query}" across ${found.length} type(s)`
          : `No artifacts found matching "${query}"`,
    }

    // Add errors if any
    if (errors.length > 0) {
      response.errors = errors.map((e) => ({
        type: e.type,
        table: e.table,
        error: e.error,
      }))
    }

    // Add guidance for table searches
    if (!search_tables && totalFound === 0) {
      response.suggestion =
        "No artifacts found. Try search_tables=true to also search table definitions, or use snow_query_table for data searches."
    }

    return createSuccessResult(response)
  } catch (error: any) {
    return createErrorResult(`Artifact search failed: ${error.message}`)
  }
}

// Keep old name as alias for backwards compatibility
export const toolDefinitionAlias: MCPToolDefinition = {
  ...toolDefinition,
  name: "snow_comprehensive_search",
  description: "[DEPRECATED - use snow_search_artifacts] " + toolDefinition.description,
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
