/**
 * snow_validate_widget_coherence - Validate widget component coherence
 *
 * Validates that widget server/client/HTML components communicate correctly
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_validate_widget_coherence",
  description:
    "Validates widget coherence by analyzing server/client/HTML component communication. Checks data bindings, action handlers, and method implementations to ensure all parts work together correctly.",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "validation",
  use_cases: ["widget-validation", "coherence-check", "testing"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Validation function - analyzes widget without saving
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      sys_id: { type: "string", description: "Widget sys_id to validate (optional if providing code)" },
      template: { type: "string", description: "HTML template code (optional if using sys_id)" },
      css: { type: "string", description: "CSS styles (optional)" },
      client_script: { type: "string", description: "Client controller script (optional)" },
      server_script: { type: "string", description: "Server script (optional)" },
      option_schema: { type: "string", description: "Widget options schema JSON" },
      validation_mode: {
        type: "string",
        enum: ["full", "template_only", "data_only"],
        description: "Validation mode: full (all components), template_only (HTML bindings), data_only (server data)",
        default: "full",
      },
    },
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { sys_id, template, css, client_script, server_script, option_schema, validation_mode = "full" } = args

  try {
    const client = await getAuthenticatedClient(context)
    let widgetData: any = {}

    // Fetch widget if sys_id provided
    if (sys_id) {
      const response = await client.get(`/api/now/table/sp_widget/${sys_id}`)
      if (!response.data.result) {
        throw new SnowFlowError(ErrorType.RESOURCE_NOT_FOUND, `Widget not found: ${sys_id}`, { retryable: false })
      }
      widgetData = response.data.result
    } else {
      // Use provided code
      widgetData = {
        template: template || "",
        css: css || "",
        client_script: client_script || "",
        script: server_script || "",
        option_schema: option_schema || "",
      }
    }

    const result: any = {
      widget_name: widgetData.name || widgetData.id || "Widget",
      validation_mode,
      components: {},
    }

    // Analyze template
    if (validation_mode === "full" || validation_mode === "template_only") {
      result.components.template = {
        html: widgetData.template,
        line_count: widgetData.template?.split("\n").length || 0,
        data_bindings: extractDataBindings(widgetData.template || ""),
        ng_directives: extractNgDirectives(widgetData.template || ""),
      }
    }

    // Analyze CSS
    if (widgetData.css) {
      result.components.css = {
        styles: widgetData.css,
        line_count: widgetData.css.split("\n").length,
        classes: extractCssClasses(widgetData.css),
      }
    }

    // Analyze server script
    if (validation_mode === "full" || validation_mode === "data_only") {
      if (widgetData.script) {
        result.components.server_script = {
          code: widgetData.script,
          line_count: widgetData.script.split("\n").length,
          data_properties: extractDataProperties(widgetData.script),
          input_actions: extractInputActions(widgetData.script),
        }
      }
    }

    // Analyze client script
    if (validation_mode === "full" && widgetData.client_script) {
      result.components.client_script = {
        code: widgetData.client_script,
        line_count: widgetData.client_script.split("\n").length,
        methods: extractClientMethods(widgetData.client_script),
        server_calls: extractServerCalls(widgetData.client_script),
      }
    }

    // Validate coherence
    const coherence = validateWidgetCoherence(result.components)
    result.coherence = coherence

    const message =
      `🔍 Widget Coherence Validation\n\n` +
      `Name: ${result.widget_name}\n` +
      `Mode: ${validation_mode}\n\n` +
      `Components Analyzed:\n` +
      (result.components.template
        ? `- Template: ${result.components.template.line_count} lines, ${result.components.template.data_bindings.length} data bindings\n`
        : "") +
      (result.components.css
        ? `- CSS: ${result.components.css.line_count} lines, ${result.components.css.classes.length} classes\n`
        : "") +
      (result.components.server_script
        ? `- Server: ${result.components.server_script.line_count} lines, ${result.components.server_script.data_properties.length} data properties\n`
        : "") +
      (result.components.client_script
        ? `- Client: ${result.components.client_script.line_count} lines, ${result.components.client_script.methods.length} methods\n`
        : "") +
      `\nCoherence: ${coherence.coherent ? "✅ Valid" : "⚠️ Issues Found"}` +
      (coherence.issues.length > 0 ? `\n\nIssues:\n${coherence.issues.map((i: string) => `- ${i}`).join("\n")}` : "")

    return createSuccessResult(result, { message })
  } catch (error: any) {
    return createErrorResult(
      error instanceof SnowFlowError
        ? error
        : new SnowFlowError(ErrorType.NETWORK_ERROR, `Validation failed: ${error.message}`, { originalError: error }),
    )
  }
}

function extractDataBindings(html: string): string[] {
  const bindings: string[] = []
  const pattern = /\{\{data\.(\w+)\}\}/g
  let match
  while ((match = pattern.exec(html)) !== null) {
    if (!bindings.includes(match[1])) {
      bindings.push(match[1])
    }
  }
  return bindings
}

function extractNgDirectives(html: string): string[] {
  const directives: string[] = []
  const pattern = /ng-(\w+)=/g
  let match
  while ((match = pattern.exec(html)) !== null) {
    if (!directives.includes(`ng-${match[1]}`)) {
      directives.push(`ng-${match[1]}`)
    }
  }
  return directives
}

function extractCssClasses(css: string): string[] {
  const classes: string[] = []
  const pattern = /\.([a-zA-Z][a-zA-Z0-9_-]*)/g
  let match
  while ((match = pattern.exec(css)) !== null) {
    if (!classes.includes(match[1])) {
      classes.push(match[1])
    }
  }
  return classes
}

function extractDataProperties(script: string): string[] {
  const properties: string[] = []
  const pattern = /data\.(\w+)\s*=/g
  let match
  while ((match = pattern.exec(script)) !== null) {
    if (!properties.includes(match[1])) {
      properties.push(match[1])
    }
  }
  return properties
}

function extractInputActions(script: string): string[] {
  const actions: string[] = []
  const pattern = /input\.action\s*===?\s*['"](\w+)['"]/g
  let match
  while ((match = pattern.exec(script)) !== null) {
    if (!actions.includes(match[1])) {
      actions.push(match[1])
    }
  }
  return actions
}

function extractClientMethods(script: string): string[] {
  const methods: string[] = []
  const pattern = /(?:c|$scope)\.(\w+)\s*=\s*function/g
  let match
  while ((match = pattern.exec(script)) !== null) {
    if (!methods.includes(match[1])) {
      methods.push(match[1])
    }
  }
  return methods
}

function extractServerCalls(script: string): string[] {
  const calls: string[] = []
  const pattern = /c\.server\.get\(\s*\{\s*action:\s*['"](\w+)['"]/g
  let match
  while ((match = pattern.exec(script)) !== null) {
    if (!calls.includes(match[1])) {
      calls.push(match[1])
    }
  }
  return calls
}

function validateWidgetCoherence(components: any): any {
  const issues: string[] = []

  // Check if template data bindings exist in server
  if (components.template && components.server_script) {
    const templateBindings = components.template.data_bindings || []
    const serverProperties = components.server_script.data_properties || []

    for (const binding of templateBindings) {
      if (!serverProperties.includes(binding)) {
        issues.push(`Template references data.${binding} but server doesn't initialize it`)
      }
    }
  }

  // Check if client server calls have handlers
  if (components.client_script && components.server_script) {
    const serverCalls = components.client_script.server_calls || []
    const inputActions = components.server_script.input_actions || []

    for (const call of serverCalls) {
      if (!inputActions.includes(call)) {
        issues.push(`Client calls action '${call}' but server doesn't handle it`)
      }
    }
  }

  return {
    coherent: issues.length === 0,
    issues,
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
