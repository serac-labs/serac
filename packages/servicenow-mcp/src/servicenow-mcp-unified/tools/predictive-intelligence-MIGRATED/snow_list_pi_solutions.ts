/**
 * snow_list_pi_solutions - List Predictive Intelligence Solutions
 *
 * Lists all ServiceNow Predictive Intelligence solutions with their status and metrics.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_list_pi_solutions",
  description: "📋 List all ServiceNow Predictive Intelligence solutions with status and metrics.",
  // Metadata for tool discovery (not sent to LLM)
  category: "ml-analytics",
  subcategory: "predictive-intelligence",
  use_cases: ["listing", "discovery", "monitoring"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - Read-only operation based on name pattern
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      active_only: {
        type: "boolean",
        description: "Show only active solutions",
        default: false,
      },
      include_metrics: {
        type: "boolean",
        description: "Include detailed metrics for each solution",
        default: true,
      },
      solution_type: {
        type: "string",
        enum: ["all", "classification", "regression", "similarity", "clustering"],
        description: "Filter by solution type",
        default: "all",
      },
    },
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { active_only = false, include_metrics = true, solution_type = "all" } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Build query
    let query = ""
    if (active_only) {
      query = "active=true"
    }

    if (solution_type !== "all") {
      const capabilityMap: Record<string, string> = {
        classification: "classification",
        regression: "regression",
        similarity: "similarity_ml",
        clustering: "clustering",
      }

      const capability = capabilityMap[solution_type]
      if (capability) {
        query += (query ? "^" : "") + `ml_capability=${capability}`
      }
    }

    // Get solution definitions
    const solutionDefsResponse = await client.get("/api/now/table/ml_solution_definition", {
      params: {
        sysparm_query: query || "",
        sysparm_limit: 100,
        sysparm_fields:
          "sys_id,name,table,output_field,active,ml_capability,ml_framework,auto_retrain,sys_created_on,sys_updated_on",
      },
    })

    const solutionDefs = solutionDefsResponse.data.result

    if (!solutionDefs || solutionDefs.length === 0) {
      return createSuccessResult({
        status: "success",
        message: "No solutions found",
        count: 0,
        solutions: [],
        tip: "Create a new solution with: snow_create_pi_solution",
      })
    }

    // Enrich with metrics if requested
    const enrichedSolutions = []

    for (const def of solutionDefs) {
      const solutionInfo: any = {
        sys_id: def.sys_id,
        name: def.name,
        table: def.table,
        output_field: def.output_field,
        type: def.ml_capability || def.ml_framework,
        active: def.active === "true",
        auto_retrain: def.auto_retrain === "true",
        created: def.sys_created_on,
        updated: def.sys_updated_on,
      }

      if (include_metrics && def.active === "true") {
        // Get trained model metrics
        const mlSolutionsResponse = await client.get("/api/now/table/ml_solution", {
          params: {
            sysparm_query: `solution_definition=${def.sys_id}^ORDERBYDESCsys_created_on`,
            sysparm_limit: 1,
            sysparm_fields: "accuracy,precision,recall,f1_score,coverage,samples_trained,state",
          },
        })

        const mlSolutions = mlSolutionsResponse.data.result

        if (mlSolutions && mlSolutions.length > 0) {
          const mlSolution = mlSolutions[0]
          solutionInfo.metrics = {
            accuracy: mlSolution.accuracy || "N/A",
            precision: mlSolution.precision || "N/A",
            recall: mlSolution.recall || "N/A",
            f1_score: mlSolution.f1_score || "N/A",
            coverage: mlSolution.coverage || "N/A",
            samples_trained: mlSolution.samples_trained || "N/A",
            state: mlSolution.state || "unknown",
          }
        } else {
          solutionInfo.metrics = {
            status: "not_trained",
            message: "Solution definition exists but no trained model found",
          }
        }
      }

      enrichedSolutions.push(solutionInfo)
    }

    // Calculate summary stats
    let activeSolutions = 0
    let trainedSolutions = 0
    let highAccuracy = 0

    for (const sol of enrichedSolutions) {
      if (sol.active) activeSolutions++
      if (sol.metrics && sol.metrics.state === "active") trainedSolutions++
      if (sol.metrics && parseFloat(sol.metrics.accuracy) >= 0.8) highAccuracy++
    }

    return createSuccessResult({
      status: "success",
      summary: {
        total_solutions: enrichedSolutions.length,
        active_solutions: activeSolutions,
        trained_solutions: trainedSolutions,
        high_accuracy_solutions: `${highAccuracy} (>=80% accuracy)`,
      },
      solutions: enrichedSolutions,
      quick_actions: [
        "🆕 Create new: snow_create_pi_solution",
        '🎯 Train: snow_train_pi_solution({ solution_id: "..." })',
        '📊 Monitor: snow_monitor_pi_training({ solution_id: "..." })',
        '✅ Activate: snow_activate_pi_solution({ solution_id: "..." })',
        '🔮 Predict: ml_predictive_intelligence({ operation: "...", record_id: "..." })',
      ],
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
