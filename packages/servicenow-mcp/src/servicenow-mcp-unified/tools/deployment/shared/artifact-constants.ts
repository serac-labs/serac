/**
 * Shared Artifact Constants
 *
 * Centralized mappings for ServiceNow artifact types, identifier fields,
 * and file-to-field mappings used by snow_artifact_manage, snow_github_deploy,
 * and other deployment tools.
 */

// ==================== ARTIFACT TYPE → TABLE MAPPING ====================
export const ARTIFACT_TABLE_MAP: Record<string, string> = {
  sp_widget: "sp_widget",
  widget: "sp_widget",
  sp_page: "sp_page",
  page: "sp_page",
  sys_ux_page: "sys_ux_page",
  uib_page: "sys_ux_page",
  script_include: "sys_script_include",
  business_rule: "sys_script",
  client_script: "sys_script_client",
  ui_policy: "sys_ui_policy",
  ui_action: "sys_ui_action",
  rest_message: "sys_rest_message",
  scheduled_job: "sysauto_script",
  transform_map: "sys_transform_map",
  fix_script: "sys_script_fix",
  table: "sys_db_object",
  field: "sys_dictionary",
  flow: "sys_hub_flow",
  application: "sys_app",
}

// ==================== TABLE → IDENTIFIER FIELD MAPPING ====================
export const ARTIFACT_IDENTIFIER_FIELD: Record<string, string> = {
  sp_widget: "id",
  sp_page: "id",
  sys_ux_page: "name",
  sys_script_include: "name",
  sys_script: "name",
  sys_script_client: "name",
  sys_ui_policy: "short_description",
  sys_ui_action: "name",
  sys_rest_message: "name",
  sysauto_script: "name",
  sys_transform_map: "name",
  sys_script_fix: "name",
  sys_db_object: "name",
  sys_dictionary: "element",
  sys_hub_flow: "name",
  sys_app: "name",
}

// ==================== FILE MAPPINGS FOR IMPORT (artifact_directory / GitHub deploy) ====================
export const FILE_MAPPINGS: Record<string, Record<string, string[]>> = {
  sp_widget: {
    template: ["template.html", "index.html", "widget.html"],
    script: ["server.js", "server-script.js", "script.js"],
    client_script: ["client.js", "client-script.js", "controller.js"],
    css: ["style.css", "styles.css", "widget.css"],
    option_schema: ["options.json", "option_schema.json", "schema.json"],
  },
  sys_script: {
    // business_rule
    script: ["script.js", "index.js", "main.js"],
    condition: ["condition.js", "condition.txt"],
  },
  sys_script_include: {
    script: ["script.js", "index.js", "main.js", "{name}.js"],
  },
  sys_script_client: {
    script: ["script.js", "client.js", "index.js"],
  },
  sp_page: {
    // SP pages don't have script content
  },
  sys_ux_page: {
    // UIB pages don't have script content in same way
  },
  sys_ui_action: {
    script: ["script.js", "action.js", "index.js"],
    condition: ["condition.js"],
  },
  sysauto_script: {
    // scheduled_job
    script: ["script.js", "job.js", "index.js"],
  },
  sys_script_fix: {
    script: ["script.js", "fix.js", "index.js"],
  },
}

// ==================== FILE MAPPINGS FOR EXPORT ====================
export const EXPORT_FILE_MAPPINGS: Record<string, Record<string, string>> = {
  sp_widget: {
    template: "template.html",
    script: "server.js",
    client_script: "client.js",
    css: "style.css",
    option_schema: "options.json",
  },
  sys_script: {
    // business_rule
    script: "script.js",
    condition: "condition.js",
  },
  sys_script_include: {
    script: "script.js",
  },
  sys_script_client: {
    script: "script.js",
  },
  sys_ui_action: {
    script: "script.js",
    condition: "condition.js",
  },
  sysauto_script: {
    script: "script.js",
  },
  sys_script_fix: {
    script: "script.js",
  },
}

// ==================== DEFAULT FILE EXTENSIONS PER ARTIFACT TYPE ====================
export const DEFAULT_FILE_EXTENSIONS: Record<string, string> = {
  sys_script_include: ".js",
  sys_script: ".js",
  sys_script_client: ".js",
  sys_ui_action: ".js",
  sysauto_script: ".js",
  sys_script_fix: ".js",
  sp_widget: "", // Widgets use directory mode, not single-file
  sp_page: "",
  sys_ux_page: "",
}
