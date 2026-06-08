/**
 * snow_create_pi_solution - Create Predictive Intelligence Solution Definition
 *
 * Creates a new Predictive Intelligence solution definition in ServiceNow.
 * This allows you to build custom ML models that run INSIDE ServiceNow.
 *
 * ⚠️ IMPORTANT: This creates NATIVE ServiceNow PI solutions, NOT local TensorFlow.js models.
 * Requires Predictive Intelligence plugin license.
 *
 * Solution Types:
 * - Classification: Predict categorical values (e.g., incident category, assignment group)
 * - Regression: Predict numeric values (e.g., resolution time, cost)
 * - Similarity: Find similar records (e.g., similar incidents)
 * - Clustering: Group records by patterns (e.g., incident clustering)
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_pi_solution",
  description:
    "🤖 Create native ServiceNow Predictive Intelligence solution definition. Builds ML models that run INSIDE ServiceNow (requires PI license). Use for classification, regression, similarity, or clustering.",
  // Metadata for tool discovery (not sent to LLM)
  category: "ml-analytics",
  subcategory: "predictive-intelligence",
  use_cases: ["creation", "native-ml", "solution-definition"],
  complexity: "advanced",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: 'Solution name (e.g., "Incident Category Predictor")',
      },
      table: {
        type: "string",
        description: 'Table to train on (e.g., "incident", "change_request")',
      },
      solution_type: {
        type: "string",
        enum: ["classification", "regression", "similarity", "clustering"],
        description: "Type of ML solution",
        default: "classification",
      },
      output_field: {
        type: "string",
        description: 'Field to predict (e.g., "category", "assignment_group", "priority")',
      },
      input_fields: {
        type: "array",
        items: { type: "string" },
        description: 'Fields to use as inputs (e.g., ["short_description", "description", "urgency"])',
      },
      training_filter: {
        type: "string",
        description:
          'Query to filter training data (e.g., "stateIN1,2,3^sys_created_on>=javascript:gs.daysAgoStart(90)")',
        default: "active=true",
      },
      description: {
        type: "string",
        description: "Description of what this solution does",
      },
      auto_retrain: {
        type: "boolean",
        description: "Enable automatic retraining",
        default: true,
      },
      retrain_frequency: {
        type: "string",
        enum: ["daily", "weekly", "monthly"],
        description: "How often to retrain automatically",
        default: "weekly",
      },
    },
    required: ["name", "table", "output_field", "input_fields"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    name,
    table,
    solution_type = "classification",
    output_field,
    input_fields = [],
    training_filter = "active=true",
    description = "",
    auto_retrain = true,
    retrain_frequency = "weekly",
  } = args

  try {
    const client = await getAuthenticatedClient(context)

    // First, check if PI plugin is available
    const piCheckResponse = await client.get("/api/now/table/sys_plugins", {
      params: {
        sysparm_query: "id=com.glide.platform_ml",
        sysparm_limit: 1,
        sysparm_fields: "active,name",
      },
    })

    const piCheck = piCheckResponse.data.result

    if (!piCheck || piCheck.length === 0 || piCheck[0].active !== "true") {
      return createErrorResult(
        "Predictive Intelligence plugin is not available or not active. " +
          "This tool requires the ServiceNow Predictive Intelligence license. " +
          "\n\n💡 Alternative: Use local ML training tools (ml_train_incident_classifier) for dev/testing without PI license.",
      )
    }

    // Validate input fields
    if (!input_fields || input_fields.length === 0) {
      return createErrorResult("At least one input field is required")
    }

    // Get field details to validate they exist
    const tableFieldsResponse = await client.get("/api/now/table/sys_dictionary", {
      params: {
        sysparm_query: `name=${table}^element=${output_field}`,
        sysparm_limit: 1,
        sysparm_fields: "element,internal_type,column_label",
      },
    })

    const tableFields = tableFieldsResponse.data.result

    if (!tableFields || tableFields.length === 0) {
      return createErrorResult(`Output field '${output_field}' does not exist on table '${table}'`)
    }

    const outputFieldType = tableFields[0].internal_type

    // Map solution type to capability
    const capabilityMap: Record<string, string> = {
      classification: "classification",
      regression: "regression",
      similarity: "similarity_ml",
      clustering: "clustering",
    }

    const capability = capabilityMap[solution_type]

    // Determine ML framework based on solution type
    let mlFramework = "classification"
    if (solution_type === "regression") {
      mlFramework = "regression"
    } else if (solution_type === "similarity") {
      mlFramework = "similarity"
    } else if (solution_type === "clustering") {
      mlFramework = "clustering"
    }

    // Validate field types for solution type
    if (solution_type === "classification") {
      const validTypes = ["string", "reference", "choice"]
      if (!validTypes.includes(outputFieldType)) {
        return createErrorResult(
          `Classification requires categorical output field (string, reference, or choice). Field "${output_field}" is type: ${outputFieldType}`,
        )
      }
    } else if (solution_type === "regression") {
      const validNumericTypes = ["integer", "decimal", "float", "duration", "currency"]
      if (!validNumericTypes.includes(outputFieldType)) {
        return createErrorResult(
          `Regression requires numeric output field (integer, decimal, duration, etc.). Field "${output_field}" is type: ${outputFieldType}`,
        )
      }
    }

    // Create solution definition
    const solutionDefinition = {
      name: name,
      short_description: description || `Predictive Intelligence solution for ${table}`,
      table: table,
      output_field: output_field,
      filter: training_filter,
      ml_capability: capability,
      ml_framework: mlFramework,
      active: false,
      auto_retrain: auto_retrain,
      schedule: retrain_frequency,
      training_row_limit: 10000,
    }

    // Create the solution definition record
    const createResponse = await client.post("/api/now/table/ml_solution_definition", solutionDefinition)

    if (!createResponse.data || !createResponse.data.result || !createResponse.data.result.sys_id) {
      return createErrorResult("Failed to create solution definition")
    }

    const solutionSysId = createResponse.data.result.sys_id

    // Add input fields to the solution
    const inputFieldsAdded = []

    for (const fieldName of input_fields) {
      // Verify field exists
      const fieldCheckResponse = await client.get("/api/now/table/sys_dictionary", {
        params: {
          sysparm_query: `name=${table}^element=${fieldName}`,
          sysparm_limit: 1,
          sysparm_fields: "element,internal_type",
        },
      })

      const fieldCheck = fieldCheckResponse.data.result

      if (!fieldCheck || fieldCheck.length === 0) {
        inputFieldsAdded.push({
          field: fieldName,
          status: "warning",
          message: "Field not found on table",
        })
        continue
      }

      // Add input field to solution
      const inputFieldResponse = await client.post("/api/now/table/ml_solution_input_field", {
        solution_definition: solutionSysId,
        field: fieldName,
        active: true,
      })

      inputFieldsAdded.push({
        field: fieldName,
        status: "success",
        sys_id: inputFieldResponse.data.result.sys_id,
      })
    }

    return createSuccessResult({
      status: "success",
      message: "Predictive Intelligence solution definition created successfully",
      solution: {
        sys_id: solutionSysId,
        name: name,
        table: table,
        type: solution_type,
        capability: capability,
        framework: mlFramework,
        output_field: output_field,
        input_fields_count: inputFieldsAdded.filter((f) => f.status === "success").length,
        active: false,
        auto_retrain: auto_retrain,
      },
      input_fields: inputFieldsAdded,
      next_steps: [
        "1. Review solution configuration in ServiceNow: Predictive Intelligence > Solutions",
        `2. Train the solution: Use snow_train_pi_solution with sys_id: ${solutionSysId}`,
        "3. Monitor training: Use snow_monitor_pi_training",
        "4. Activate solution: Use snow_activate_pi_solution when training completes",
        "5. Make predictions: Use ml_predictive_intelligence tool",
      ],
      training_estimate: "Training typically takes 10-30 minutes depending on data volume",
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
