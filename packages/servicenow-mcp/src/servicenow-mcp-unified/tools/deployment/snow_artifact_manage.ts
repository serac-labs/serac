/**
 * snow_artifact_manage - Unified Artifact Management
 *
 * Comprehensive tool for managing ServiceNow artifact lifecycle: create, get, update,
 * delete, find, list, analyze, export, import, and clone operations.
 *
 * Replaces: snow_create_artifact, snow_update, snow_find_artifact,
 * snow_edit_artifact, snow_analyze_artifact, snow_export_artifact,
 * snow_import_artifact, snow_clone_instance_artifact
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"
import * as fs from "fs/promises"
import * as path from "path"
import { existsSync } from "fs"
import {
  ARTIFACT_TABLE_MAP,
  ARTIFACT_IDENTIFIER_FIELD,
  FILE_MAPPINGS,
  EXPORT_FILE_MAPPINGS,
} from "./shared/artifact-constants.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_artifact_manage",
  // Most actions are HTTP-safe — pure ServiceNow REST calls with inline
  // content (template / script / server_script / client_script / css /
  // option_schema / data). The unsafe args below all touch the local
  // filesystem (caller-supplied absolute paths) and are blocked by
  // call-tool.ts on HTTP. Agents on portal chat use the inline-content
  // path instead and write outputs to the portal sandbox via `write`.
  httpForbiddenArgs: [
    "artifact_directory",
    "template_file",
    "server_script_file",
    "client_script_file",
    "css_file",
    "option_schema_file",
    "script_file",
    "condition_file",
    "file_path",
    "export_path",
  ],
  description: `Unified tool for ServiceNow artifact lifecycle: create, get, update, delete, find, list, analyze, export, import, verify.

Actions:
- create — create a new artifact (widget, page, script, table, field, etc.)
- get — retrieve by sys_id or identifier
- update — update fields, including _file parameters for file-based updates
- delete — delete (with soft-delete support)
- find — search artifacts by query
- list — list all artifacts of a type
- analyze — analyze artifact dependencies
- export — export to JSON/XML
- import — import from JSON/XML file
- verify — compare local files against deployed artifact content

Supported artifact types: sp_widget/widget, sp_page/page, sys_ux_page/uib_page (UI Builder), script_include, business_rule, client_script, ui_policy, ui_action, rest_message, scheduled_job, transform_map, fix_script, table (sys_db_object), field (sys_dictionary), flow (sys_hub_flow), application (sys_app).

ES5 only: server-side scripts must use ES5 syntax (var, function, string concatenation — no arrow functions, const/let, template literals).

Application scope: pass application_scope to target a specific scope, or "global" for global-scope artifacts.`,
  category: "development",
  subcategory: "deployment",
  use_cases: ["deployment", "artifacts", "widgets", "scripts", "tables", "crud"],
  complexity: "intermediate",
  frequency: "high",

  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Management action to perform",
        enum: ["create", "get", "update", "delete", "find", "list", "analyze", "export", "import", "verify"],
      },
      // Common parameters
      type: {
        type: "string",
        description: "Artifact type (sp_widget, script_include, business_rule, table, field, etc.)",
        enum: [
          "sp_widget",
          "widget",
          "sp_page",
          "page",
          "sys_ux_page",
          "uib_page",
          "script_include",
          "business_rule",
          "client_script",
          "ui_policy",
          "ui_action",
          "rest_message",
          "scheduled_job",
          "transform_map",
          "fix_script",
          "table",
          "field",
          "flow",
          "application",
        ],
      },
      sys_id: {
        type: "string",
        description: "[get/update/delete/analyze/export] Artifact sys_id",
      },
      identifier: {
        type: "string",
        description: "[get/update/delete] Artifact identifier (name/id) - alternative to sys_id",
      },

      // CREATE parameters
      name: {
        type: "string",
        description: "[create] Artifact name/ID (required for create)",
      },
      title: {
        type: "string",
        description: "[create] Display title (for widgets/pages)",
      },
      description: {
        type: "string",
        description: "[create/update] Artifact description",
      },
      template: {
        type: "string",
        description: "[create/update] HTML template (for widgets/pages)",
      },
      server_script: {
        type: "string",
        description: "[create/update] Server-side script (ES5 only!)",
      },
      client_script: {
        type: "string",
        description: "[create/update] Client-side script",
      },
      css: {
        type: "string",
        description: "[create/update] CSS stylesheet (for widgets)",
      },
      option_schema: {
        type: "string",
        description: "[create/update] Option schema JSON (for widgets)",
      },
      script: {
        type: "string",
        description: "[create/update] Script content (for script includes, business rules, etc.)",
      },
      api_name: {
        type: "string",
        description: "[create] API name (for script includes)",
      },
      table: {
        type: "string",
        description: "[create/find] Table name (for business rules, client scripts, fields, etc.)",
      },
      when: {
        type: "string",
        enum: ["before", "after", "async", "display"],
        description: "[create] When to execute (business rules)",
      },
      insert: {
        type: "boolean",
        description: "[create] Run on insert (business rules)",
      },
      update_trigger: {
        type: "boolean",
        description: "[create] Run on update (business rules)",
      },
      delete_trigger: {
        type: "boolean",
        description: "[create] Run on delete (business rules)",
      },
      query_trigger: {
        type: "boolean",
        description: "[create] Run on query (business rules)",
      },
      active: {
        type: "boolean",
        description: "[create/update] Activate immediately",
        default: true,
      },
      // Table creation fields
      label: {
        type: "string",
        description: "[create] Table label (for tables) or field label (for fields)",
      },
      extends_table: {
        type: "string",
        description: "[create] Parent table to extend (for tables)",
      },
      is_extendable: {
        type: "boolean",
        description: "[create] Whether the table can be extended",
        default: true,
      },
      create_module: {
        type: "boolean",
        description: "[create] Create navigation module for the table",
        default: true,
      },
      create_access_controls: {
        type: "boolean",
        description: "[create] Create default ACLs for the table",
        default: false,
      },
      // Field creation fields
      column_name: {
        type: "string",
        description: "[create] Column/field name (for fields)",
      },
      column_label: {
        type: "string",
        description: "[create] Column/field display label (for fields)",
      },
      internal_type: {
        type: "string",
        description: "[create] Field type (for fields)",
        enum: [
          "string",
          "integer",
          "boolean",
          "reference",
          "glide_date",
          "glide_date_time",
          "decimal",
          "float",
          "choice",
          "journal",
          "journal_input",
          "html",
          "url",
          "email",
          "phone_number_e164",
          "currency",
          "price",
        ],
      },
      reference_table: {
        type: "string",
        description: "[create] Reference table name (for reference fields)",
      },
      max_length: {
        type: "number",
        description: "[create] Maximum length for string fields",
        default: 255,
      },
      mandatory: {
        type: "boolean",
        description: "[create] Whether the field is mandatory",
        default: false,
      },
      default_value: {
        type: "string",
        description: "[create] Default value for the field",
      },
      choice_options: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            value: { type: "string" },
          },
        },
        description: "[create] Choice options for choice fields",
      },

      // UPDATE parameters
      config: {
        type: "object",
        description: "[update] Fields to update (only specified fields will be changed)",
      },
      validate: {
        type: "boolean",
        description: "[update] Validate before update",
        default: true,
      },
      create_backup: {
        type: "boolean",
        description: "[update] Create backup before update",
        default: false,
      },

      // DELETE parameters
      soft_delete: {
        type: "boolean",
        description: "[delete] Mark as inactive instead of hard delete",
        default: false,
      },
      force: {
        type: "boolean",
        description: "[delete] Force deletion even with dependencies",
        default: false,
      },

      // FIND/LIST parameters
      query: {
        type: "string",
        description: "[find] Search query (natural language or encoded query)",
      },
      limit: {
        type: "number",
        description: "[find/list] Maximum results to return",
        default: 10,
      },
      fields: {
        type: "string",
        description: "[get/find/list] Comma-separated list of fields to return",
      },

      // EXPORT parameters
      format: {
        type: "string",
        enum: ["json", "xml", "files"],
        description:
          '[export] Export format. Use "files" to export to separate files per field (template.html, server.js, etc.)',
        default: "json",
      },
      export_path: {
        type: "string",
        description: '[export] Directory path to export files to (required for format="files")',
      },

      // IMPORT/CREATE parameters with file support
      file_path: {
        type: "string",
        description: "[import] Path to the artifact file",
      },
      data: {
        type: "object",
        description: "[import] Artifact data object (alternative to file_path)",
      },
      artifact_directory: {
        type: "string",
        description:
          "[create/update/verify] Directory containing artifact files. Auto-maps files like template.html→template, server.js→script, etc.",
      },
      // Generic _file suffix parameters for explicit file mapping
      template_file: {
        type: "string",
        description: "[create/update/verify] Path to HTML template file (widgets)",
      },
      server_script_file: {
        type: "string",
        description: "[create/update/verify] Path to server-side script file",
      },
      client_script_file: {
        type: "string",
        description: "[create/update/verify] Path to client-side script file",
      },
      css_file: {
        type: "string",
        description: "[create/update/verify] Path to CSS stylesheet file (widgets)",
      },
      option_schema_file: {
        type: "string",
        description: "[create/update/verify] Path to option schema JSON file (widgets)",
      },
      script_file: {
        type: "string",
        description: "[create/update/verify] Path to script file (for script includes, business rules, etc.)",
      },
      condition_file: {
        type: "string",
        description: "[create/update/verify] Path to condition script file (business rules, UI actions)",
      },

      // Scope
      application_scope: {
        type: "string",
        description: 'Application scope for the artifact. Use "global" for global scope.',
      },
      validate_es5: {
        type: "boolean",
        description: "Validate ES5 syntax for server scripts",
        default: true,
      },
    },
    required: ["action", "type"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { action, type } = args

  // Validate artifact type
  const tableName = ARTIFACT_TABLE_MAP[type]
  if (!tableName) {
    return createErrorResult(
      `Unsupported artifact type: ${type}. Valid types: ${Object.keys(ARTIFACT_TABLE_MAP).join(", ")}`,
    )
  }

  try {
    switch (action) {
      case "create":
        return await executeCreate(args, context, tableName)
      case "get":
        return await executeGet(args, context, tableName)
      case "update":
        return await executeUpdate(args, context, tableName)
      case "delete":
        return await executeDelete(args, context, tableName)
      case "find":
        return await executeFind(args, context, tableName)
      case "list":
        return await executeList(args, context, tableName)
      case "analyze":
        return await executeAnalyze(args, context, tableName)
      case "export":
        return await executeExport(args, context, tableName)
      case "import":
        return await executeImport(args, context, tableName)
      case "verify":
        return await executeVerify(args, context, tableName)
      default:
        return createErrorResult(
          `Unknown action: ${action}. Valid actions: create, get, update, delete, find, list, analyze, export, import`,
        )
    }
  } catch (error: any) {
    return createErrorResult(
      error instanceof SnowFlowError
        ? error
        : new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, `Artifact ${action} failed: ${error.message}`, {
            originalError: error,
          }),
    )
  }
}

// ==================== FILE RESOLUTION HELPER ====================
async function resolveFileContent(
  args: any,
  tableName: string,
): Promise<{
  resolvedFields: Record<string, string>
  fileSourceInfo: string[]
  error?: string
}> {
  const {
    artifact_directory,
    template_file,
    server_script_file,
    client_script_file,
    css_file,
    option_schema_file,
    script_file,
    condition_file,
    name,
  } = args

  const resolvedFields: Record<string, string> = {}
  const fileSourceInfo: string[] = []

  // Step 1: Process artifact_directory if provided (lowest priority)
  if (artifact_directory) {
    const mappings = FILE_MAPPINGS[tableName]
    if (mappings) {
      for (const [field, filenames] of Object.entries(mappings)) {
        for (const filename of filenames) {
          const resolvedFilename = filename.replace("{name}", name || "")
          const fullPath = path.join(artifact_directory, resolvedFilename)
          if (existsSync(fullPath)) {
            try {
              resolvedFields[field] = await fs.readFile(fullPath, "utf-8")
              fileSourceInfo.push(`${field} ← ${resolvedFilename}`)
            } catch (e) {
              // Skip files that can't be read
            }
            break
          }
        }
      }
    }
  }

  // Step 2: Process individual _file parameters (medium priority - override directory)
  const fileParams: Record<string, string | undefined> = {
    template: template_file,
    script: script_file,
    client_script: client_script_file,
    css: css_file,
    option_schema: option_schema_file,
    condition: condition_file,
    server_script: server_script_file,
  }

  for (const [field, filePath] of Object.entries(fileParams)) {
    if (filePath && typeof filePath === "string") {
      if (existsSync(filePath)) {
        try {
          resolvedFields[field] = await fs.readFile(filePath, "utf-8")
          fileSourceInfo.push(`${field} ← ${path.basename(filePath)} (explicit)`)
        } catch (e: any) {
          return { resolvedFields, fileSourceInfo, error: `Failed to read file '${filePath}': ${e.message}` }
        }
      } else {
        return { resolvedFields, fileSourceInfo, error: `File not found: ${filePath}` }
      }
    }
  }

  return { resolvedFields, fileSourceInfo }
}

// ==================== CREATE ====================
async function executeCreate(args: any, context: ServiceNowContext, tableName: string): Promise<ToolResult> {
  const {
    type,
    name,
    title,
    description = "",
    template,
    server_script,
    client_script,
    css,
    option_schema,
    script,
    api_name,
    table,
    when,
    insert,
    update_trigger,
    delete_trigger,
    query_trigger,
    active = true,
    validate_es5 = true,
    application_scope,
    // Table fields
    label,
    extends_table,
    is_extendable = true,
    create_module = true,
    create_access_controls = false,
    // Field fields
    column_name,
    column_label,
    internal_type,
    reference_table,
    max_length = 255,
    mandatory = false,
    default_value,
    choice_options,
    // File-based input parameters
    artifact_directory,
    template_file,
    server_script_file,
    client_script_file,
    css_file,
    option_schema_file,
    script_file,
    condition_file,
  } = args

  if (!name) {
    return createErrorResult("name is required for create action")
  }

  const client = await getAuthenticatedClient(context)

  // ==================== RESOLVE FILE-BASED CONTENT ====================
  // Priority: inline content > _file params > artifact_directory
  const fileResolution = await resolveFileContent(args, tableName)
  if (fileResolution.error) {
    return createErrorResult(fileResolution.error)
  }
  const { resolvedFields, fileSourceInfo } = fileResolution

  // Note: Inline content has highest priority (will override in artifact building below)

  // ES5 validation warnings
  const warnings: string[] = []
  if (validate_es5) {
    if (server_script) {
      const validation = validateES5Syntax(server_script)
      if (!validation.valid) {
        warnings.push(
          `Server script contains ES6+ syntax (${validation.violations.map((v: any) => v.type).join(", ")}). Consider using ES5 for compatibility.`,
        )
      }
    }
    if (script) {
      const validation = validateES5Syntax(script)
      if (!validation.valid) {
        warnings.push(
          `Script contains ES6+ syntax (${validation.violations.map((v: any) => v.type).join(", ")}). Consider using ES5 for compatibility.`,
        )
      }
    }
  }

  // Resolve application scope
  var resolvedScopeId: string | null = null
  var resolvedScopeName = "Current Scope"

  if (application_scope) {
    if (application_scope === "global") {
      resolvedScopeId = "global"
      resolvedScopeName = "Global"
    } else {
      var appResponse = await client.get("/api/now/table/sys_app", {
        params: {
          sysparm_query: `sys_id=${application_scope}^ORscope=${application_scope}^ORname=${application_scope}`,
          sysparm_fields: "sys_id,name,scope",
          sysparm_limit: 1,
        },
      })

      if (appResponse.data.result && appResponse.data.result.length > 0) {
        var app = appResponse.data.result[0]
        resolvedScopeId = app.sys_id
        resolvedScopeName = app.name
      } else {
        return createErrorResult(`Application not found: "${application_scope}"`)
      }
    }
  }

  var artifactData: any = {}
  var result: any

  // Build artifact data based on type
  // Note: inline content has highest priority, then _file params, then artifact_directory
  // resolvedFields already contains file-based content with proper priority
  switch (type) {
    case "sp_widget":
    case "widget":
      artifactData = {
        id: sanitizeString(name),
        name: sanitizeString(title || name),
        description: sanitizeString(description),
        // Inline content overrides resolved fields
        template: sanitizeString(template || resolvedFields.template || ""),
        script: sanitizeString(server_script || resolvedFields.script || resolvedFields.server_script || ""),
        client_script: sanitizeString(client_script || resolvedFields.client_script || ""),
        css: sanitizeString(css || resolvedFields.css || ""),
        option_schema: sanitizeString(option_schema || resolvedFields.option_schema || ""),
        data_table: true,
      }
      break

    case "sp_page":
    case "page":
      artifactData = {
        id: sanitizeString(name),
        title: sanitizeString(title || name),
        description: sanitizeString(description),
      }
      break

    case "sys_ux_page":
    case "uib_page":
      artifactData = {
        name: sanitizeString(name),
        title: sanitizeString(title || name),
        description: sanitizeString(description),
      }
      break

    case "script_include":
      artifactData = {
        name: sanitizeString(name),
        api_name: sanitizeString(api_name || name),
        script: sanitizeString(script || resolvedFields.script || ""),
        description: sanitizeString(description),
        active: active,
      }
      break

    case "business_rule":
      if (!table) {
        return createErrorResult("table parameter required for business rules")
      }
      artifactData = {
        name: sanitizeString(name),
        collection: table,
        script: sanitizeString(script || resolvedFields.script || ""),
        description: sanitizeString(description),
        when: when || "before",
        insert: insert || false,
        update: update_trigger || false,
        delete: delete_trigger || false,
        query: query_trigger || false,
        active: active,
      }
      // Add condition if available
      if (resolvedFields.condition) {
        artifactData.condition = sanitizeString(resolvedFields.condition)
      }
      break

    case "client_script":
      if (!table) {
        return createErrorResult("table parameter required for client scripts")
      }
      artifactData = {
        name: sanitizeString(name),
        table: table,
        script: sanitizeString(script || resolvedFields.script || ""),
        description: sanitizeString(description),
        active: active,
      }
      break

    case "ui_policy":
      if (!table) {
        return createErrorResult("table parameter required for UI policies")
      }
      artifactData = {
        short_description: sanitizeString(name),
        table: table,
        script_true: sanitizeString(script || resolvedFields.script || ""),
        description: sanitizeString(description),
        active: active,
        on_load: true,
        reverse_if_false: false,
      }
      break

    case "ui_action":
      if (!table) {
        return createErrorResult("table parameter required for UI actions")
      }
      artifactData = {
        name: sanitizeString(name),
        table: table,
        script: sanitizeString(script || resolvedFields.script || ""),
        comments: sanitizeString(description),
        active: active,
        form_action: true,
      }
      // Add condition if available
      if (resolvedFields.condition) {
        artifactData.condition = sanitizeString(resolvedFields.condition)
      }
      break

    case "rest_message":
      artifactData = {
        name: sanitizeString(name),
        description: sanitizeString(description),
        rest_endpoint: "",
        authentication_type: "no_authentication",
      }
      break

    case "scheduled_job":
      artifactData = {
        name: sanitizeString(name),
        script: sanitizeString(script || resolvedFields.script || ""),
        comments: sanitizeString(description),
        active: active,
      }
      break

    case "transform_map":
      artifactData = {
        name: sanitizeString(name),
        description: sanitizeString(description),
        active: active,
      }
      break

    case "fix_script":
      artifactData = {
        name: sanitizeString(name),
        script: sanitizeString(script || resolvedFields.script || ""),
        description: sanitizeString(description),
      }
      break

    case "table":
      if (!label) {
        return createErrorResult("label parameter required for table creation")
      }
      // Validate table naming
      if (name.startsWith("x_") && (!resolvedScopeId || resolvedScopeId === "global")) {
        return createErrorResult(
          `Table name "${name}" uses 'x_' prefix which requires a scoped application. ` +
            `Use 'u_' prefix for global tables or specify application_scope.`,
        )
      }
      artifactData = {
        name: sanitizeString(name),
        label: sanitizeString(label),
        is_extendable: is_extendable,
      }
      if (extends_table) {
        var parentResponse = await client.get("/api/now/table/sys_db_object", {
          params: {
            sysparm_query: `name=${extends_table}`,
            sysparm_fields: "sys_id",
            sysparm_limit: 1,
          },
        })
        if (parentResponse.data.result && parentResponse.data.result.length > 0) {
          artifactData.super_class = parentResponse.data.result[0].sys_id
        } else {
          return createErrorResult(`Parent table '${extends_table}' not found`)
        }
      }
      break

    case "field":
      if (!table) {
        return createErrorResult("table parameter required for field creation")
      }
      if (!internal_type) {
        return createErrorResult("internal_type parameter required for field creation")
      }
      artifactData = {
        name: table,
        element: sanitizeString(column_name || name),
        column_label: sanitizeString(column_label || label || name),
        internal_type: internal_type,
        mandatory: mandatory,
      }
      if (internal_type === "reference" && reference_table) {
        artifactData.reference = reference_table
      }
      if (["string", "url", "email"].includes(internal_type)) {
        artifactData.max_length = max_length
      }
      if (default_value !== undefined) {
        artifactData.default_value = default_value
      }
      break

    default:
      artifactData = {
        name: sanitizeString(name),
        description: sanitizeString(description),
      }
  }

  // Add scope if specified
  if (resolvedScopeId && resolvedScopeId !== "global") {
    artifactData.sys_scope = resolvedScopeId
  }

  // Check if artifact already exists
  var identifierField = ARTIFACT_IDENTIFIER_FIELD[tableName] || "name"
  var identifierValue = artifactData[identifierField] || artifactData.name || artifactData.id

  var existingResponse = await client.get(`/api/now/table/${tableName}`, {
    params: {
      sysparm_query: `${identifierField}=${identifierValue}`,
      sysparm_limit: 1,
    },
  })

  if (existingResponse.data.result && existingResponse.data.result.length > 0) {
    return createErrorResult(`${type} '${identifierValue}' already exists. Use action='update' to modify it.`)
  }

  // Create the artifact
  var createResponse = await client.post(`/api/now/table/${tableName}`, artifactData)
  result = createResponse.data.result

  // Handle table-specific post-creation tasks
  if (type === "table" && result) {
    var additionalInfo: any = {}

    // Create navigation module
    if (create_module) {
      try {
        var moduleData = {
          title: label,
          name: name,
          table_name: name,
          order: 100,
          active: true,
        }
        var moduleResponse = await client.post("/api/now/table/sys_app_module", moduleData)
        additionalInfo.module = { sys_id: moduleResponse.data.result.sys_id }
      } catch (moduleError: any) {
        additionalInfo.module_error = moduleError.message
      }
    }

    // Create ACLs
    if (create_access_controls) {
      try {
        var acls = []
        for (var operation of ["read", "write", "create", "delete"]) {
          var aclResponse = await client.post("/api/now/table/sys_security_acl", {
            name: name,
            operation: operation,
            type: "record",
            admin_overrides: true,
            active: true,
          })
          acls.push({ type: operation, sys_id: aclResponse.data.result.sys_id })
        }
        additionalInfo.access_controls = acls
      } catch (aclError: any) {
        additionalInfo.acl_error = aclError.message
      }
    }

    result = { ...result, ...additionalInfo }
  }

  // Handle field choice options
  if (type === "field" && internal_type === "choice" && choice_options && choice_options.length > 0) {
    var choices: any[] = []
    for (var i = 0; i < choice_options.length; i++) {
      var option = choice_options[i]
      try {
        var choiceData = {
          name: table,
          element: column_name || name,
          label: option.label,
          value: option.value,
          sequence: (i + 1) * 10,
          inactive: false,
        }
        var choiceResponse = await client.post("/api/now/table/sys_choice", choiceData)
        choices.push({ sys_id: choiceResponse.data.result.sys_id, label: option.label, value: option.value })
      } catch (choiceError: any) {
        choices.push({ error: `Failed to create choice '${option.label}': ${choiceError.message}` })
      }
    }
    result.choices = choices
  }

  var successData: any = {
    action: "create",
    created: true,
    sys_id: result.sys_id,
    name: result.name || result.id || name,
    type: type,
    table: tableName,
    artifact: result,
    url: `${context.instanceUrl}/nav_to.do?uri=${tableName}.do?sys_id=${result.sys_id}`,
  }

  if (resolvedScopeId) {
    successData.application_scope = { sys_id: resolvedScopeId, name: resolvedScopeName }
  }

  if (warnings.length > 0) {
    successData.warnings = warnings
  }

  // Add file source info if files were used
  if (fileSourceInfo.length > 0) {
    successData.file_sources = fileSourceInfo
    successData.artifact_directory = artifact_directory
  }

  return createSuccessResult(successData)
}

// ==================== GET ====================
async function executeGet(args: any, context: ServiceNowContext, tableName: string): Promise<ToolResult> {
  const { type, sys_id, identifier, fields } = args

  if (!sys_id && !identifier) {
    return createErrorResult("sys_id or identifier is required for get action")
  }

  const client = await getAuthenticatedClient(context)
  var artifact: any = null

  // Try by sys_id first
  if (sys_id) {
    try {
      var response = await client.get(`/api/now/table/${tableName}/${sys_id}`, {
        params: fields ? { sysparm_fields: fields } : {},
      })
      artifact = response.data.result
    } catch (e) {
      // sys_id not found, continue to identifier search
    }
  }

  // Try by identifier
  if (!artifact && identifier) {
    var identifierField = ARTIFACT_IDENTIFIER_FIELD[tableName] || "name"

    // For widgets, also try 'id' field
    var queryParts = [`${identifierField}=${identifier}`]
    if (tableName === "sp_widget") {
      queryParts.push(`id=${identifier}`)
    }
    queryParts.push(`name=${identifier}`)

    var searchResponse = await client.get(`/api/now/table/${tableName}`, {
      params: {
        sysparm_query: queryParts.join("^OR"),
        sysparm_limit: 1,
        ...(fields ? { sysparm_fields: fields } : {}),
      },
    })

    if (searchResponse.data.result && searchResponse.data.result.length > 0) {
      artifact = searchResponse.data.result[0]
    }
  }

  if (!artifact) {
    return createErrorResult(`${type} not found: ${sys_id || identifier}`)
  }

  return createSuccessResult({
    action: "get",
    found: true,
    sys_id: artifact.sys_id,
    name: artifact.name || artifact.id || artifact.title,
    type: type,
    table: tableName,
    artifact: artifact,
    url: `${context.instanceUrl}/nav_to.do?uri=${tableName}.do?sys_id=${artifact.sys_id}`,
  })
}

// ==================== UPDATE ====================
async function executeUpdate(args: any, context: ServiceNowContext, tableName: string): Promise<ToolResult> {
  const { type, sys_id, identifier, config = {}, validate = true, create_backup = false, validate_es5 = true } = args

  if (!sys_id && !identifier) {
    return createErrorResult("sys_id or identifier is required for update action")
  }

  // Resolve file-based content (supports script_file, template_file, artifact_directory, etc.)
  const fileResolution = await resolveFileContent(args, tableName)
  if (fileResolution.error) {
    return createErrorResult(fileResolution.error)
  }

  // Extract inline params from args (same fields supported by create)
  const inlineParams: Record<string, any> = {}
  const inlineFieldKeys = [
    "script",
    "template",
    "server_script",
    "client_script",
    "css",
    "option_schema",
    "description",
    "active",
  ]
  for (const key of inlineFieldKeys) {
    if (args[key] !== undefined) {
      inlineParams[key] = args[key]
    }
  }

  // Merge priority: config (highest) > inline params > _file params > artifact_directory (lowest)
  const mergedConfig = { ...fileResolution.resolvedFields, ...inlineParams, ...config }

  if (Object.keys(mergedConfig).length === 0) {
    return createErrorResult(
      "No update content provided. Use config object and/or file parameters (script_file, template_file, artifact_directory, etc.)",
    )
  }

  const client = await getAuthenticatedClient(context)

  // Find the artifact
  var artifact = await findArtifactByIdOrIdentifier(client, tableName, sys_id, identifier)
  if (!artifact) {
    return createErrorResult(`${type} '${sys_id || identifier}' not found`)
  }

  var targetSysId = artifact.sys_id
  var warnings: string[] = []

  // ES5 validation
  if (validate_es5) {
    if (mergedConfig.script) {
      var validation = validateES5Syntax(mergedConfig.script)
      if (!validation.valid) {
        warnings.push(`Script contains ES6+ syntax. Consider using ES5 for compatibility.`)
      }
    }
    if (mergedConfig.server_script) {
      var validation2 = validateES5Syntax(mergedConfig.server_script)
      if (!validation2.valid) {
        warnings.push(`Server script contains ES6+ syntax. Consider using ES5 for compatibility.`)
      }
    }
  }

  // Widget-specific validation
  if (validate && tableName === "sp_widget") {
    if (mergedConfig.template !== undefined && !mergedConfig.template.trim()) {
      return createErrorResult("Widget template cannot be empty")
    }
  }

  // Create backup if requested
  var backupId = null
  if (create_backup) {
    try {
      var backupData = {
        table: tableName,
        record_sys_id: targetSysId,
        backup_data: JSON.stringify(artifact),
        created: new Date().toISOString(),
      }
      var backupResponse = await client.post("/api/now/table/sys_update_xml_backup", backupData)
      backupId = backupResponse.data.result.sys_id
    } catch (backupError: any) {
      warnings.push(`Backup creation failed: ${backupError.message}`)
    }
  }

  // Sanitize string fields
  var sanitizedConfig: any = {}
  for (var key of Object.keys(mergedConfig)) {
    if (typeof mergedConfig[key] === "string") {
      sanitizedConfig[key] = sanitizeString(mergedConfig[key])
    } else {
      sanitizedConfig[key] = mergedConfig[key]
    }
  }

  // Perform the update
  var updateResponse = await client.patch(`/api/now/table/${tableName}/${targetSysId}`, sanitizedConfig)
  var updatedArtifact = updateResponse.data.result

  var result: any = {
    action: "update",
    updated: true,
    sys_id: targetSysId,
    name: updatedArtifact.name || updatedArtifact.id || identifier,
    type: type,
    table: tableName,
    updated_fields: Object.keys(mergedConfig),
    backup_id: backupId,
    artifact: updatedArtifact,
    url: `${context.instanceUrl}/nav_to.do?uri=${tableName}.do?sys_id=${targetSysId}`,
  }

  if (fileResolution.fileSourceInfo.length > 0) {
    result.file_sources = fileResolution.fileSourceInfo
  }

  if (warnings.length > 0) {
    result.warnings = warnings
  }

  return createSuccessResult(result)
}

// ==================== DELETE ====================
async function executeDelete(args: any, context: ServiceNowContext, tableName: string): Promise<ToolResult> {
  const { type, sys_id, identifier, soft_delete = false, force = false } = args

  if (!sys_id && !identifier) {
    return createErrorResult("sys_id or identifier is required for delete action")
  }

  const client = await getAuthenticatedClient(context)

  // Find the artifact
  var artifact = await findArtifactByIdOrIdentifier(client, tableName, sys_id, identifier)
  if (!artifact) {
    return createErrorResult(`${type} '${sys_id || identifier}' not found`)
  }

  var targetSysId = artifact.sys_id

  // Check for dependencies if not forcing
  var dependencies: any[] = []
  if (!force) {
    var refFieldsResponse = await client.get("/api/now/table/sys_dictionary", {
      params: {
        sysparm_query: `reference=${tableName}^internal_type=reference`,
        sysparm_fields: "name,element",
        sysparm_limit: 100,
      },
    })

    for (var refField of refFieldsResponse.data.result || []) {
      try {
        var dependentRecords = await client.get(`/api/now/table/${refField.name}`, {
          params: {
            sysparm_query: `${refField.element}=${targetSysId}`,
            sysparm_fields: "sys_id",
            sysparm_limit: 5,
          },
        })

        if (dependentRecords.data.result && dependentRecords.data.result.length > 0) {
          dependencies.push({
            table: refField.name,
            field: refField.element,
            count: dependentRecords.data.result.length,
          })
        }
      } catch (e) {
        // Ignore errors checking dependencies
      }
    }

    if (dependencies.length > 0) {
      return createErrorResult(`Cannot delete ${type} with dependencies. Use force=true to override.`, {
        details: { dependencies },
      })
    }
  }

  // Perform deletion
  if (soft_delete) {
    // Check if table has active field
    var hasActiveField = await client.get("/api/now/table/sys_dictionary", {
      params: {
        sysparm_query: `name=${tableName}^element=active`,
        sysparm_fields: "element",
        sysparm_limit: 1,
      },
    })

    if (hasActiveField.data.result && hasActiveField.data.result.length > 0) {
      await client.patch(`/api/now/table/${tableName}/${targetSysId}`, { active: "false" })

      return createSuccessResult({
        action: "delete",
        deleted: true,
        soft_delete: true,
        sys_id: targetSysId,
        name: artifact.name || artifact.id,
        type: type,
        table: tableName,
        message: "Artifact marked as inactive (soft delete)",
      })
    } else {
      return createErrorResult(`Table '${tableName}' does not support soft delete (no 'active' field)`)
    }
  } else {
    // Hard delete
    await client.delete(`/api/now/table/${tableName}/${targetSysId}`)

    return createSuccessResult({
      action: "delete",
      deleted: true,
      soft_delete: false,
      sys_id: targetSysId,
      name: artifact.name || artifact.id,
      type: type,
      table: tableName,
      message: "Artifact permanently deleted",
      forced: force && dependencies.length > 0,
    })
  }
}

// ==================== FIND ====================
async function executeFind(args: any, context: ServiceNowContext, tableName: string): Promise<ToolResult> {
  const { type, query, table, limit = 10, fields } = args

  if (!query) {
    return createErrorResult("query is required for find action")
  }

  const client = await getAuthenticatedClient(context)

  // Build query
  var searchQuery = `nameLIKE${query}^ORshort_descriptionLIKE${query}`
  if (tableName === "sp_widget") {
    searchQuery = `nameLIKE${query}^ORidLIKE${query}`
  }
  if (table && (type === "business_rule" || type === "client_script" || type === "ui_policy")) {
    searchQuery += `^collection=${table}`
  }

  var response = await client.get(`/api/now/table/${tableName}`, {
    params: {
      sysparm_query: searchQuery,
      sysparm_limit: limit,
      ...(fields ? { sysparm_fields: fields } : { sysparm_fields: "sys_id,name,id,title,short_description,active" }),
    },
  })

  var results = response.data.result || []

  return createSuccessResult({
    action: "find",
    found: results.length > 0,
    count: results.length,
    type: type,
    table: tableName,
    query: query,
    results: results.map((r: any) => ({
      sys_id: r.sys_id,
      name: r.name || r.id || r.title,
      description: r.short_description || r.description,
      active: r.active,
      url: `${context.instanceUrl}/nav_to.do?uri=${tableName}.do?sys_id=${r.sys_id}`,
    })),
  })
}

// ==================== LIST ====================
async function executeList(args: any, context: ServiceNowContext, tableName: string): Promise<ToolResult> {
  const { type, limit = 20, fields } = args

  const client = await getAuthenticatedClient(context)

  var response = await client.get(`/api/now/table/${tableName}`, {
    params: {
      sysparm_limit: limit,
      sysparm_orderby: "sys_updated_on",
      sysparm_order: "desc",
      ...(fields
        ? { sysparm_fields: fields }
        : { sysparm_fields: "sys_id,name,id,title,short_description,active,sys_updated_on" }),
    },
  })

  var results = response.data.result || []

  return createSuccessResult({
    action: "list",
    count: results.length,
    type: type,
    table: tableName,
    artifacts: results.map((r: any) => ({
      sys_id: r.sys_id,
      name: r.name || r.id || r.title,
      description: r.short_description || r.description,
      active: r.active,
      updated_at: r.sys_updated_on,
      url: `${context.instanceUrl}/nav_to.do?uri=${tableName}.do?sys_id=${r.sys_id}`,
    })),
  })
}

// ==================== ANALYZE ====================
async function executeAnalyze(args: any, context: ServiceNowContext, tableName: string): Promise<ToolResult> {
  const { type, sys_id, identifier } = args

  if (!sys_id && !identifier) {
    return createErrorResult("sys_id or identifier is required for analyze action")
  }

  const client = await getAuthenticatedClient(context)

  // Find the artifact
  var artifact = await findArtifactByIdOrIdentifier(client, tableName, sys_id, identifier)
  if (!artifact) {
    return createErrorResult(`${type} '${sys_id || identifier}' not found`)
  }

  // Analyze structure
  var analysis: any = {
    meta: {
      sys_id: artifact.sys_id,
      name: artifact.name || artifact.id || artifact.title,
      type: type,
      table: tableName,
      active: artifact.active,
      last_updated: artifact.sys_updated_on,
    },
    structure: {
      fields: Object.keys(artifact).filter((k) => !k.startsWith("sys_")),
      hasScript: !!(artifact.script || artifact.server_script),
      hasClientScript: !!artifact.client_script,
      hasTemplate: !!artifact.template,
      hasCSS: !!artifact.css,
    },
    dependencies: [],
    modificationPoints: [],
  }

  // Detect dependencies in scripts
  var scriptContent = artifact.script || artifact.server_script || ""
  if (scriptContent) {
    // GlideRecord references
    var tableMatches = scriptContent.match(/new GlideRecord\(['"]([^'"]+)['"]\)/g)
    if (tableMatches) {
      var tables = [
        ...new Set(
          tableMatches
            .map((m: string) => {
              var match = m.match(/['"]([^'"]+)['"]/)
              return match ? match[1] : null
            })
            .filter(Boolean),
        ),
      ]
      analysis.dependencies.push({ type: "table", references: tables })
    }

    // Script Include references
    var scriptIncludeMatches = scriptContent.match(/new ([A-Z][a-zA-Z0-9_]+)\(/g)
    if (scriptIncludeMatches) {
      var scriptIncludes = [
        ...new Set(
          scriptIncludeMatches
            .map((m: string) => {
              var match = m.match(/new ([A-Z][a-zA-Z0-9_]+)/)
              return match ? match[1] : null
            })
            .filter(Boolean),
        ),
      ]
      analysis.dependencies.push({ type: "script_include", references: scriptIncludes })
    }
  }

  // Identify modification points
  if (tableName === "sp_widget") {
    analysis.modificationPoints = [
      { field: "template", description: "HTML template structure" },
      { field: "script", description: "Server-side data processing" },
      { field: "client_script", description: "Client-side behavior" },
      { field: "css", description: "Widget styling" },
    ]
  }

  return createSuccessResult({
    action: "analyze",
    analyzed: true,
    sys_id: artifact.sys_id,
    name: artifact.name || artifact.id,
    type: type,
    table: tableName,
    analysis: analysis,
  })
}

// ==================== EXPORT ====================
async function executeExport(args: any, context: ServiceNowContext, tableName: string): Promise<ToolResult> {
  const { type, sys_id, identifier, format = "json", export_path } = args

  if (!sys_id && !identifier) {
    return createErrorResult("sys_id or identifier is required for export action")
  }

  // Validate export_path is provided for 'files' format
  if (format === "files" && !export_path) {
    return createErrorResult('export_path is required when using format="files"')
  }

  const client = await getAuthenticatedClient(context)

  // Find the artifact
  var artifact = await findArtifactByIdOrIdentifier(client, tableName, sys_id, identifier)
  if (!artifact) {
    return createErrorResult(`${type} '${sys_id || identifier}' not found`)
  }

  var exportedData: any

  if (format === "files") {
    // Export to separate files per field
    const exportedFiles: string[] = []

    try {
      // Create export directory
      await fs.mkdir(export_path, { recursive: true })

      // Get field mappings for this artifact type
      const fieldMappings = EXPORT_FILE_MAPPINGS[tableName]

      if (fieldMappings) {
        for (const [field, filename] of Object.entries(fieldMappings)) {
          if (artifact[field] && artifact[field].trim()) {
            const filePath = path.join(export_path, filename)
            await fs.writeFile(filePath, artifact[field], "utf-8")
            exportedFiles.push(filename)
          }
        }
      }

      // Always write metadata.json with non-script fields
      const metadata: any = {
        sys_id: artifact.sys_id,
        name: artifact.name || artifact.id,
        type: type,
        table: tableName,
        exported_at: new Date().toISOString(),
      }

      // Add non-script metadata fields
      const skipFields = new Set([
        "template",
        "script",
        "client_script",
        "css",
        "option_schema",
        "condition",
        "script_true",
      ])
      for (const [key, value] of Object.entries(artifact)) {
        if (!key.startsWith("sys_") && !skipFields.has(key) && value !== null && value !== undefined) {
          metadata[key] = value
        }
      }

      const metadataPath = path.join(export_path, "metadata.json")
      await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf-8")
      exportedFiles.push("metadata.json")

      return createSuccessResult({
        action: "export",
        exported: true,
        sys_id: artifact.sys_id,
        name: artifact.name || artifact.id,
        type: type,
        table: tableName,
        format: format,
        export_path: export_path,
        files: exportedFiles,
      })
    } catch (e: any) {
      return createErrorResult(`Failed to export files: ${e.message}`)
    }
  } else if (format === "json") {
    exportedData = {
      type: type,
      table: tableName,
      sys_id: artifact.sys_id,
      name: artifact.name || artifact.id,
      exported_at: new Date().toISOString(),
      data: artifact,
    }

    // Write to file if export_path is provided
    if (export_path) {
      try {
        const jsonPath = export_path.endsWith(".json") ? export_path : export_path + ".json"
        await fs.writeFile(jsonPath, JSON.stringify(exportedData, null, 2), "utf-8")
        return createSuccessResult({
          action: "export",
          exported: true,
          sys_id: artifact.sys_id,
          name: artifact.name || artifact.id,
          type: type,
          table: tableName,
          format: format,
          export_path: jsonPath,
          data: exportedData,
        })
      } catch (e: any) {
        return createErrorResult(`Failed to write JSON file: ${e.message}`)
      }
    }
  } else if (format === "xml") {
    var xmlParts = ['<?xml version="1.0" encoding="UTF-8"?>']
    xmlParts.push(`<${type}>`)
    for (var key of Object.keys(artifact)) {
      if (artifact[key] !== null && artifact[key] !== undefined) {
        var escaped = String(artifact[key]).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        xmlParts.push(`  <${key}>${escaped}</${key}>`)
      }
    }
    xmlParts.push(`</${type}>`)
    exportedData = xmlParts.join("\n")

    // Write to file if export_path is provided
    if (export_path) {
      try {
        const xmlPath = export_path.endsWith(".xml") ? export_path : export_path + ".xml"
        await fs.writeFile(xmlPath, exportedData, "utf-8")
        return createSuccessResult({
          action: "export",
          exported: true,
          sys_id: artifact.sys_id,
          name: artifact.name || artifact.id,
          type: type,
          table: tableName,
          format: format,
          export_path: xmlPath,
          data: exportedData,
        })
      } catch (e: any) {
        return createErrorResult(`Failed to write XML file: ${e.message}`)
      }
    }
  } else {
    return createErrorResult(`Unsupported format: ${format}. Valid formats: json, xml, files`)
  }

  return createSuccessResult({
    action: "export",
    exported: true,
    sys_id: artifact.sys_id,
    name: artifact.name || artifact.id,
    type: type,
    table: tableName,
    format: format,
    data: exportedData,
  })
}

// ==================== IMPORT ====================
async function executeImport(args: any, context: ServiceNowContext, tableName: string): Promise<ToolResult> {
  const { type, file_path, data, format = "json" } = args

  if (!file_path && !data) {
    return createErrorResult("file_path or data is required for import action")
  }

  const client = await getAuthenticatedClient(context)

  var artifactData: any

  if (file_path) {
    var fileContent = await fs.readFile(file_path, "utf-8")
    if (format === "json") {
      artifactData = JSON.parse(fileContent)
      if (artifactData.data) {
        artifactData = artifactData.data
      }
    } else if (format === "xml") {
      // Simple XML parsing
      var result: any = {}
      var tagRegex = /<(\w+)>([^<]*)<\/\1>/g
      var match
      while ((match = tagRegex.exec(fileContent)) !== null) {
        result[match[1]] = match[2].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
      }
      artifactData = result
    } else {
      return createErrorResult(`Unsupported format: ${format}`)
    }
  } else {
    artifactData = data
  }

  // Remove system fields
  var cleanedData = { ...artifactData }
  delete cleanedData.sys_id
  delete cleanedData.sys_created_on
  delete cleanedData.sys_created_by
  delete cleanedData.sys_updated_on
  delete cleanedData.sys_updated_by
  delete cleanedData.sys_mod_count

  // Check if artifact exists
  var identifierField = ARTIFACT_IDENTIFIER_FIELD[tableName] || "name"
  var identifierValue = cleanedData[identifierField] || cleanedData.name || cleanedData.id

  var existingResponse = await client.get(`/api/now/table/${tableName}`, {
    params: {
      sysparm_query: `${identifierField}=${identifierValue}`,
      sysparm_limit: 1,
    },
  })

  var importResult: any
  if (existingResponse.data.result && existingResponse.data.result.length > 0) {
    // Update existing
    var existingSysId = existingResponse.data.result[0].sys_id
    var updateResponse = await client.put(`/api/now/table/${tableName}/${existingSysId}`, cleanedData)
    importResult = {
      sys_id: existingSysId,
      action: "updated",
      artifact: updateResponse.data.result,
    }
  } else {
    // Create new
    var createResponse = await client.post(`/api/now/table/${tableName}`, cleanedData)
    importResult = {
      sys_id: createResponse.data.result.sys_id,
      action: "created",
      artifact: createResponse.data.result,
    }
  }

  return createSuccessResult({
    action: "import",
    imported: true,
    import_action: importResult.action,
    sys_id: importResult.sys_id,
    name: cleanedData.name || cleanedData.id,
    type: type,
    table: tableName,
    url: `${context.instanceUrl}/nav_to.do?uri=${tableName}.do?sys_id=${importResult.sys_id}`,
  })
}

// ==================== VERIFY ====================
async function executeVerify(args: any, context: ServiceNowContext, tableName: string): Promise<ToolResult> {
  const { type, sys_id, identifier } = args

  if (!sys_id && !identifier) {
    return createErrorResult("sys_id or identifier is required for verify action")
  }

  // Resolve local file content
  const fileResolution = await resolveFileContent(args, tableName)
  if (fileResolution.error) {
    return createErrorResult(fileResolution.error)
  }

  if (Object.keys(fileResolution.resolvedFields).length === 0) {
    return createErrorResult(
      "No local files to verify against. Provide file parameters (script_file, template_file, etc.) or artifact_directory.",
    )
  }

  const client = await getAuthenticatedClient(context)

  // Get the deployed artifact (full content)
  var artifact = await findArtifactByIdOrIdentifier(client, tableName, sys_id, identifier)
  if (!artifact) {
    return createErrorResult(`${type} '${sys_id || identifier}' not found`)
  }

  // Compare each resolved field with deployed content
  const comparisons: any[] = []
  let allMatch = true

  for (const [field, localContent] of Object.entries(fileResolution.resolvedFields)) {
    const deployedContent = artifact[field] || ""
    const normalizedLocal = (localContent as string).replace(/\r\n/g, "\n").trim()
    const normalizedDeployed = deployedContent.replace(/\r\n/g, "\n").trim()

    const matches = normalizedLocal === normalizedDeployed
    if (!matches) allMatch = false

    const comparison: any = {
      field,
      matches,
      local: {
        lines: normalizedLocal.split("\n").length,
        characters: normalizedLocal.length,
      },
      deployed: {
        lines: normalizedDeployed.split("\n").length,
        characters: normalizedDeployed.length,
      },
    }

    if (!matches) {
      comparison.difference = {
        line_diff: normalizedLocal.split("\n").length - normalizedDeployed.split("\n").length,
        char_diff: normalizedLocal.length - normalizedDeployed.length,
      }

      // Show first differing line for debugging
      const localLines = normalizedLocal.split("\n")
      const deployedLines = normalizedDeployed.split("\n")
      for (let i = 0; i < Math.max(localLines.length, deployedLines.length); i++) {
        if (localLines[i] !== deployedLines[i]) {
          comparison.first_diff_line = i + 1
          comparison.first_diff_local = (localLines[i] || "(missing)").substring(0, 200)
          comparison.first_diff_deployed = (deployedLines[i] || "(missing)").substring(0, 200)
          break
        }
      }
    }

    comparisons.push(comparison)
  }

  return createSuccessResult({
    action: "verify",
    verified: allMatch,
    sys_id: artifact.sys_id,
    name: artifact.name || artifact.id || identifier,
    type: type,
    table: tableName,
    comparisons: comparisons,
    file_sources: fileResolution.fileSourceInfo,
    url: `${context.instanceUrl}/nav_to.do?uri=${tableName}.do?sys_id=${artifact.sys_id}`,
  })
}

// ==================== HELPER FUNCTIONS ====================

async function findArtifactByIdOrIdentifier(
  client: any,
  tableName: string,
  sysId?: string,
  identifier?: string,
): Promise<any> {
  // Try by sys_id first
  if (sysId) {
    try {
      var response = await client.get(`/api/now/table/${tableName}/${sysId}`)
      if (response.data.result) {
        return response.data.result
      }
    } catch (e) {
      // Not found, continue
    }
  }

  // Try by identifier
  if (identifier) {
    var identifierField = ARTIFACT_IDENTIFIER_FIELD[tableName] || "name"
    var queryParts = [`${identifierField}=${identifier}`]

    if (tableName === "sp_widget") {
      queryParts.push(`id=${identifier}`)
    }
    queryParts.push(`name=${identifier}`)

    var searchResponse = await client.get(`/api/now/table/${tableName}`, {
      params: {
        sysparm_query: queryParts.join("^OR"),
        sysparm_limit: 1,
      },
    })

    if (searchResponse.data.result && searchResponse.data.result.length > 0) {
      return searchResponse.data.result[0]
    }
  }

  return null
}

function sanitizeString(str: string | undefined | null): string {
  if (!str) return ""
  return str
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F]/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
}

function validateES5Syntax(code: string): { valid: boolean; violations: any[] } {
  var violations: any[] = []

  // Check for const/let
  var constLetPattern = /\b(const|let)\s+/g
  var match
  while ((match = constLetPattern.exec(code)) !== null) {
    violations.push({
      type: match[1],
      line: code.substring(0, match.index).split("\n").length,
      fix: `Use 'var' instead of '${match[1]}'`,
    })
  }

  // Check for arrow functions
  var arrowPattern = /\([^)]*\)\s*=>/g
  while ((match = arrowPattern.exec(code)) !== null) {
    violations.push({
      type: "arrow_function",
      line: code.substring(0, match.index).split("\n").length,
      fix: "Use function() {} instead of arrow function",
    })
  }

  // Check for template literals
  var templatePattern = /`[^`]*`/g
  while ((match = templatePattern.exec(code)) !== null) {
    violations.push({
      type: "template_literal",
      line: code.substring(0, match.index).split("\n").length,
      fix: "Use string concatenation instead of template literals",
    })
  }

  return {
    valid: violations.length === 0,
    violations: violations,
  }
}

export const version = "1.0.0"
export const author = "Serac v8.3.0 Tool Consolidation"
