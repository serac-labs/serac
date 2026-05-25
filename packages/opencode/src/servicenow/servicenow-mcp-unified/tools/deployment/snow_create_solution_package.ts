/**
 * snow_create_solution_package - Create solution packages with MULTIPLE artifacts
 *
 * ⚠️ USE THIS ONLY FOR MULTI-ARTIFACT SOLUTIONS!
 * For creating a SINGLE widget, script, or artifact → use snow_artifact_manage instead!
 *
 * This tool is for bundling MULTIPLE related artifacts into one deployment package.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"
import { execute as executeArtifactManage } from "./snow_artifact_manage.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_solution_package",
  description: `Bundle multiple related artifacts into a single deployment package, tracked by a freshly created Update Set switched as current.

Use when: building a feature bundle of 3+ related artifacts that ship as one unit (e.g. HR Portal: widget + script includes + business rule). For single artifacts use snow_artifact_manage directly — this tool delegates to it for each artifact and adds package-level Update Set wiring on top.

Each artifact entry has a type and a create object that's passed through to snow_artifact_manage. Failures per artifact are collected (not fatal) so you can retry the failures individually.`,
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "deployment",
  use_cases: ["multi-artifact", "solution-bundle", "feature-package"],
  complexity: "advanced",
  frequency: "low",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Solution package name" },
      description: { type: "string", description: "Package description" },
      artifacts: {
        type: "array",
        description: "Artifacts to include in the package",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["widget", "script_include", "business_rule", "table"] },
            create: { type: "object", description: "Artifact creation configuration" },
          },
        },
      },
      new_update_set: { type: "boolean", description: "Force new update set", default: true },
    },
    required: ["name", "artifacts"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, description, artifacts, new_update_set = true } = args

  try {
    const client = await getAuthenticatedClient(context)
    const results: any = {
      package_name: name,
      created_artifacts: [],
      update_set_id: null,
      errors: [],
    }

    // Step 1: Create Update Set for the package
    if (new_update_set) {
      const updateSetResponse = await client.post("/api/now/table/sys_update_set", {
        name: `${name} - Solution Package`,
        description: description || `Solution package: ${name}`,
        state: "in progress",
      })
      results.update_set_id = updateSetResponse.data.result.sys_id

      // Set as current Update Set for the service account.
      // is_current is not a writable field on sys_update_set — the user's
      // current Update Set is tracked via sys_user_preference name=sys_update_set.
      const existingPref = await client.get("/api/now/table/sys_user_preference", {
        params: {
          sysparm_query: "name=sys_update_set^user=javascript:gs.getUserID()",
          sysparm_limit: 1,
        },
      })

      if (existingPref.data.result && existingPref.data.result.length > 0) {
        await client.patch(`/api/now/table/sys_user_preference/${existingPref.data.result[0].sys_id}`, {
          value: results.update_set_id,
        })
      } else {
        await client.post("/api/now/table/sys_user_preference", {
          name: "sys_update_set",
          value: results.update_set_id,
          user: "javascript:gs.getUserID()",
        })
      }
    }

    // Step 2: Create each artifact using snow_artifact_manage (DRY principle)
    for (const artifact of artifacts) {
      try {
        // Delegate to snow_artifact_manage for artifact creation
        const artifactResult = await executeArtifactManage(
          {
            action: "create",
            type: artifact.type,
            ...artifact.create, // Spread the create config (name, script, template, etc.)
          },
          context,
        )

        if (!artifactResult.success) {
          results.errors.push({
            type: artifact.type,
            error: artifactResult.error || "Unknown error",
          })
          continue
        }

        // Extract result data from the successful response
        const resultData = artifactResult.data || {}

        results.created_artifacts.push({
          type: artifact.type,
          sys_id: resultData.sys_id,
          name: resultData.name,
          table: resultData.table,
          url: resultData.url,
        })
      } catch (artifactError: any) {
        results.errors.push({
          type: artifact.type,
          error: artifactError.message,
        })
      }
    }

    // Step 3: Generate deployment documentation
    const documentation = {
      package: name,
      description,
      created_at: new Date().toISOString(),
      update_set: results.update_set_id,
      artifacts: results.created_artifacts,
      total_artifacts: results.created_artifacts.length,
      total_errors: results.errors.length,
    }

    const message =
      `✅ Solution Package Created\n\n` +
      `Package: ${name}\n` +
      `Update Set: ${results.update_set_id}\n` +
      `Artifacts Created: ${results.created_artifacts.length}\n` +
      `Errors: ${results.errors.length}\n\n` +
      `Artifacts:\n${results.created_artifacts.map((a: any) => `- ${a.type}: ${a.name} (${a.sys_id})`).join("\n")}` +
      (results.errors.length > 0
        ? `\n\nErrors:\n${results.errors.map((e: any) => `- ${typeof e === "string" ? e : e.error}`).join("\n")}`
        : "")

    return createSuccessResult(
      {
        ...results,
        documentation,
      },
      { message },
    )
  } catch (error: any) {
    return createErrorResult(
      error instanceof SnowFlowError
        ? error
        : new SnowFlowError(ErrorType.NETWORK_ERROR, `Solution package creation failed: ${error.message}`, {
            originalError: error,
          }),
    )
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
