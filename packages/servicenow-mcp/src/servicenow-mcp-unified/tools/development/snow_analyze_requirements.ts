/**
 * snow_analyze_requirements - Analyze development requirements
 *
 * Identifies dependencies, suggests reusable components, and creates implementation roadmaps.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_analyze_requirements",
  description:
    "Analyzes development requirements to identify dependencies, suggest reusable components, and create implementation roadmaps.",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "analysis",
  use_cases: ["requirements", "planning", "roadmap"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Analysis operation - reads data
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      objective: {
        type: "string",
        description: 'Development objective (e.g., "iPhone provisioning for new users")',
      },
      auto_discover_dependencies: {
        type: "boolean",
        description: "Automatically discover required dependencies",
        default: true,
      },
      suggest_existing_components: {
        type: "boolean",
        description: "Suggest reuse of existing components",
        default: true,
      },
      create_dependency_map: {
        type: "boolean",
        description: "Create visual dependency map",
        default: true,
      },
      scope_preference: {
        type: "string",
        enum: ["global", "scoped", "auto"],
        description: "Deployment scope preference",
        default: "auto",
      },
    },
    required: ["objective"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    objective,
    auto_discover_dependencies = true,
    suggest_existing_components = true,
    create_dependency_map = true,
    scope_preference = "auto",
  } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Parse objective to identify key components
    const keywords = objective.toLowerCase()
    const analysis = {
      objective,
      scope: scope_preference,
      requiredComponents: [] as any[],
      existingComponents: [] as any[],
      dependencyMap: {} as any,
      implementationPlan: [] as any[],
    }

    // Identify required components based on keywords
    if (keywords.includes("workflow") || keywords.includes("flow")) {
      analysis.requiredComponents.push({
        type: "flow",
        table: "sys_hub_flow",
        purpose: "Process automation",
      })
    }

    if (keywords.includes("widget") || keywords.includes("portal")) {
      analysis.requiredComponents.push({
        type: "widget",
        table: "sp_widget",
        purpose: "User interface",
      })
    }

    if (keywords.includes("notification") || keywords.includes("email")) {
      analysis.requiredComponents.push({
        type: "notification",
        table: "sysevent_email_action",
        purpose: "Email notifications",
      })
    }

    if (keywords.includes("table") || keywords.includes("data")) {
      analysis.requiredComponents.push({
        type: "table",
        table: "sys_db_object",
        purpose: "Data storage",
      })
    }

    // Search for existing components if requested
    if (suggest_existing_components) {
      for (const component of analysis.requiredComponents) {
        try {
          const response = await client.query(component.table, {
            query: `nameLIKE${objective.split(" ")[0]}^active=true`,
            limit: 5,
          })

          if (response.data?.result?.length > 0) {
            analysis.existingComponents.push({
              ...component,
              found: response.data.result.map((r: any) => ({
                sys_id: r.sys_id,
                name: r.name || r.title,
                description: r.short_description,
              })),
            })
          }
        } catch (error) {
          // Continue if search fails
        }
      }
    }

    // Create dependency map
    if (create_dependency_map) {
      analysis.dependencyMap = {
        nodes: analysis.requiredComponents.map((c) => ({
          id: c.type,
          label: c.type.toUpperCase(),
          table: c.table,
        })),
        edges: [],
      }
    }

    // Create implementation plan
    analysis.implementationPlan = [
      {
        phase: 1,
        name: "Planning",
        tasks: ["Define scope and requirements", "Review existing components", "Identify dependencies"],
        estimated_days: 2,
      },
      {
        phase: 2,
        name: "Development",
        tasks: analysis.requiredComponents.map((c) => `Create ${c.type}`),
        estimated_days: 5,
      },
      {
        phase: 3,
        name: "Testing",
        tasks: ["Unit testing", "Integration testing", "User acceptance testing"],
        estimated_days: 3,
      },
      {
        phase: 4,
        name: "Deployment",
        tasks: ["Create update set", "Deploy to production", "Monitor and validate"],
        estimated_days: 1,
      },
    ]

    return createSuccessResult(
      {
        analysis,
        summary: `Requirements analyzed: ${analysis.requiredComponents.length} components needed, ${analysis.existingComponents.length} existing components found`,
        recommendations: [
          analysis.existingComponents.length > 0
            ? "Consider reusing existing components to save development time"
            : null,
          "Follow ServiceNow best practices for component development",
          "Test in sub-production environment before deploying",
        ].filter(Boolean),
      },
      {
        objective,
        components_needed: analysis.requiredComponents.length,
        existing_found: analysis.existingComponents.length,
      },
    )
  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return createErrorResult(errorMessage, { objective })
  }
}
