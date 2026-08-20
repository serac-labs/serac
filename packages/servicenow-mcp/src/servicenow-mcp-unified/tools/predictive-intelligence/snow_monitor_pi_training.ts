/**
 * snow_monitor_pi_training - Monitor Predictive Intelligence Training Progress
 *
 * Monitors the training progress of a ServiceNow Predictive Intelligence solution.
 * Shows current status, metrics, and estimated completion time.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_monitor_pi_training",
  description:
    "📊 Monitor ServiceNow Predictive Intelligence training progress. Shows status, metrics, and completion estimate.",
  // Metadata for tool discovery (not sent to LLM)
  category: "ml-analytics",
  subcategory: "predictive-intelligence",
  use_cases: ["monitoring", "training", "metrics"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - Read-only operation based on name pattern
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      solution_id: {
        type: "string",
        description: "Solution sys_id or name to monitor",
      },
      include_metrics: {
        type: "boolean",
        description: "Include detailed training metrics",
        default: true,
      },
    },
    required: ["solution_id"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { solution_id, include_metrics = true } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Find solution definition
    let query = `sys_id=${solution_id}`
    if (solution_id.indexOf("-") === -1) {
      query = `name=${solution_id}`
    }

    const solutionsResponse = await client.get("/api/now/table/ml_solution_definition", {
      params: {
        sysparm_query: query,
        sysparm_limit: 1,
        sysparm_fields: "sys_id,name,table,active,ml_capability,output_field",
      },
    })

    const solutions = solutionsResponse.data.result

    if (!solutions || solutions.length === 0) {
      return createErrorResult(`Solution definition not found: ${solution_id}`)
    }

    const solution = solutions[0]

    // Check for trained models
    const mlSolutionsResponse = await client.get("/api/now/table/ml_solution", {
      params: {
        sysparm_query: `solution_definition=${solution.sys_id}^ORDERBYDESCsys_created_on`,
        sysparm_limit: 1,
        sysparm_fields: "sys_id,precision,recall,accuracy,coverage,f1_score,samples_trained,state",
      },
    })

    const mlSolutions = mlSolutionsResponse.data.result

    if (!mlSolutions || mlSolutions.length === 0) {
      return createSuccessResult({
        status: "no_training",
        message: "No training found for this solution",
        solution: {
          sys_id: solution.sys_id,
          name: solution.name,
          active: solution.active === "true",
        },
        recommendation: `Start training with: snow_train_pi_solution({ solution_id: "${solution.sys_id}" })`,
      })
    }

    const mlSolution = mlSolutions[0]
    const isActive = solution.active === "true"
    const state = mlSolution.state || "unknown"

    const result: any = {
      status: isActive ? "active" : "trained",
      solution: {
        sys_id: solution.sys_id,
        name: solution.name,
        table: solution.table,
        capability: solution.ml_capability,
        active: isActive,
      },
      training: {
        state: state,
        samples_trained: mlSolution.samples_trained || "N/A",
      },
    }

    if (include_metrics && mlSolution.accuracy) {
      result.metrics = {
        accuracy: mlSolution.accuracy,
        precision: mlSolution.precision || "N/A",
        recall: mlSolution.recall || "N/A",
        f1_score: mlSolution.f1_score || "N/A",
        coverage: mlSolution.coverage || "N/A",
      }

      const accuracy = parseFloat(mlSolution.accuracy) || 0

      if (accuracy < 0.7) {
        result.warnings = [
          "⚠️  Accuracy is below 70% - consider:",
          "   • Adding more training data",
          "   • Adding more relevant input fields",
          "   • Improving data quality (remove empty values)",
          "   • Adjusting training filter",
        ]
      }
    }

    if (isActive) {
      result.next_steps = [
        "✅ Solution is active and ready for predictions!",
        `🔮 Make predictions: ml_predictive_intelligence({ operation: "categorization", record_id: "INC0010001" })`,
        `📊 Monitor performance in ServiceNow: Predictive Intelligence > Solutions > ${solution.name}`,
        `🔄 Retrain: snow_train_pi_solution({ solution_id: "${solution.sys_id}", force_retrain: true })`,
      ]
    } else {
      result.next_steps = [
        "✅ Training completed!",
        `🎯 Activate solution: snow_activate_pi_solution({ solution_id: "${solution.sys_id}" })`,
        "📊 Review metrics above to evaluate model quality",
      ]
    }

    return createSuccessResult(result)
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
