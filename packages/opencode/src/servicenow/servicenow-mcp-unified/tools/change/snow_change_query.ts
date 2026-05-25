/**
 * snow_change_query - Unified Change Query Operations
 *
 * Change query operations: get details, search, assess risk.
 *
 * Replaces: snow_get_change_request, snow_search_change_requests, snow_assess_change_risk
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_change_query",
  description: "Unified change query (get, search, assess_risk)",
  category: "itsm",
  subcategory: "change",
  use_cases: ["change-management", "query", "risk-assessment"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - Query operation - only reads data
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Query action",
        enum: ["get", "search", "assess_risk"],
      },
      // GET parameters
      sys_id: {
        type: "string",
        description: "[get/assess_risk] Change sys_id or number",
      },
      include_tasks: {
        type: "boolean",
        description: "[get] Include change tasks",
        default: true,
      },
      include_approvals: {
        type: "boolean",
        description: "[get] Include approval history",
        default: true,
      },
      // SEARCH parameters
      query: {
        type: "string",
        description: "[search] Search query",
      },
      state: {
        type: "string",
        description: "[search] Filter by state",
      },
      type: {
        type: "string",
        description: "[search] Filter by type",
        enum: ["standard", "normal", "emergency"],
      },
      risk: {
        type: "string",
        description: "[search] Filter by risk",
        enum: ["high", "medium", "low"],
      },
      limit: {
        type: "number",
        description: "[search] Maximum results",
        default: 10,
      },
    },
    required: ["action"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { action } = args

  try {
    switch (action) {
      case "get":
        return await executeGet(args, context)
      case "search":
        return await executeSearch(args, context)
      case "assess_risk":
        return await executeAssessRisk(args, context)
      default:
        return createErrorResult(`Unknown action: ${action}`)
    }
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

// ==================== GET ====================
async function executeGet(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { sys_id, include_tasks = true, include_approvals = true } = args

  if (!sys_id) {
    return createErrorResult("sys_id is required for get action")
  }

  const client = await getAuthenticatedClient(context)

  // Get change request
  const changeQuery = sys_id.match(/^[a-f0-9]{32}$/) ? "sys_id=" + sys_id : "number=" + sys_id
  const changeResponse = await client.get("/api/now/table/change_request?sysparm_query=" + changeQuery)

  if (!changeResponse.data?.result?.[0]) {
    return createErrorResult("Change request not found")
  }

  const change = changeResponse.data.result[0]
  const result: any = { change }

  // Get tasks if requested
  if (include_tasks) {
    const tasksResponse = await client.get("/api/now/table/change_task?sysparm_query=change_request=" + change.sys_id)
    result.tasks = tasksResponse.data?.result || []
  }

  // Get approvals if requested
  if (include_approvals) {
    const approvalsResponse = await client.get(
      "/api/now/table/sysapproval_approver?sysparm_query=document_id=" + change.sys_id,
    )
    result.approvals = approvalsResponse.data?.result || []
  }

  return createSuccessResult({
    action: "get",
    ...result,
  })
}

// ==================== SEARCH ====================
async function executeSearch(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { query, state, type, risk, limit = 10 } = args

  const client = await getAuthenticatedClient(context)

  // Build query string
  const queryParts = []
  if (query) {
    queryParts.push("short_descriptionLIKE" + query + "^ORdescriptionLIKE" + query)
  }
  if (state) {
    queryParts.push("state=" + state)
  }
  if (type) {
    queryParts.push("type=" + type)
  }
  if (risk) {
    queryParts.push("risk=" + risk)
  }

  const queryString = queryParts.join("^")

  const response = await client.get("/api/now/table/change_request", {
    params: {
      sysparm_query: queryString || undefined,
      sysparm_limit: limit,
      sysparm_orderby: "DESCsys_created_on",
    },
  })

  return createSuccessResult({
    action: "search",
    changes: response.data.result,
    count: response.data.result.length,
  })
}

// ==================== ASSESS RISK ====================
async function executeAssessRisk(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { sys_id } = args

  if (!sys_id) {
    return createErrorResult("sys_id is required for assess_risk action")
  }

  const client = await getAuthenticatedClient(context)

  // Get change request
  const changeQuery = sys_id.match(/^[a-f0-9]{32}$/) ? "sys_id=" + sys_id : "number=" + sys_id
  const changeResponse = await client.get("/api/now/table/change_request?sysparm_query=" + changeQuery)

  if (!changeResponse.data?.result?.[0]) {
    return createErrorResult("Change request not found")
  }

  const change = changeResponse.data.result[0]

  // Simple risk assessment based on change attributes
  const riskFactors = []
  let riskScore = 0

  if (change.type === "emergency") {
    riskFactors.push("Emergency change type (+3)")
    riskScore += 3
  }
  if (change.impact === "1") {
    riskFactors.push("High impact (+2)")
    riskScore += 2
  }
  if (change.risk === "high") {
    riskFactors.push("High risk classification (+2)")
    riskScore += 2
  }

  const riskLevel = riskScore >= 5 ? "high" : riskScore >= 3 ? "medium" : "low"

  return createSuccessResult({
    action: "assess_risk",
    change_sys_id: change.sys_id,
    change_number: change.number,
    risk_assessment: {
      risk_level: riskLevel,
      risk_score: riskScore,
      risk_factors: riskFactors,
      current_risk: change.risk,
      impact: change.impact,
      type: change.type,
    },
  })
}

export const version = "2.0.0"
export const author = "Serac v8.2.0 Tool Merging - Phase 2"
