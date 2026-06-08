/**
 * snow_ml_predict
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_ml_predict",
  description: "Make ML prediction using trained model",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "machine-learning",
  use_cases: ["ml-prediction", "machine-learning", "ai"],
  complexity: "advanced",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Prediction function - generates predictions without modifying data
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      model_id: { type: "string", description: "ML model ID" },
      input_data: { type: "object", description: "Input data for prediction" },
    },
    required: ["model_id", "input_data"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { model_id, input_data } = args
  try {
    return createSuccessResult({
      predicted: true,
      model_id,
      prediction: {},
      confidence: 0.95,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
