/**
 * snow_train_va_nlu - Train Virtual Agent NLU
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_train_va_nlu",
  description: "Trigger training of a Virtual Agent NLU model by model_id via /api/now/v1/va/models/{id}/train. Training runs asynchronously on the platform; this call only starts the job.",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "virtual-agent",
  use_cases: ["virtual-agent", "nlu-training", "machine-learning"],
  complexity: "advanced",
  frequency: "low",

  // Permission enforcement
  // Classification: WRITE - Training function - modifies NLU model in ServiceNow
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      model_id: { type: "string" },
    },
    required: ["model_id"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { model_id } = args
  try {
    const client = await getAuthenticatedClient(context)
    const response = await client.post(`/api/now/v1/va/models/${model_id}/train`, {})
    return createSuccessResult({ training_started: true, model: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
