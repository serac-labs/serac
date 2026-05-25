import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"
import { btk } from "../../shared/builder-toolkit.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_uib_client_state",
  description:
    "Create client state for UI Builder pages via Builder Toolkit API. Client state is managed as state_properties on the page macroponent.",
  category: "ui-builder",
  subcategory: "state-management",
  use_cases: ["ui-builder", "state", "persistence"],
  complexity: "intermediate",
  frequency: "medium",
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      macroponent_id: {
        type: "string",
        description: "Page macroponent sys_id (from page creation response)",
      },
      name: {
        type: "string",
        description: "State variable name",
      },
      initial_value: {
        type: "string",
        description: 'Initial state value (JSON string, default: "{}")',
      },
      type: {
        type: "string",
        description: 'State property type (e.g., "STRING", "OBJECT", "BOOLEAN", "NUMBER")',
      },
    },
    required: ["macroponent_id", "name"],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  try {
    const client = await getAuthenticatedClient(context)

    const macroponentId = args.macroponent_id as string
    const name = args.name as string
    const initialValue = (args.initial_value as string) || "{}"
    const propType = (args.type as string) || "STRING"

    const getResponse = await client.get(btk("/macroponent"), {
      params: { macroponentId },
    })
    const macroponent = getResponse.data?.result || getResponse.data
    const existing = macroponent?.state_properties || macroponent?.stateProperties || []

    const stateProperties = Array.isArray(existing) ? [...existing] : []
    stateProperties.push({
      name,
      value: { type: propType, defaultValue: initialValue },
    })

    const response = await client.patch(btk("/macroponent"), {
      macroponentId,
      state_properties: stateProperties,
    })

    const result = response.data?.result || response.data

    return createSuccessResult({
      client_state: {
        macroponent_id: macroponentId,
        name,
        type: propType,
        initial_value: initialValue,
        total_state_properties: stateProperties.length,
      },
      message: `Client state '${name}' added to macroponent ${macroponentId}`,
    })
  } catch (error: unknown) {
    return createErrorResult(error instanceof Error ? error.message : String(error))
  }
}

export const version = "2.0.0"
export const author = "Serac Builder Toolkit Migration"
