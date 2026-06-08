/**
 * snow_agile_backlog_groom - Backlog grooming: reprioritize and bulk-update stories
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_agile_backlog_groom",
  description:
    "Backlog grooming operations: reprioritize stories, bulk-update story points, move stories between epics, and assign stories to sprints in batch.",
  category: "standard",
  subcategory: "agile",
  use_cases: ["agile", "scrum", "backlog", "grooming", "refinement"],
  complexity: "intermediate",
  frequency: "medium",
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["reprioritize", "estimate", "assign_sprint", "move_epic"],
        description:
          "Grooming action: reprioritize (change priority), estimate (set story points), assign_sprint (move to sprint), move_epic (reassign epic)",
      },
      stories: {
        type: "array",
        items: {
          type: "object",
          properties: {
            sys_id: { type: "string", description: "Story sys_id" },
            priority: { type: "number", description: "New priority (for reprioritize)" },
            story_points: { type: "number", description: "Story point estimate (for estimate)" },
            order: { type: "number", description: "Backlog order/rank (for reprioritize)" },
          },
          required: ["sys_id"],
        },
        description: "Array of stories to update",
      },
      sprint: {
        type: "string",
        description: "Target sprint sys_id or number (for assign_sprint action)",
      },
      epic: {
        type: "string",
        description: "Target epic sys_id or number (for move_epic action)",
      },
    },
    required: ["action", "stories"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { action, stories, sprint, epic } = args
  try {
    const client = await getAuthenticatedClient(context)

    if (!stories || stories.length === 0) return createErrorResult("stories array is required and must not be empty")

    // Resolve sprint reference if needed
    var resolvedSprint = sprint
    if (action === "assign_sprint" && sprint) {
      if (sprint.indexOf("SPRNT") === 0) {
        const lookup = await client.get("/api/now/table/rm_sprint", {
          params: { sysparm_query: "number=" + sprint, sysparm_limit: 1, sysparm_fields: "sys_id" },
        })
        const found = lookup.data.result || []
        if (found.length === 0) return createErrorResult("Sprint not found: " + sprint)
        resolvedSprint = found[0].sys_id
      }
    }

    // Resolve epic reference if needed
    var resolvedEpic = epic
    if (action === "move_epic" && epic) {
      if (epic.indexOf("EPIC") === 0) {
        const lookup = await client.get("/api/now/table/rm_epic", {
          params: { sysparm_query: "number=" + epic, sysparm_limit: 1, sysparm_fields: "sys_id" },
        })
        const found = lookup.data.result || []
        if (found.length === 0) return createErrorResult("Epic not found: " + epic)
        resolvedEpic = found[0].sys_id
      }
    }

    var results: any[] = []
    var successCount = 0
    var errorCount = 0

    for (var i = 0; i < stories.length; i++) {
      var story = stories[i]
      var updates: Record<string, any> = {}

      if (action === "reprioritize") {
        if (story.priority) updates.priority = story.priority
        if (story.order !== undefined) updates.order = story.order
      } else if (action === "estimate") {
        if (story.story_points !== undefined) updates.story_points = story.story_points
      } else if (action === "assign_sprint") {
        if (!resolvedSprint) return createErrorResult("sprint parameter is required for assign_sprint action")
        updates.sprint = resolvedSprint
      } else if (action === "move_epic") {
        if (!resolvedEpic) return createErrorResult("epic parameter is required for move_epic action")
        updates.epic = resolvedEpic
      } else {
        return createErrorResult("Unknown action: " + action)
      }

      if (Object.keys(updates).length === 0) {
        results.push({ sys_id: story.sys_id, status: "skipped", reason: "no updates" })
        continue
      }

      try {
        await client.patch("/api/now/table/rm_story/" + story.sys_id, updates)
        results.push({ sys_id: story.sys_id, status: "updated", updates })
        successCount++
      } catch (err: any) {
        results.push({ sys_id: story.sys_id, status: "error", error: err.message })
        errorCount++
      }
    }

    return createSuccessResult({
      action,
      total: stories.length,
      success: successCount,
      errors: errorCount,
      results,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
