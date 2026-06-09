/**
 * snow_github_tree - GitHub Repository Tree Browser (Enterprise)
 *
 * Retrieves directory structure of a GitHub repository via the enterprise proxy.
 * Returns metadata only (paths, types, sizes) — no file content enters the LLM context.
 *
 * Requires enterprise license with 'github' feature enabled.
 * GitHub PAT is managed server-side via the enterprise portal.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"
import { proxyToolCall } from "../../../enterprise-proxy/proxy.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_github_tree",
  description: `Browse GitHub repository structure via enterprise proxy. Returns metadata only (paths, types, sizes) — no file content in LLM context.

Use this to explore a repo before deploying files with snow_github_deploy.

Requires: Enterprise license with 'github' feature. GitHub PAT is managed server-side.`,
  category: "development",
  subcategory: "deployment",
  use_cases: ["github", "deployment", "browse", "repository"],
  complexity: "beginner",
  frequency: "medium",

  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      owner: {
        type: "string",
        description: 'GitHub owner or organization (e.g. "serac-labs")',
      },
      repo: {
        type: "string",
        description: 'Repository name (e.g. "serac")',
      },
      path: {
        type: "string",
        description: 'Subdirectory path to browse (default: root "/")',
      },
      branch: {
        type: "string",
        description: 'Branch name (default: "main")',
      },
    },
    required: ["owner", "repo"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { owner, repo, path: dirPath, branch } = args

  // Enterprise feature gate
  if (!context.enterprise?.features?.includes("github")) {
    return createErrorResult(
      'GitHub integration requires an enterprise license with the "github" feature enabled.\n\n' +
        "Upgrade at https://portal.serac.build or contact support.",
    )
  }

  try {
    // Call enterprise proxy to get directory listing from GitHub API
    const result = await proxyToolCall("github_get_content", {
      owner,
      repo,
      path: dirPath || "/",
      ref: branch || "main",
    })

    // GitHub API returns an array for directories, an object for files
    const entries = Array.isArray(result) ? result : [result]

    // Filter to metadata only — strip file content
    let totalSizeBytes = 0
    let fileCount = 0
    let dirCount = 0

    const tree = entries.map((entry: any) => {
      const item: any = {
        path: entry.path || entry.name,
        type: entry.type, // 'file' or 'dir'
        size: entry.size || 0,
      }

      if (entry.type === "file") {
        fileCount++
        totalSizeBytes += entry.size || 0
      } else if (entry.type === "dir") {
        dirCount++
      }

      return item
    })

    return createSuccessResult({
      owner,
      repo,
      path: dirPath || "/",
      branch: branch || "main",
      entries: tree,
      summary: {
        files: fileCount,
        directories: dirCount,
        total_size_bytes: totalSizeBytes,
      },
    })
  } catch (error: any) {
    return createErrorResult(`Failed to browse GitHub repository ${owner}/${repo}: ${error.message}`)
  }
}

export const version = "1.0.0"
export const author = "Serac Enterprise GitHub Pipeline"
