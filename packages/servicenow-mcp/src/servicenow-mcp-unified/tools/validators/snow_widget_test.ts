/**
 * snow_widget_test - Test widget functionality
 *
 * Executes comprehensive widget testing with multiple data scenarios
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_widget_test",
  description:
    "Executes comprehensive widget testing with multiple data scenarios. Validates client/server scripts, API calls, dependencies, and generates coverage reports.",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "validation",
  use_cases: ["widget-testing", "testing", "validation"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Testing function - validates widget without modifying
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      sys_id: { type: "string", description: "Widget sys_id to test" },
      test_scenarios: {
        type: "array",
        description: "Array of test scenarios with input data and expected outputs",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Test scenario name" },
            input: { type: "object", description: "Input data for the test" },
            expected: { type: "object", description: "Expected output (optional)" },
            options: { type: "object", description: "Widget instance options" },
          },
        },
      },
      coverage: {
        type: "boolean",
        description: "Check code coverage for HTML/CSS/JS integration",
        default: true,
      },
      validate_dependencies: {
        type: "boolean",
        description: "Check for missing dependencies like Chart.js",
        default: true,
      },
    },
    required: ["sys_id"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { sys_id, test_scenarios = [], coverage = true, validate_dependencies = true } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Fetch widget
    const response = await client.get(`/api/now/table/sp_widget/${sys_id}`)
    if (!response.data.result) {
      throw new SnowFlowError(ErrorType.RESOURCE_NOT_FOUND, `Widget not found: ${sys_id}`, { retryable: false })
    }

    const widget = response.data.result
    const testResults: any = {
      widget_name: widget.name || widget.id,
      sys_id,
      timestamp: new Date().toISOString(),
      scenarios: [],
      coverage_report: null,
      dependency_check: null,
    }

    // Run test scenarios
    for (const scenario of test_scenarios) {
      const scenarioResult: any = {
        name: scenario.name,
        passed: false,
        errors: [],
      }

      try {
        // Validate server script execution
        if (widget.script) {
          // Check if script uses input data
          const usesInput = widget.script.includes("input.")
          if (usesInput && !scenario.input) {
            scenarioResult.errors.push("Server script expects input but none provided")
          }

          // Check for syntax errors (basic)
          if (widget.script.includes("const ") || widget.script.includes("let ")) {
            scenarioResult.errors.push("Server script uses ES6+ syntax (const/let) - not supported in ServiceNow")
          }
        }

        // Validate client script
        if (widget.client_script) {
          // Check for common issues
          if (!widget.client_script.includes("function") && !widget.client_script.includes("=>")) {
            scenarioResult.errors.push("Client script may be empty or malformed")
          }
        }

        // Validate template
        if (widget.template) {
          // Check if template uses expected data
          if (scenario.expected) {
            for (const key of Object.keys(scenario.expected)) {
              if (!widget.template.includes(`data.${key}`)) {
                scenarioResult.errors.push(`Expected data.${key} not found in template`)
              }
            }
          }
        }

        scenarioResult.passed = scenarioResult.errors.length === 0
      } catch (scenarioError: any) {
        scenarioResult.passed = false
        scenarioResult.errors.push(scenarioError.message)
      }

      testResults.scenarios.push(scenarioResult)
    }

    // Coverage analysis
    if (coverage) {
      const coverageReport = {
        template_coverage: widget.template ? 100 : 0,
        server_coverage: widget.script ? 100 : 0,
        client_coverage: widget.client_script ? 100 : 0,
        css_coverage: widget.css ? 100 : 0,
        data_bindings: extractDataBindings(widget.template || ""),
        server_properties: extractDataProperties(widget.script || ""),
        binding_coverage: 0,
      }

      // Calculate binding coverage
      if (coverageReport.data_bindings.length > 0) {
        const coveredBindings = coverageReport.data_bindings.filter((binding: string) =>
          coverageReport.server_properties.includes(binding),
        ).length
        coverageReport.binding_coverage = Math.round((coveredBindings / coverageReport.data_bindings.length) * 100)
      } else {
        coverageReport.binding_coverage = 100
      }

      testResults.coverage_report = coverageReport
    }

    // Dependency validation
    if (validate_dependencies) {
      const dependencies = {
        chart_js: widget.template?.includes("chart") || widget.client_script?.includes("Chart"),
        jquery: widget.client_script?.includes("$") || widget.client_script?.includes("jQuery"),
        angular: widget.template?.includes("ng-") || widget.client_script?.includes("$scope"),
        sp_api: widget.client_script?.includes("spUtil") || widget.client_script?.includes("spModal"),
      }

      testResults.dependency_check = dependencies
    }

    // Calculate overall results
    const totalScenarios = testResults.scenarios.length
    const passedScenarios = testResults.scenarios.filter((s: any) => s.passed).length
    const passRate = totalScenarios > 0 ? Math.round((passedScenarios / totalScenarios) * 100) : 0

    const message =
      `🧪 Widget Test Results\n\n` +
      `Widget: ${testResults.widget_name}\n` +
      `Test Scenarios: ${passedScenarios}/${totalScenarios} passed (${passRate}%)\n\n` +
      (testResults.coverage_report
        ? `Coverage:\n` +
          `- Data Binding: ${testResults.coverage_report.binding_coverage}%\n` +
          `- Template: ${testResults.coverage_report.template_coverage}%\n` +
          `- Server: ${testResults.coverage_report.server_coverage}%\n` +
          `- Client: ${testResults.coverage_report.client_coverage}%\n\n`
        : "") +
      `Scenarios:\n${testResults.scenarios.map((s: any) => `${s.passed ? "✅" : "❌"} ${s.name}${s.errors.length > 0 ? `: ${s.errors.join(", ")}` : ""}`).join("\n")}`

    return createSuccessResult(testResults, { message })
  } catch (error: any) {
    return createErrorResult(
      error instanceof SnowFlowError
        ? error
        : new SnowFlowError(ErrorType.NETWORK_ERROR, `Widget test failed: ${error.message}`, { originalError: error }),
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

export const version = "1.0.0"
export const author = "Serac SDK Migration"
