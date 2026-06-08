/**
 * snow_agile_story_manage - Create and update user stories
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_agile_story_manage",
  description:
    "Create and update user stories in ServiceNow Agile 2.0. Assign story points, link to sprints/epics, manage acceptance criteria, and update state.",
  category: "standard",
  subcategory: "agile",
  use_cases: ["agile", "scrum", "story", "user story", "backlog"],
  complexity: "beginner",
  frequency: "high",
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "update"],
        description: "Action to perform",
      },
      sys_id: {
        type: "string",
        description: "Story sys_id (required for update)",
      },
      title: {
        type: "string",
        description: "Story title / short description",
      },
      description: {
        type: "string",
        description: "Detailed description",
      },
      story_points: {
        type: "number",
        description: "Story point estimate (1, 2, 3, 5, 8, 13, 21)",
      },
      sprint: {
        type: "string",
        description: "Sprint sys_id or number to assign to",
      },
      epic: {
        type: "string",
        description: "Epic sys_id or number to link to",
      },
      assigned_to: {
        type: "string",
        description: "User sys_id or username to assign",
      },
      state: {
        type: "string",
        enum: ["Draft", "Ready", "Work In Progress", "Testing", "Closed Complete", "Closed Incomplete"],
        description: "Story state",
      },
      priority: {
        type: "number",
        enum: [1, 2, 3, 4],
        description: "Priority (1=Critical, 2=High, 3=Moderate, 4=Low)",
      },
      acceptance_criteria: {
        type: "string",
        description: "Acceptance criteria for the story",
      },
      blocked: {
        type: "boolean",
        description: "Whether the story is blocked",
      },
      blocked_reason: {
        type: "string",
        description: "Reason for being blocked",
      },
    },
    required: ["action"],
  },
}

const STATE_MAP: Record<string, string> = {
  Draft: "-6",
  Ready: "-5",
  "Work In Progress": "2",
  Testing: "-2",
  "Closed Complete": "3",
  "Closed Incomplete": "4",
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    action,
    sys_id,
    title,
    description,
    story_points,
    sprint,
    epic,
    assigned_to,
    state,
    priority,
    acceptance_criteria,
    blocked,
    blocked_reason,
  } = args
  try {
    const client = await getAuthenticatedClient(context)

    const body: Record<string, any> = {}
    if (title) body.short_description = title
    if (description) body.description = description
    if (story_points !== undefined) body.story_points = story_points
    if (assigned_to) body.assigned_to = assigned_to
    if (state && STATE_MAP[state]) body.state = STATE_MAP[state]
    if (priority) body.priority = priority
    if (acceptance_criteria) body.acceptance_criteria = acceptance_criteria
    if (blocked !== undefined) body.blocked = blocked
    if (blocked_reason) body.blocked_reason = blocked_reason

    // Resolve sprint reference
    if (sprint) {
      if (sprint.indexOf("SPRNT") === 0) {
        const lookup = await client.get("/api/now/table/rm_sprint", {
          params: { sysparm_query: "number=" + sprint, sysparm_limit: 1, sysparm_fields: "sys_id" },
        })
        const found = lookup.data.result || []
        if (found.length > 0) body.sprint = found[0].sys_id
        else return createErrorResult("Sprint not found: " + sprint)
      } else {
        body.sprint = sprint
      }
    }

    // Resolve epic reference
    if (epic) {
      if (epic.indexOf("EPIC") === 0) {
        const lookup = await client.get("/api/now/table/rm_epic", {
          params: { sysparm_query: "number=" + epic, sysparm_limit: 1, sysparm_fields: "sys_id" },
        })
        const found = lookup.data.result || []
        if (found.length > 0) body.epic = found[0].sys_id
        else return createErrorResult("Epic not found: " + epic)
      } else {
        body.epic = epic
      }
    }

    if (action === "create") {
      if (!title) return createErrorResult("title is required for create action")
      const response = await client.post("/api/now/table/rm_story", body)
      return createSuccessResult({ action: "created", story: response.data.result })
    }

    if (action === "update") {
      if (!sys_id) return createErrorResult("sys_id is required for update action")
      const response = await client.patch("/api/now/table/rm_story/" + sys_id, body)
      return createSuccessResult({ action: "updated", story: response.data.result })
    }

    return createErrorResult("Unknown action: " + action)
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
