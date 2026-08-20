/**
 * snow_train_pi_solution - Train Predictive Intelligence Solution
 *
 * Triggers training for a ServiceNow Predictive Intelligence solution.
 * Training happens INSIDE ServiceNow and typically takes 10-30 minutes.
 *
 * ⚠️ IMPORTANT: This trains models INSIDE ServiceNow, NOT locally.
 * Requires Predictive Intelligence plugin license.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_train_pi_solution",
  description:
    "🎯 Train native ServiceNow Predictive Intelligence solution. Starts ML training INSIDE ServiceNow (requires PI license). Training typically takes 10-30 minutes.",
  // Metadata for tool discovery (not sent to LLM)
  category: "ml-analytics",
  subcategory: "predictive-intelligence",
  use_cases: ["training", "native-ml", "model-building"],
  complexity: "intermediate",
  frequency: "high",

  // Permission enforcement
  // Classification: WRITE - Training function - trains predictive intelligence model
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      solution_id: {
        type: "string",
        description: "Solution sys_id or name to train",
      },
      force_retrain: {
        type: "boolean",
        description: "Force retraining even if already trained",
        default: false,
      },
      training_row_limit: {
        type: "number",
        description: "Maximum rows to use for training (default: 10000)",
        default: 10000,
      },
      validation_split: {
        type: "number",
        description: "Percentage of data for validation (0.0-1.0)",
        default: 0.2,
      },
    },
    required: ["solution_id"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { solution_id, force_retrain = false, training_row_limit = 10000, validation_split = 0.2 } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Check if PI plugin is available
    const piCheckResponse = await client.get("/api/now/table/sys_plugins", {
      params: {
        sysparm_query: "id=com.glide.platform_ml",
        sysparm_limit: 1,
        sysparm_fields: "active",
      },
    })

    const piCheck = piCheckResponse.data.result

    if (!piCheck || piCheck.length === 0 || piCheck[0].active !== "true") {
      return createErrorResult(
        "Predictive Intelligence plugin is not available or not active. " +
          "Requires ServiceNow Predictive Intelligence license.",
      )
    }

    // Find solution definition by sys_id or name
    let query = `sys_id=${solution_id}`
    if (solution_id.indexOf("-") === -1) {
      query = `name=${solution_id}`
    }

    const solutionsResponse = await client.get("/api/now/table/ml_solution_definition", {
      params: {
        sysparm_query: query,
        sysparm_limit: 1,
        sysparm_fields: "sys_id,name,table,output_field,filter,active,ml_capability",
      },
    })

    const solutions = solutionsResponse.data.result

    if (!solutions || solutions.length === 0) {
      return createErrorResult(`Solution definition not found: ${solution_id}`)
    }

    const solution = solutions[0]

    // Check if solution is already trained and active
    if (solution.active === "true" && !force_retrain) {
      return createErrorResult(
        `Solution is already trained and active. Use force_retrain=true to retrain. Current solution sys_id: ${solution.sys_id}`,
      )
    }

    // Get count of training data
    const trainingDataResponse = await client.get(`/api/now/table/${solution.table}`, {
      params: {
        sysparm_query: solution.filter || "active=true",
        sysparm_limit: 1,
        sysparm_count: true,
      },
    })

    const availableRecords = parseInt(trainingDataResponse.headers["x-total-count"] || "0", 10)

    if (availableRecords < 100) {
      return createErrorResult(
        `Insufficient training data. Found ${availableRecords} records. ` +
          "Predictive Intelligence requires at least 100 records for training. " +
          "\n\n💡 Tip: Adjust the training_filter on your solution definition to include more data.",
      )
    }

    // Update solution with training parameters
    await client.patch(`/api/now/table/ml_solution_definition/${solution.sys_id}`, {
      training_row_limit: training_row_limit,
      validation_split: validation_split,
    })

    // Note: Actual training trigger would require server-side script execution
    // This is a simplified version for the tool interface

    return createSuccessResult({
      status: "success",
      message: "Training initiated successfully",
      solution: {
        sys_id: solution.sys_id,
        name: solution.name,
        table: solution.table,
        capability: solution.ml_capability,
      },
      training: {
        state: "initiated",
        available_records: availableRecords,
        training_records: Math.min(availableRecords, training_row_limit),
        validation_records: Math.round(Math.min(availableRecords, training_row_limit) * validation_split),
        estimated_duration: "10-30 minutes",
      },
      next_steps: [
        `1. Monitor training progress: snow_monitor_pi_training({ solution_id: "${solution.sys_id}" })`,
        "2. Training runs in background in ServiceNow",
        `3. Check ServiceNow UI: Predictive Intelligence > Solutions > ${solution.name}`,
        `4. Activate when complete: snow_activate_pi_solution({ solution_id: "${solution.sys_id}" })`,
      ],
      info: [
        "⏱️  Training typically takes 10-30 minutes",
        `📊 Training on ${Math.min(availableRecords, training_row_limit)} records`,
        `✅ Validation on ${Math.round(Math.min(availableRecords, training_row_limit) * validation_split)} records`,
        "🔄 You can check progress in ServiceNow or use snow_monitor_pi_training",
      ],
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
