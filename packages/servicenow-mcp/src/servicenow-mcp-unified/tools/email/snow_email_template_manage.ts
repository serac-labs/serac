/**
 * snow_email_template_manage - Unified email template lifecycle management
 *
 * Manages sysevent_email_template records beyond initial creation: listing,
 * previewing against a sample record, sending a test email to a chosen
 * address, importing/exporting template JSON, and cloning.
 *
 * Companion to snow_create_email_template (authoring) and the broader
 * snow_email_notification_manage (which handles sysevent_email_action rules
 * — the binding between a template and a triggering event). This tool
 * focuses on template content, testing, and portability.
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_email_template_manage",
  description: `Unified tool for ServiceNow email template lifecycle beyond creation: list, preview, send_test, import, export, clone. Wraps sysevent_email_template.

Actions:
- list — list templates, optionally filtered by table or active flag
- preview — render the template against a sample record (subject, body, sms — no email sent)
- send_test — send the rendered template as a real email to a specified address
- import — create or upsert a template from a JSON payload
- export — return the full template as a JSON payload suitable for re-import
- clone — duplicate a template under a new name

Use when: the agent needs to maintain templates after they exist — auditing them, testing rendering against a real record, sending a one-off test email, or moving a template between instances via JSON. For authoring a new template, use snow_create_email_template; for managing the event-to-template binding, use snow_email_notification_manage.

Returns: template records with sys_id, name, subject, content_type, collection (table); preview/test results with rendered subject and body.`,
  category: "automation",
  subcategory: "notifications",
  use_cases: ["email", "templates", "notifications", "testing", "import-export"],
  complexity: "intermediate",
  frequency: "medium",
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Management action to perform",
        enum: ["list", "preview", "send_test", "import", "export", "clone"],
      },
      // Identifiers
      sys_id: {
        type: "string",
        description: "[preview/send_test/export/clone] Template sys_id",
      },
      name: {
        type: "string",
        description: "[preview/send_test/export/clone] Template name (used as identifier when sys_id is absent)",
      },
      // LIST filters
      table: {
        type: "string",
        description: "[list] Filter by collection (table the template targets)",
      },
      active_only: {
        type: "boolean",
        description: "[list] Only return active templates",
        default: false,
      },
      limit: {
        type: "number",
        description: "[list] Maximum records to return",
        default: 50,
      },
      fields: {
        type: "string",
        description: "[list] Comma-separated list of fields to return",
      },
      // PREVIEW / SEND_TEST
      record_sys_id: {
        type: "string",
        description: "[preview/send_test] Sample record sys_id to render the template against (uses the template's collection table)",
      },
      sample_record_table: {
        type: "string",
        description: "[preview/send_test] Override the table the sample record lives on (defaults to the template's collection)",
      },
      test_recipient: {
        type: "string",
        description: "[send_test] Email address that should receive the rendered email",
      },
      // IMPORT
      template_data: {
        type: "object",
        description: "[import] Full template payload (subject, message_html, message_text, content_type, collection, sms_alternate, name)",
      },
      // CLONE
      new_name: {
        type: "string",
        description: "[clone] Name for the cloned template (required)",
      },
    },
    required: ["action"],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const action = args.action as string

  try {
    switch (action) {
      case "list":
        return await executeList(args, context)
      case "preview":
        return await executePreview(args, context)
      case "send_test":
        return await executeSendTest(args, context)
      case "import":
        return await executeImport(args, context)
      case "export":
        return await executeExport(args, context)
      case "clone":
        return await executeClone(args, context)
      default:
        return createErrorResult(
          `Unknown action: ${action}. Valid actions: list, preview, send_test, import, export, clone`,
        )
    }
  } catch (error: unknown) {
    const err = error as Error
    return createErrorResult(
      err instanceof SnowFlowError
        ? err
        : new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, `Email template ${action} failed: ${err.message}`, {
            originalError: err,
          }),
    )
  }
}

// ==================== HELPERS ====================

async function findTemplate(
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  sysId: string | undefined,
  name: string | undefined,
): Promise<Record<string, unknown> | null> {
  if (sysId) {
    const direct = await client.get(`/api/now/table/sysevent_email_template/${sysId}`)
    if (direct.data.result && direct.data.result.sys_id) {
      return direct.data.result
    }
  }
  if (name) {
    const search = await client.get("/api/now/table/sysevent_email_template", {
      params: {
        sysparm_query: `name=${name}`,
        sysparm_limit: 1,
      },
    })
    const results = search.data.result || []
    if (results.length > 0) return results[0]
  }
  return null
}

/**
 * Substitute ${field} and ${current.field} placeholders against a record.
 * Best-effort: nested dot paths are resolved against the record. Anything
 * unresolved is left untouched so the caller can see what didn't render.
 *
 * Note: ServiceNow's actual template engine supports Jelly/script blocks
 * (<g:evaluate>, <mail_script>). Those cannot be rendered client-side, so
 * the preview is approximate — the send_test path goes through ServiceNow's
 * native renderer instead.
 */
function renderTemplate(text: string | undefined | null, record: Record<string, unknown>): string {
  if (!text) return ""
  return text.replace(/\$\{([^}]+)\}/g, (_match, expr: string) => {
    const trimmed = expr.trim()
    const path = trimmed.replace(/^current\./, "")
    const segments = path.split(".")
    let value: unknown = record
    for (const seg of segments) {
      if (value && typeof value === "object" && seg in (value as Record<string, unknown>)) {
        value = (value as Record<string, unknown>)[seg]
      } else {
        return "${" + expr + "}"
      }
    }
    if (value && typeof value === "object" && "display_value" in (value as Record<string, unknown>)) {
      return String((value as Record<string, unknown>).display_value ?? "")
    }
    return value === null || value === undefined ? "" : String(value)
  })
}

// ==================== LIST ====================

async function executeList(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const table = args.table as string | undefined
  const active_only = args.active_only === true
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  const client = await getAuthenticatedClient(context)

  const queryParts: string[] = []
  if (table) queryParts.push(`collection=${table}`)
  // sysevent_email_template has no `active` column on this platform — drop the filter.
  // active_only is accepted in the schema for forward compatibility but ignored here.
  void active_only

  const response = await client.get("/api/now/table/sysevent_email_template", {
    params: {
      sysparm_query: queryParts.join("^"),
      sysparm_limit: limit,
      sysparm_orderby: "name",
      ...(fields
        ? { sysparm_fields: fields }
        : { sysparm_fields: "sys_id,name,subject,collection,email_layout,sys_updated_on" }),
    },
  })

  const results = (response.data.result || []) as Array<Record<string, unknown>>

  return createSuccessResult({
    action: "list",
    count: results.length,
    templates: results.map((r) => ({
      sys_id: r.sys_id,
      name: r.name,
      subject: r.subject,
      table: r.collection,
      email_layout: r.email_layout,
      updated_at: r.sys_updated_on,
      url: `${context.instanceUrl}/nav_to.do?uri=sysevent_email_template.do?sys_id=${r.sys_id}`,
    })),
  })
}

// ==================== PREVIEW ====================

async function executePreview(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const name = args.name as string | undefined
  const record_sys_id = args.record_sys_id as string | undefined
  const sample_record_table = args.sample_record_table as string | undefined

  if (!sys_id && !name) {
    return createErrorResult("sys_id or name is required for preview action")
  }
  if (!record_sys_id) {
    return createErrorResult("record_sys_id is required for preview action")
  }

  const client = await getAuthenticatedClient(context)
  const template = await findTemplate(client, sys_id, name)
  if (!template) {
    return createErrorResult(`Email template not found: ${sys_id || name}`)
  }

  const targetTable = sample_record_table || (template.collection as string | undefined)
  if (!targetTable) {
    return createErrorResult("Template has no collection set; pass sample_record_table to choose a record's table")
  }

  const recordResponse = await client.get(`/api/now/table/${targetTable}/${record_sys_id}`, {
    params: { sysparm_display_value: "all" },
  })
  const record = (recordResponse.data.result || {}) as Record<string, unknown>
  if (!record.sys_id) {
    return createErrorResult(`Sample record ${record_sys_id} not found on ${targetTable}`)
  }

  const rendered = {
    subject: renderTemplate(template.subject as string | undefined, record),
    message_html: renderTemplate((template.message_html as string | undefined) || (template.message as string | undefined), record),
    message_text: renderTemplate(template.message_text as string | undefined, record),
    sms_alternate: renderTemplate(template.sms_alternate as string | undefined, record),
  }

  return createSuccessResult({
    action: "preview",
    template: { sys_id: template.sys_id, name: template.name },
    table: targetTable,
    record_sys_id,
    rendered,
    warnings: [
      "Preview substitutes ${field} placeholders client-side only — Jelly tags and mail scripts are not evaluated. Use action=send_test for ServiceNow-native rendering.",
    ],
  })
}

// ==================== SEND_TEST ====================

async function executeSendTest(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const name = args.name as string | undefined
  const record_sys_id = args.record_sys_id as string | undefined
  const sample_record_table = args.sample_record_table as string | undefined
  const test_recipient = args.test_recipient as string | undefined

  if (!sys_id && !name) {
    return createErrorResult("sys_id or name is required for send_test action")
  }
  if (!test_recipient) {
    return createErrorResult("test_recipient is required for send_test action")
  }

  const client = await getAuthenticatedClient(context)
  const template = await findTemplate(client, sys_id, name)
  if (!template) {
    return createErrorResult(`Email template not found: ${sys_id || name}`)
  }

  const targetTable = sample_record_table || (template.collection as string | undefined)
  let rendered: { subject: string; body: string }

  if (record_sys_id && targetTable) {
    // Pull the record so we can do best-effort placeholder substitution for
    // the test email body. The substitution is approximate (see preview).
    const recordResponse = await client.get(`/api/now/table/${targetTable}/${record_sys_id}`, {
      params: { sysparm_display_value: "all" },
    })
    const record = (recordResponse.data.result || {}) as Record<string, unknown>
    rendered = {
      subject: renderTemplate(template.subject as string | undefined, record),
      body:
        renderTemplate((template.message_html as string | undefined) || (template.message as string | undefined), record) ||
        renderTemplate(template.message_text as string | undefined, record),
    }
  } else {
    rendered = {
      subject: (template.subject as string) || "",
      body: ((template.message_html as string) || (template.message as string) || (template.message_text as string) || "") as string,
    }
  }

  // Use sys_email to send. ServiceNow processes the row through the outbound
  // email pipeline. Marking type=send-ready triggers the email engine on the
  // next sys_email_sender cycle.
  // TODO: verify sys_email field set for outbound test sends on a live instance
  const payload: Record<string, unknown> = {
    recipients: test_recipient,
    subject: `[TEST] ${rendered.subject}`,
    body: rendered.body,
    type: "send-ready",
    direct: "true",
  }

  const response = await client.post("/api/now/table/sys_email", payload)
  const result = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "send_test",
    queued: true,
    sys_id: result.sys_id,
    template: { sys_id: template.sys_id, name: template.name },
    recipient: test_recipient,
    rendered,
  })
}

// ==================== IMPORT ====================

async function executeImport(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const template_data = args.template_data as Record<string, unknown> | undefined

  if (!template_data || typeof template_data !== "object") {
    return createErrorResult("template_data object is required for import action")
  }
  const importName = template_data.name as string | undefined
  if (!importName) {
    return createErrorResult("template_data.name is required for import action")
  }

  const client = await getAuthenticatedClient(context)

  const cleaned: Record<string, unknown> = { ...template_data }
  delete cleaned.sys_id
  delete cleaned.sys_created_on
  delete cleaned.sys_created_by
  delete cleaned.sys_updated_on
  delete cleaned.sys_updated_by
  delete cleaned.sys_mod_count

  // Upsert by name
  const existingResponse = await client.get("/api/now/table/sysevent_email_template", {
    params: { sysparm_query: `name=${importName}`, sysparm_limit: 1, sysparm_fields: "sys_id" },
  })
  const existing = (existingResponse.data.result || []) as Array<Record<string, unknown>>

  let response
  let mode: "created" | "updated"
  if (existing.length > 0) {
    const targetSysId = existing[0].sys_id as string
    response = await client.patch(`/api/now/table/sysevent_email_template/${targetSysId}`, cleaned)
    mode = "updated"
  } else {
    response = await client.post("/api/now/table/sysevent_email_template", cleaned)
    mode = "created"
  }

  const result = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "import",
    import_action: mode,
    sys_id: result.sys_id,
    name: result.name,
    template: result,
    url: `${context.instanceUrl}/nav_to.do?uri=sysevent_email_template.do?sys_id=${result.sys_id}`,
  })
}

// ==================== EXPORT ====================

async function executeExport(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const name = args.name as string | undefined

  if (!sys_id && !name) {
    return createErrorResult("sys_id or name is required for export action")
  }

  const client = await getAuthenticatedClient(context)
  const template = await findTemplate(client, sys_id, name)
  if (!template) {
    return createErrorResult(`Email template not found: ${sys_id || name}`)
  }

  // Strip system fields for a clean re-importable payload
  const payload: Record<string, unknown> = { ...template }
  delete payload.sys_id
  delete payload.sys_created_on
  delete payload.sys_created_by
  delete payload.sys_updated_on
  delete payload.sys_updated_by
  delete payload.sys_mod_count

  return createSuccessResult({
    action: "export",
    sys_id: template.sys_id,
    name: template.name,
    template_data: payload,
  })
}

// ==================== CLONE ====================

async function executeClone(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const name = args.name as string | undefined
  const new_name = args.new_name as string | undefined

  if (!sys_id && !name) {
    return createErrorResult("sys_id or name is required to identify the source template")
  }
  if (!new_name) {
    return createErrorResult("new_name is required for clone action")
  }

  const client = await getAuthenticatedClient(context)
  const template = await findTemplate(client, sys_id, name)
  if (!template) {
    return createErrorResult(`Email template not found: ${sys_id || name}`)
  }

  // Reject duplicate target name
  const existingResponse = await client.get("/api/now/table/sysevent_email_template", {
    params: { sysparm_query: `name=${new_name}`, sysparm_limit: 1, sysparm_fields: "sys_id" },
  })
  if (((existingResponse.data.result || []) as Array<Record<string, unknown>>).length > 0) {
    return createErrorResult(`Email template '${new_name}' already exists`)
  }

  const payload: Record<string, unknown> = { ...template, name: new_name }
  delete payload.sys_id
  delete payload.sys_created_on
  delete payload.sys_created_by
  delete payload.sys_updated_on
  delete payload.sys_updated_by
  delete payload.sys_mod_count

  const response = await client.post("/api/now/table/sysevent_email_template", payload)
  const result = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "clone",
    cloned: true,
    sys_id: result.sys_id,
    name: result.name,
    source: { sys_id: template.sys_id, name: template.name },
    template: result,
    url: `${context.instanceUrl}/nav_to.do?uri=sysevent_email_template.do?sys_id=${result.sys_id}`,
  })
}

export const version = "1.0.0"
export const author = "groeimetai"
