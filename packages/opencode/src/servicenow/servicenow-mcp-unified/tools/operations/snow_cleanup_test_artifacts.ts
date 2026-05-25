/**
 * snow_cleanup_test_artifacts - Cleanup test data
 *
 * Safely cleanup test artifacts from ServiceNow (dry-run enabled by default).
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_cleanup_test_artifacts",
  description: "Safely cleanup test artifacts from ServiceNow (dry-run enabled by default for safety)",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "testing",
  use_cases: ["testing", "cleanup"],
  complexity: "intermediate",
  frequency: "low",

  // Permission enforcement
  // Classification: WRITE - Write operation based on name pattern
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      artifact_type: {
        type: "string",
        description: "Type of artifacts to clean up",
        enum: ["incidents", "requests", "test_data", "all"],
      },
      name_pattern: {
        type: "string",
        description: 'Pattern to match artifact names (e.g., "TEST", "DEMO")',
        default: "TEST",
      },
      dry_run: {
        type: "boolean",
        description: "Preview cleanup without executing (default: true for safety)",
        default: true,
      },
      limit: {
        type: "number",
        description: "Maximum number of records to clean up",
        default: 10,
        maximum: 100,
      },
    },
    required: ["artifact_type"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { artifact_type, name_pattern = "TEST", dry_run = true, limit = 10 } = args

  try {
    const client = await getAuthenticatedClient(context)

    const cleanupResults: any = {
      artifact_type,
      name_pattern,
      dry_run,
      items_found: 0,
      items_deleted: 0,
      artifacts: [],
    }

    const tables: string[] = []
    if (artifact_type === "incidents" || artifact_type === "all") tables.push("incident")
    if (artifact_type === "requests" || artifact_type === "all") tables.push("sc_request")

    for (const table of tables) {
      const query = `short_descriptionLIKE${name_pattern}`

      const response = await client.get(`/api/now/table/${table}`, {
        params: {
          sysparm_query: query,
          sysparm_limit: limit,
        },
      })

      const records = response.data.result || []
      cleanupResults.items_found += records.length

      for (const record of records) {
        cleanupResults.artifacts.push({
          table,
          sys_id: record.sys_id,
          number: record.number,
          short_description: record.short_description,
        })

        if (!dry_run) {
          await client.delete(`/api/now/table/${table}/${record.sys_id}`)
          cleanupResults.items_deleted++
        }
      }
    }

    const message = dry_run
      ? `Found ${cleanupResults.items_found} test artifacts. Run with dry_run=false to delete.`
      : `Deleted ${cleanupResults.items_deleted} test artifacts successfully.`

    return createSuccessResult(
      {
        message,
        ...cleanupResults,
      },
      { artifact_type, dry_run, items_found: cleanupResults.items_found },
    )
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
