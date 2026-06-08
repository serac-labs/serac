/**
 * snow_create_script_include - Create Script Includes
 *
 * Create reusable server-side script libraries with client-callable
 * support, access control, and API management.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"
import * as fs from "fs/promises"
import { existsSync } from "fs"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_script_include",
  description: "Create reusable Script Include with client-callable support",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "platform",
  use_cases: ["script-includes", "code-reuse", "api"],
  complexity: "intermediate",
  frequency: "high",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Script Include name (CamelCase recommended)",
      },
      script: {
        type: "string",
        description: "Script code (ES5 only, function constructor pattern)",
      },
      description: {
        type: "string",
        description: "Script Include description",
      },
      client_callable: {
        type: "boolean",
        description: "Allow client-side scripts to call this Script Include",
        default: false,
      },
      access: {
        type: "string",
        enum: ["public", "package_private"],
        description: "Access level",
        default: "package_private",
      },
      active: {
        type: "boolean",
        description: "Activate immediately",
        default: true,
      },
      api_name: {
        type: "string",
        description: "API name for client-callable (defaults to name)",
      },
      validate_es5: {
        type: "boolean",
        description: "Validate ES5 compliance before creation",
        default: true,
      },
      script_file: {
        type: "string",
        description:
          "Path to local script file. File content will be used as the script. Alternative to inline script parameter.",
      },
      upsert: {
        type: "boolean",
        description:
          "If true and a Script Include with the same name already exists, update it instead of returning an error.",
        default: false,
      },
    },
    required: ["name"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    name,
    script: inlineScript,
    script_file,
    description = "",
    client_callable = false,
    access = "package_private",
    active = true,
    api_name,
    validate_es5 = true,
    upsert = false,
  } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Resolve script content: script_file takes priority if provided, then inline script
    let script = inlineScript
    let scriptSource = "inline"

    if (script_file) {
      if (!existsSync(script_file)) {
        return createErrorResult(`Script file not found: ${script_file}`)
      }
      try {
        script = await fs.readFile(script_file, "utf-8")
        scriptSource = script_file
      } catch (e: any) {
        return createErrorResult(`Failed to read script file '${script_file}': ${e.message}`)
      }
    }

    if (!script) {
      return createErrorResult("Either script or script_file parameter is required")
    }

    // Validate ES5 compliance if requested (warning only, does not block creation)
    const es5Warnings: string[] = []
    if (validate_es5) {
      const es5Violations = detectES5Violations(script)
      if (es5Violations.length > 0) {
        es5Warnings.push(
          `Script contains ES6+ syntax (${es5Violations.map((v: any) => v.type).join(", ")}). This may cause issues in some ServiceNow contexts. Consider using ES5 syntax for maximum compatibility.`,
        )
      }
    }

    // Validate client-callable pattern
    if (client_callable) {
      if (!script.includes("type:") || !script.includes("function")) {
        throw new SnowFlowError(
          ErrorType.VALIDATION_ERROR,
          "Client-callable Script Includes must use typed function pattern",
          {
            details: {
              example: `var ${name} = Class.create();\n${name}.prototype = {\n  type: '${name}',\n  methodName: function() { /* code */ }\n};`,
            },
          },
        )
      }
    }

    // Check for existing Script Include
    const existingResponse = await client.get("/api/now/table/sys_script_include", {
      params: {
        sysparm_query: `name=${name}`,
        sysparm_fields: "sys_id,name",
        sysparm_limit: 1,
      },
    })

    const existingRecord =
      existingResponse.data.result && existingResponse.data.result.length > 0 ? existingResponse.data.result[0] : null

    if (existingRecord && !upsert) {
      return createErrorResult(
        `Script Include '${name}' already exists (sys_id: ${existingRecord.sys_id}). ` +
          `Use upsert=true to update the existing record, or use snow_artifact_manage with action='update'.`,
      )
    }

    // Build Script Include data
    const scriptIncludeData: any = {
      name,
      script,
      description,
      client_callable,
      access,
      active,
      api_name: api_name || name,
    }

    let scriptInclude: any
    let wasUpdated = false

    if (existingRecord && upsert) {
      // Update existing record
      const updateResponse = await client.patch(
        `/api/now/table/sys_script_include/${existingRecord.sys_id}`,
        scriptIncludeData,
      )
      scriptInclude = updateResponse.data.result
      wasUpdated = true
    } else {
      // Create new record
      const createResponse = await client.post("/api/now/table/sys_script_include", scriptIncludeData)
      scriptInclude = createResponse.data.result
    }

    const successData: any = {
      created: !wasUpdated,
      updated: wasUpdated,
      action: wasUpdated ? "updated" : "created",
      script_include: {
        sys_id: scriptInclude.sys_id,
        name: scriptInclude.name,
        api_name: scriptInclude.api_name,
        client_callable: scriptInclude.client_callable === "true",
        access: scriptInclude.access,
        active: scriptInclude.active === "true",
      },
      script_source: scriptSource,
      script_size: {
        lines: script.split("\n").length,
        characters: script.length,
      },
      usage: client_callable
        ? {
            server: `var helper = new ${name}();\nvar result = helper.methodName();`,
            client: `var ga = new GlideAjax('${api_name || name}');\nga.addParam('sysparm_name', 'methodName');\nga.getXMLAnswer(function(answer) { /* handle response */ });`,
          }
        : {
            server: `var helper = new ${name}();\nvar result = helper.methodName();`,
          },
    }

    // Add ES5 warnings if any (non-blocking, informational only)
    if (es5Warnings.length > 0) {
      successData.warnings = es5Warnings
    }

    return createSuccessResult(successData)
  } catch (error: any) {
    return createErrorResult(error instanceof SnowFlowError ? error : error.message)
  }
}

function detectES5Violations(code: string): any[] {
  const violations: any[] = []

  // Remove strings and comments before analyzing to avoid false positives
  const codeWithoutStrings = code
    .replace(/'[^'\\]*(?:\\.[^'\\]*)*'/g, '""') // Single-quoted strings
    .replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, '""') // Double-quoted strings
    .replace(/\/\/[^\n]*/g, "") // Single-line comments
    .replace(/\/\*[\s\S]*?\*\//g, "") // Multi-line comments

  const patterns = [
    { regex: /\bconst\s+/g, type: "const" },
    { regex: /\blet\s+/g, type: "let" },
    { regex: /=>\s*{|=>\s*\(/g, type: "arrow_function" },
    { regex: /`[^`]*`/g, type: "template_literal", checkOriginal: true },
    { regex: /\.\.\.[\w\[]/g, type: "spread" }, // Spread must be followed by identifier or [
    { regex: /class\s+\w+/g, type: "class" },
  ]

  patterns.forEach(({ regex, type, checkOriginal }) => {
    // For template literals, check original code (they might be in strings)
    const codeToCheck = checkOriginal ? code : codeWithoutStrings
    const matches = codeToCheck.match(regex)
    if (matches) {
      violations.push({ type, count: matches.length })
    }
  })

  return violations
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
