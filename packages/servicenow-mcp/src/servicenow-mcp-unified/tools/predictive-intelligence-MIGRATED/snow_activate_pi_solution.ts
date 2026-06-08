/**
 * snow_activate_pi_solution - Activate Predictive Intelligence Solution
 *
 * Activates a trained ServiceNow Predictive Intelligence solution for production use.
 * Once activated, the solution can be used to make predictions on records.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_activate_pi_solution",
  description:
    "✅ Activate trained ServiceNow Predictive Intelligence solution for production use. Enables predictions on records.",
  // Metadata for tool discovery (not sent to LLM)
  category: "ml-analytics",
  subcategory: "predictive-intelligence",
  use_cases: ["activation", "native-ml", "production"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Write operation based on name pattern
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      solution_id: {
        type: "string",
        description: "Solution sys_id or name to activate",
      },
      auto_apply: {
        type: "boolean",
        description: "Automatically apply predictions to new records",
        default: false,
      },
      confidence_threshold: {
        type: "number",
        description: "Minimum confidence for auto-apply (0.0-1.0)",
        default: 0.7,
      },
    },
    required: ["solution_id"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { solution_id, auto_apply = false, confidence_threshold = 0.7 } = args

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

    // Check if solution is already active
    if (solution.active === "true") {
      return createSuccessResult({
        status: "already_active",
        message: "Solution is already active",
        solution: {
          sys_id: solution.sys_id,
          name: solution.name,
          active: true,
        },
        info: "Solution is ready for predictions. Use ml_predictive_intelligence to make predictions.",
      })
    }

    // Check if solution has been trained
    const mlSolutionsResponse = await client.get("/api/now/table/ml_solution", {
      params: {
        sysparm_query: `solution_definition=${solution.sys_id}`,
        sysparm_limit: 1,
        sysparm_fields: "sys_id,precision,accuracy,state",
      },
    })

    const mlSolutions = mlSolutionsResponse.data.result

    if (!mlSolutions || mlSolutions.length === 0) {
      return createErrorResult(
        `Solution has not been trained yet. Train first with: snow_train_pi_solution({ solution_id: "${solution.sys_id}" })`,
      )
    }

    const mlSolution = mlSolutions[0]

    // Validate metrics
    const warnings = []
    const accuracy = parseFloat(mlSolution.accuracy) || 0
    const precision = parseFloat(mlSolution.precision) || 0

    if (accuracy < 0.6) {
      warnings.push(`⚠️  Low accuracy (${(accuracy * 100).toFixed(1)}%) - predictions may be unreliable`)
    }
    if (precision < 0.6) {
      warnings.push(`⚠️  Low precision (${(precision * 100).toFixed(1)}%) - many false positives expected`)
    }

    // Activate the solution
    await client.patch(`/api/now/table/ml_solution_definition/${solution.sys_id}`, {
      active: true,
      auto_apply: auto_apply,
      confidence_threshold: confidence_threshold,
    })

    // Update ml_solution state
    await client.patch(`/api/now/table/ml_solution/${mlSolution.sys_id}`, {
      state: "active",
    })

    return createSuccessResult({
      status: "success",
      message: "Solution activated successfully",
      solution: {
        sys_id: solution.sys_id,
        name: solution.name,
        table: solution.table,
        capability: solution.ml_capability,
        output_field: solution.output_field,
        active: true,
      },
      configuration: {
        auto_apply: auto_apply,
        confidence_threshold: confidence_threshold,
      },
      metrics: {
        accuracy: mlSolution.accuracy || "N/A",
        precision: mlSolution.precision || "N/A",
      },
      warnings: warnings,
      next_steps: [
        "✅ Solution is now active and ready for predictions!",
        "",
        "🔮 Make predictions using ml_predictive_intelligence:",
        "   ml_predictive_intelligence({",
        '     operation: "categorization",',
        `     record_type: "${solution.table}",`,
        '     record_id: "INC0010001"  // Example record',
        "   })",
        "",
        auto_apply
          ? `⚡ Auto-apply is ENABLED - predictions will automatically update records with confidence >= ${(confidence_threshold * 100).toFixed(0)}%`
          : "💡 Auto-apply is DISABLED - predictions are suggestions only",
        "",
        "📊 Monitor solution performance in ServiceNow:",
        `   Predictive Intelligence > Solutions > ${solution.name}`,
        "",
        "🔄 Retrain periodically to maintain accuracy:",
        `   snow_train_pi_solution({ solution_id: "${solution.sys_id}", force_retrain: true })`,
      ],
      production_tips: [
        "📈 Monitor prediction accuracy over time",
        "🎯 Review low-confidence predictions manually",
        "🔄 Retrain when data patterns change",
        "⚙️  Adjust confidence_threshold based on accuracy needs",
        warnings.length > 0 ? "⚠️  Consider retraining with more/better data" : "✅ Metrics look good!",
      ],
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
