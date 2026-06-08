/**
 * snow_generate_docs - Automatic documentation generation
 *
 * Generate comprehensive documentation for ServiceNow artifacts
 * with relationships, dependencies, and usage examples.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_generate_docs",
  description: "Generate documentation for ServiceNow artifacts",
  // Metadata for tool discovery (not sent to LLM)
  category: "integration",
  subcategory: "documentation",
  use_cases: ["integration", "documentation", "analysis"],
  complexity: "intermediate",
  frequency: "low",

  // Permission enforcement
  // Classification: READ - Query/analysis operation
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      artifact_type: {
        type: "string",
        enum: ["widget", "script_include", "business_rule", "workflow", "rest_message", "transform_map"],
        description: "Type of artifact to document",
      },
      sys_id: {
        type: "string",
        description: "Artifact sys_id",
      },
      include_dependencies: {
        type: "boolean",
        description: "Include dependency analysis",
        default: true,
      },
      include_usage_examples: {
        type: "boolean",
        description: "Generate usage examples",
        default: true,
      },
      format: {
        type: "string",
        enum: ["markdown", "html", "json"],
        description: "Documentation format",
        default: "markdown",
      },
    },
    required: ["artifact_type", "sys_id"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    artifact_type,
    sys_id,
    include_dependencies = true,
    include_usage_examples = true,
    format = "markdown",
  } = args

  try {
    const client = await getAuthenticatedClient(context)

    const tableMap: Record<string, string> = {
      widget: "sp_widget",
      script_include: "sys_script_include",
      business_rule: "sys_script",
      workflow: "wf_workflow",
      rest_message: "sys_rest_message",
      transform_map: "sys_transform_map",
    }

    const table = tableMap[artifact_type]
    if (!table) {
      throw new Error(`Unsupported artifact type: ${artifact_type}`)
    }

    // Get artifact details
    const artifactResponse = await client.get(`/api/now/table/${table}/${sys_id}`)
    const artifact = artifactResponse.data.result

    if (!artifact) {
      throw new Error(`Artifact not found: ${sys_id}`)
    }

    // Build documentation structure
    const doc: any = {
      title: artifact.name || artifact.title || "Unnamed Artifact",
      type: artifact_type,
      sys_id,
      description: artifact.description || "No description provided",
      metadata: {
        created: artifact.sys_created_on,
        created_by: artifact.sys_created_by,
        updated: artifact.sys_updated_on,
        updated_by: artifact.sys_updated_by,
      },
    }

    // Type-specific documentation
    switch (artifact_type) {
      case "widget":
        doc.details = {
          id: artifact.id,
          has_server_script: !!artifact.script,
          has_client_script: !!artifact.client_script,
          has_template: !!artifact.template,
          has_css: !!artifact.css,
          data_table: artifact.data_table,
          option_schema: artifact.option_schema ? JSON.parse(artifact.option_schema) : null,
        }
        break

      case "script_include":
        doc.details = {
          api_name: artifact.api_name,
          client_callable: artifact.client_callable === "true",
          access: artifact.access,
          active: artifact.active === "true",
        }
        break

      case "business_rule":
        doc.details = {
          table: artifact.collection,
          when: artifact.when,
          order: artifact.order,
          active: artifact.active === "true",
          condition: artifact.condition,
        }
        break
    }

    // Dependency analysis
    if (include_dependencies) {
      const dependencies: string[] = []

      // Scan script for GlideRecord references
      const scriptContent = artifact.script || artifact.client_script || ""
      const grMatches = scriptContent.match(/new\s+GlideRecord\s*\(\s*['"]([^'"]+)['"]\s*\)/g)
      if (grMatches) {
        grMatches.forEach((match: string) => {
          const tableMatch = match.match(/['"]([^'"]+)['"]/)
          if (tableMatch) dependencies.push(`Table: ${tableMatch[1]}`)
        })
      }

      // Scan for Script Include references
      const siMatches = scriptContent.match(/new\s+([A-Z][a-zA-Z0-9_]*)\s*\(/g)
      if (siMatches) {
        siMatches.forEach((match: string) => {
          const classMatch = match.match(/new\s+([A-Z][a-zA-Z0-9_]*)/)
          if (classMatch) dependencies.push(`Script Include: ${classMatch[1]}`)
        })
      }

      doc.dependencies = [...new Set(dependencies)] // Remove duplicates
    }

    // Usage examples
    if (include_usage_examples) {
      doc.usage_examples = generateUsageExamples(artifact_type, artifact)
    }

    // Format output
    let formattedDoc
    switch (format) {
      case "markdown":
        formattedDoc = formatMarkdown(doc)
        break
      case "html":
        formattedDoc = formatHTML(doc)
        break
      case "json":
        formattedDoc = JSON.stringify(doc, null, 2)
        break
    }

    return createSuccessResult({
      generated: true,
      documentation: formattedDoc,
      format,
      artifact: {
        name: doc.title,
        type: artifact_type,
        sys_id,
      },
      dependencies_found: doc.dependencies?.length || 0,
      examples_generated: doc.usage_examples?.length || 0,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

function generateUsageExamples(artifactType: string, artifact: any): string[] {
  const examples: string[] = []

  switch (artifactType) {
    case "widget":
      examples.push(`<!-- Add to Service Portal page -->\n<widget id="${artifact.id}"></widget>`)
      if (artifact.option_schema) {
        examples.push(`<!-- With options -->\n<widget id="${artifact.id}" options='{"key": "value"}'></widget>`)
      }
      break

    case "script_include":
      if (artifact.client_callable === "true") {
        examples.push(
          `// Client Script\nvar si = new GlideAjax('${artifact.api_name}');\nsi.addParam('sysparm_name', 'methodName');\nsi.getXMLAnswer(function(answer) {\n  // Handle response\n});`,
        )
      }
      examples.push(`// Server Script\nvar helper = new ${artifact.api_name}();\nvar result = helper.someMethod();`)
      break

    case "business_rule":
      examples.push(
        `// Executes ${artifact.when} on table: ${artifact.collection}\n// Automatically triggered by system`,
      )
      break
  }

  return examples
}

function formatMarkdown(doc: any): string {
  let md = `# ${doc.title}\n\n`
  md += `**Type:** ${doc.type}\n\n`
  md += `**Description:** ${doc.description}\n\n`

  md += `## Metadata\n`
  md += `- Created: ${doc.metadata.created} by ${doc.metadata.created_by}\n`
  md += `- Updated: ${doc.metadata.updated} by ${doc.metadata.updated_by}\n\n`

  if (doc.details) {
    md += `## Details\n`
    Object.entries(doc.details).forEach(([key, value]) => {
      md += `- **${key}**: ${value}\n`
    })
    md += "\n"
  }

  if (doc.dependencies && doc.dependencies.length > 0) {
    md += `## Dependencies\n`
    doc.dependencies.forEach((dep: string) => (md += `- ${dep}\n`))
    md += "\n"
  }

  if (doc.usage_examples && doc.usage_examples.length > 0) {
    md += `## Usage Examples\n\n`
    doc.usage_examples.forEach((example: string, index: number) => {
      md += `### Example ${index + 1}\n\`\`\`javascript\n${example}\n\`\`\`\n\n`
    })
  }

  return md
}

function formatHTML(doc: any): string {
  let html = `<html><head><title>${doc.title}</title></head><body>`
  html += `<h1>${doc.title}</h1>`
  html += `<p><strong>Type:</strong> ${doc.type}</p>`
  html += `<p><strong>Description:</strong> ${doc.description}</p>`
  html += `<h2>Metadata</h2><ul>`
  html += `<li>Created: ${doc.metadata.created} by ${doc.metadata.created_by}</li>`
  html += `<li>Updated: ${doc.metadata.updated} by ${doc.metadata.updated_by}</li>`
  html += `</ul>`

  if (doc.dependencies && doc.dependencies.length > 0) {
    html += `<h2>Dependencies</h2><ul>`
    doc.dependencies.forEach((dep: string) => (html += `<li>${dep}</li>`))
    html += `</ul>`
  }

  html += `</body></html>`
  return html
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
