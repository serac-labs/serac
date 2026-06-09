/**
 * snow_trace_execution - Set up execution tracing via sys_properties
 *
 * ⚠️ IMPORTANT: This tool sets up tracing configuration, it does NOT execute scripts.
 * Tracing data is stored in sys_properties for later retrieval.
 *
 * How it works:
 * 1. Creates a trace configuration in sys_properties
 * 2. Returns a trace_id for reference
 * 3. Use snow_get_script_output with the trace_id to retrieve trace data
 *
 * Note: Actual tracing requires scripts to write to the trace property.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_trace_execution",
  description:
    "Set up execution tracing configuration. Creates a trace session that scripts can write to. Use snow_get_script_output to retrieve trace data later.",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "monitoring",
  use_cases: ["automation", "tracing", "debugging"],
  complexity: "advanced",
  frequency: "low",

  // Permission enforcement
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      track_id: {
        type: "string",
        description: "Unique tracking ID for this trace session",
      },
      include: {
        type: "array",
        items: { type: "string" },
        description: "What to track: scripts, rest_calls, errors, queries, all",
        default: ["all"],
      },
      max_entries: {
        type: "number",
        description: "Maximum trace entries to store",
        default: 1000,
      },
      ttl_minutes: {
        type: "number",
        description: "Time-to-live for trace data in minutes",
        default: 60,
      },
    },
    required: ["track_id"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { track_id, include = ["all"], max_entries = 1000, ttl_minutes = 60 } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Determine what to track
    const trackAll = include.includes("all")
    const tracking = {
      scripts: trackAll || include.includes("scripts"),
      rest_calls: trackAll || include.includes("rest_calls"),
      errors: trackAll || include.includes("errors"),
      queries: trackAll || include.includes("queries"),
    }

    // Create trace configuration in sys_properties
    const traceConfig = {
      trace_id: track_id,
      started_at: new Date().toISOString(),
      tracking: tracking,
      max_entries: max_entries,
      ttl_minutes: ttl_minutes,
      entries: [],
      status: "active",
    }

    const propertyName = `snow_flow.trace.${track_id}`

    // Check if trace already exists
    const existingCheck = await client.get("/api/now/table/sys_properties", {
      params: {
        sysparm_query: `name=${propertyName}`,
        sysparm_fields: "sys_id",
        sysparm_limit: 1,
      },
    })

    let propertySysId: string

    if (existingCheck.data?.result?.[0]?.sys_id) {
      // Update existing trace
      propertySysId = existingCheck.data.result[0].sys_id
      await client.patch(`/api/now/table/sys_properties/${propertySysId}`, {
        value: JSON.stringify(traceConfig),
      })
    } else {
      // Create new trace property
      const createResponse = await client.post("/api/now/table/sys_properties", {
        name: propertyName,
        value: JSON.stringify(traceConfig),
        type: "string",
        description: `Serac execution trace - ${track_id}. Auto-expires after ${ttl_minutes} minutes.`,
      })

      if (!createResponse.data?.result?.sys_id) {
        throw new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, "Failed to create trace configuration property", {
          details: createResponse.data,
        })
      }

      propertySysId = createResponse.data.result.sys_id
    }

    return createSuccessResult(
      {
        trace_id: track_id,
        property_name: propertyName,
        property_sys_id: propertySysId,
        tracking_enabled: tracking,
        max_entries,
        ttl_minutes,
        started_at: traceConfig.started_at,
        status: "active",
        usage: {
          retrieve_trace: `Use snow_get_script_output with execution_id="${track_id}" to retrieve trace data`,
          add_entry: `In your scripts, use: gs.setProperty('${propertyName}', JSON.stringify(updatedTraceData))`,
          stop_trace: `Delete the property or let it expire after ${ttl_minutes} minutes`,
        },
        note: "This tool creates a trace configuration. Your scripts must write to the trace property to record entries.",
      },
      {
        operation: "trace_execution",
        trace_id: track_id,
      },
    )
  } catch (error: any) {
    return createErrorResult(
      error instanceof SnowFlowError
        ? error
        : new SnowFlowError(ErrorType.UNKNOWN_ERROR, error.message, { originalError: error }),
    )
  }
}

export const version = "2.0.0"
export const author = "Serac SDK"
