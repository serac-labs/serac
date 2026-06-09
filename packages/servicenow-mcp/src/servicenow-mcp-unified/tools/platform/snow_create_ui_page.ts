/**
 * snow_create_ui_page - Create UI Pages
 *
 * Create custom UI pages with Jelly/HTML templates, client scripts,
 * and processing scripts for custom interfaces.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_ui_page",
  description: "Create custom UI Page with Jelly/HTML template and processing script",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "platform",
  use_cases: ["ui-pages", "custom-ui", "jelly-templates"],
  complexity: "advanced",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "UI Page name (alphanumeric with underscores)",
      },
      html: {
        type: "string",
        description: "HTML/Jelly template content",
      },
      description: {
        type: "string",
        description: "Page description",
      },
      category: {
        type: "string",
        description: "Page category for organization",
      },
      processing_script: {
        type: "string",
        description: "Server-side processing script (ES5)",
      },
      client_script: {
        type: "string",
        description: "Client-side JavaScript",
      },
      direct: {
        type: "boolean",
        description: "Direct rendering (skip standard UI)",
        default: false,
      },
      active: {
        type: "boolean",
        description: "Activate immediately",
        default: true,
      },
    },
    required: ["name", "html"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    name,
    html,
    description = "",
    category = "general",
    processing_script = "",
    client_script = "",
    direct = false,
    active = true,
  } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Create UI Page
    const uiPageData: any = {
      name,
      html,
      description,
      category,
      processing_script,
      client_script,
      direct,
      active,
    }

    const response = await client.post("/api/now/table/sys_ui_page", uiPageData)
    const uiPage = response.data.result

    // Construct URL
    const pageUrl = `${context.instanceUrl}/${name}.do`

    // Provide Jelly examples
    const jellyExamples = {
      basic_structure: `<?xml version="1.0" encoding="utf-8" ?>
<j:jelly trim="false" xmlns:j="jelly:core" xmlns:g="glide" xmlns:j2="null" xmlns:g2="null">
  <h1>Page Title</h1>
  <p>\${RP.getMessage('Your message')}</p>
</j:jelly>`,
      with_gliderecord: `<g:evaluate var="jvar_gr">
  var gr = new GlideRecord('incident');
  gr.addQuery('active', true);
  gr.setLimit(10);
  gr.query();
  gr;
</g:evaluate>

<j:while test="\${jvar_gr.next()}">
  <p>\${jvar_gr.number}: \${jvar_gr.short_description}</p>
</j:while>`,
      with_form: `<form method="post">
  <input type="text" name="user_input" />
  <input type="submit" value="Submit" />
</form>

<!-- Processing script handles form submission -->
<!-- var userInput = RP.getParameterValue('user_input'); -->`,
    }

    return createSuccessResult({
      created: true,
      ui_page: {
        sys_id: uiPage.sys_id,
        name: uiPage.name,
        category: uiPage.category,
        direct: uiPage.direct === "true",
        active: uiPage.active === "true",
        url: pageUrl,
      },
      access: {
        url: pageUrl,
        direct_url: direct ? `${context.instanceUrl}/${name}.do?sysparm_direct=true` : null,
      },
      jelly_examples: jellyExamples,
      processing_script_context: {
        RP: "RequestParameters - access URL/form parameters",
        current: "Current GlideRecord if applicable",
        g_user: "Current user object",
        gs: "GlideSystem object",
      },
      best_practices: [
        "Use Jelly for server-side rendering",
        "Use client_script for client-side interactivity",
        "Processing script runs before page renders",
        "Direct pages skip standard ServiceNow UI chrome",
        "Test with different user roles for ACL",
        "Consider using UI Pages for custom portals/dashboards",
      ],
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
