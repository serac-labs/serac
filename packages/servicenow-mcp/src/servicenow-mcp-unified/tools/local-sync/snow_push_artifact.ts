/**
 * snow_push_artifact - Push local changes back to ServiceNow
 *
 * Push locally edited artifact files back to ServiceNow with
 * validation and coherence checking.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"
import * as fs from "fs/promises"
import * as path from "path"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_push_artifact",
  description: "Push locally edited artifact files back to ServiceNow with validation",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "local-sync",
  use_cases: ["local-development", "artifact-sync", "deployment"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: WRITE - Write operation based on name pattern
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      sys_id: {
        type: "string",
        description: "sys_id of artifact to update",
      },
      directory: {
        type: "string",
        description: "Directory containing edited artifact files",
      },
      validate: {
        type: "boolean",
        description: "Validate before pushing (ES5, coherence)",
        default: true,
      },
      force: {
        type: "boolean",
        description: "Force push despite validation warnings",
        default: false,
      },
    },
    required: ["sys_id", "directory"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { sys_id, directory, validate = true, force = false } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Detect artifact type from directory structure
    const { table, artifact } = await loadArtifactFromDirectory(directory)

    // Validation results (warnings only, don't block)
    const validationWarnings: string[] = []

    // Validate if requested
    if (validate && !force) {
      if (table === "sp_widget") {
        // ES5 validation (warning only, does not block push)
        if (artifact.script) {
          const es5Check = validateES5(artifact.script)
          if (!es5Check.valid) {
            validationWarnings.push(
              `Server script contains ES6+ syntax (${es5Check.violations.map((v: any) => v.type).join(", ")}). This may cause issues in ServiceNow's Rhino engine.`,
            )
          }
        }

        // Coherence validation
        const coherenceCheck = validateCoherence(artifact)
        if (!coherenceCheck.coherent) {
          const critical = coherenceCheck.issues.filter((i: any) => i.severity === "critical")
          if (critical.length > 0) {
            throw new SnowFlowError(ErrorType.WIDGET_COHERENCE_ERROR, "Widget coherence validation failed", {
              details: { issues: critical },
            })
          }
        }
      }
    }

    // Push to ServiceNow
    const updateResponse = await client.put(`/api/now/table/${table}/${sys_id}`, artifact)

    const successData: any = {
      updated: true,
      sys_id,
      table,
      artifact: updateResponse.data.result,
      validation: validate ? (validationWarnings.length > 0 ? "passed_with_warnings" : "passed") : "skipped",
    }

    // Add validation warnings if any (non-blocking, informational only)
    if (validationWarnings.length > 0) {
      successData.warnings = validationWarnings
    }

    return createSuccessResult(successData)
  } catch (error: any) {
    return createErrorResult(error instanceof SnowFlowError ? error : error.message)
  }
}

async function loadArtifactFromDirectory(directory: string): Promise<{ table: string; artifact: any }> {
  const files = await fs.readdir(directory)

  // Detect artifact type
  const hasWidget = files.some((f) => f.endsWith(".server.js") || f.endsWith(".client.js"))

  if (hasWidget) {
    // Widget artifact
    const artifact: any = {}

    for (const file of files) {
      const filePath = path.join(directory, file)
      const content = await fs.readFile(filePath, "utf-8")

      if (file.endsWith(".html")) {
        artifact.template = content
      } else if (file.endsWith(".server.js")) {
        artifact.script = content
      } else if (file.endsWith(".client.js")) {
        artifact.client_script = content
      } else if (file.endsWith(".css")) {
        artifact.css = content
      } else if (file.endsWith(".options.json")) {
        artifact.option_schema = content
      }
    }

    return { table: "sp_widget", artifact }
  }

  // Default to script include
  const scriptFile = files.find((f) => f.endsWith(".js"))
  if (scriptFile) {
    const script = await fs.readFile(path.join(directory, scriptFile), "utf-8")
    return { table: "sys_script_include", artifact: { script } }
  }

  throw new Error("Could not determine artifact type from directory")
}

function validateES5(code: string): { valid: boolean; violations: any[] } {
  const violations: any[] = []
  const patterns = [
    { regex: /\b(const|let)\s+/g, type: "const/let" },
    { regex: /\([^)]*\)\s*=>/g, type: "arrow_function" },
    { regex: /`[^`]*`/g, type: "template_literal" },
  ]

  patterns.forEach(({ regex, type }) => {
    let match
    while ((match = regex.exec(code)) !== null) {
      violations.push({ type, code: match[0] })
    }
  })

  return { valid: violations.length === 0, violations }
}

function validateCoherence(artifact: any): { coherent: boolean; issues: any[] } {
  const issues: any[] = []

  // Check if HTML references exist in server
  if (artifact.template && artifact.script) {
    const dataRefs = [...artifact.template.matchAll(/\{\{data\.(\w+)\}\}/g)].map((m) => m[1])
    const serverData = [...artifact.script.matchAll(/data\.(\w+)\s*=/g)].map((m) => m[1])

    dataRefs.forEach((ref) => {
      if (!serverData.includes(ref)) {
        issues.push({
          type: "missing_data",
          severity: "critical",
          description: `HTML references data.${ref} but server doesn't initialize it`,
        })
      }
    })
  }

  return {
    coherent: issues.filter((i) => i.severity === "critical").length === 0,
    issues,
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
