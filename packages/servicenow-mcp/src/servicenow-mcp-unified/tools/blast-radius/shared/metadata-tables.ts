/**
 * Blast Radius - Metadata Table Constants
 *
 * Declarative catalog of every ServiceNow artifact type we know how to scan.
 * Each spec tells the field-reference and table-configs tools how to:
 *   - find records scoped to a given table
 *   - which columns to grep for a field name
 *   - which structured columns contain an exact field reference
 *   - which condition/filter columns to additionally grep
 */

/**
 * Artifact type to ServiceNow table mapping (legacy — kept for script-analyzer compat)
 */
export interface ArtifactTableMapping {
  table: string
  scriptFields: string[]
  tableField: string | null
  displayFields: string
}

export const ARTIFACT_TABLE_MAP: Record<string, ArtifactTableMapping> = {
  business_rule: {
    table: "sys_script",
    scriptFields: ["script"],
    tableField: "collection",
    displayFields:
      "sys_id,name,when,order,active,collection,sys_scope,action_insert,action_update,action_delete,action_query",
  },
  client_script: {
    table: "sys_script_client",
    scriptFields: ["script"],
    tableField: "table",
    displayFields: "sys_id,name,type,field,active,table,sys_scope,ui_type",
  },
  ui_action: {
    table: "sys_ui_action",
    scriptFields: ["script"],
    tableField: "table",
    displayFields: "sys_id,name,active,table,sys_scope,order,condition",
  },
  ui_policy: {
    table: "sys_ui_policy",
    scriptFields: ["script_true", "script_false"],
    tableField: "table",
    displayFields: "sys_id,short_description,active,table,sys_scope,order",
  },
  script_include: {
    table: "sys_script_include",
    scriptFields: ["script"],
    tableField: null,
    displayFields: "sys_id,name,api_name,active,sys_scope,client_callable,access",
  },
  acl: {
    table: "sys_security_acl",
    scriptFields: ["script"],
    tableField: "name",
    displayFields: "sys_id,name,operation,active,sys_scope,type",
  },
  flow: {
    table: "sys_hub_flow",
    scriptFields: [],
    tableField: null,
    displayFields: "sys_id,name,active,sys_scope,trigger_type",
  },
  widget: {
    table: "sp_widget",
    scriptFields: ["script", "client_script"],
    tableField: null,
    displayFields: "sys_id,name,id,active,sys_scope",
  },
}

/**
 * How an artifact type relates to a ServiceNow table. Used to build the
 * `sysparm_query` that narrows results to "records on table X" before
 * post-filtering by field name.
 *
 *   tableField  — the record stores the table name in `field` (e.g. sys_script.collection)
 *   aclName     — ACLs: name is "<table>.<field>" or "<table>.*"
 *   dotwalk     — dotwalked query, e.g. sys_ui_policy_action has ui_policy.table=X
 *   global      — no table scoping (script_includes, scheduled_jobs, widgets, fix scripts, ...);
 *                 we filter client-side on whether the script also mentions the table name
 */
export type TableScope =
  | { kind: "tableField"; field: string }
  | { kind: "aclName" }
  | { kind: "dotwalk"; query: (table: string) => string }
  | { kind: "global" }

/**
 * Comprehensive artifact search spec.
 *
 *   scriptFields     — columns containing free-form JS/script text (we do LIKE + post-filter)
 *   conditionFields  — columns containing encoded queries or short condition scripts (we grep for the field name)
 *   structuredFields — columns that hold the field name verbatim (exact match, no post-filter)
 *   requiresPlugin   — optional hint; if the query returns 404/err we downgrade silently
 */
export interface ArtifactSearchSpec {
  type: string
  table: string
  scope: TableScope
  scriptFields: string[]
  conditionFields?: string[]
  structuredFields?: { column: string; value: "field" }[]
  selectFields: string
  nameField?: string
  requiresPlugin?: string
  description?: string
}

export const ARTIFACT_SPECS: ArtifactSearchSpec[] = [
  // ===== Scoped script artifacts =====
  {
    type: "business_rules",
    table: "sys_script",
    scope: { kind: "tableField", field: "collection" },
    scriptFields: ["script"],
    conditionFields: ["condition", "filter_condition", "role_conditions"],
    selectFields:
      "sys_id,name,when,order,active,collection,sys_scope,action_insert,action_update,action_delete,action_query",
    nameField: "name",
  },
  {
    type: "client_scripts",
    table: "sys_script_client",
    scope: { kind: "tableField", field: "table" },
    scriptFields: ["script"],
    selectFields: "sys_id,name,type,field,active,table,sys_scope,ui_type",
    nameField: "name",
  },
  {
    type: "ui_actions",
    table: "sys_ui_action",
    scope: { kind: "tableField", field: "table" },
    scriptFields: ["script"],
    conditionFields: ["condition"],
    selectFields: "sys_id,name,active,table,sys_scope,order,condition",
    nameField: "name",
  },
  {
    type: "ui_policies",
    table: "sys_ui_policy",
    scope: { kind: "tableField", field: "table" },
    scriptFields: ["script_true", "script_false"],
    conditionFields: ["conditions"],
    selectFields: "sys_id,short_description,active,table,sys_scope,order,on_load,reverse_if_false",
    nameField: "short_description",
  },
  {
    type: "ui_policy_actions",
    table: "sys_ui_policy_action",
    scope: { kind: "dotwalk", query: (t) => `ui_policy.table=${t}` },
    scriptFields: [],
    structuredFields: [{ column: "field", value: "field" }],
    selectFields: "sys_id,field,visible,mandatory,disabled,cleared,ui_policy,ui_policy.short_description",
  },
  {
    type: "data_policies",
    table: "sys_data_policy2",
    scope: { kind: "tableField", field: "model_table" },
    scriptFields: [],
    selectFields: "sys_id,short_description,active,model_table,sys_scope,enforce_ui,apply_import_set",
    nameField: "short_description",
  },
  {
    type: "data_policy_rules",
    table: "sys_data_policy_rule",
    scope: { kind: "dotwalk", query: (t) => `sys_data_policy.model_table=${t}` },
    scriptFields: [],
    structuredFields: [{ column: "table_field", value: "field" }],
    selectFields: "sys_id,table_field,mandatory,disabled,sys_data_policy,sys_data_policy.short_description",
  },
  {
    type: "acls",
    table: "sys_security_acl",
    scope: { kind: "aclName" },
    scriptFields: ["script"],
    conditionFields: ["condition"],
    selectFields: "sys_id,name,operation,active,script,condition,sys_scope,type",
    nameField: "name",
  },
  {
    type: "email_notifications",
    table: "sysevent_email_action",
    scope: { kind: "tableField", field: "collection" },
    scriptFields: ["message_html", "message_text", "subject"],
    conditionFields: ["condition", "advanced_condition"],
    selectFields:
      "sys_id,name,active,collection,sys_scope,event_name,subject,send_self,action_insert,action_update",
    nameField: "name",
  },
  {
    type: "metric_definitions",
    table: "metric_definition",
    scope: { kind: "tableField", field: "table" },
    scriptFields: ["script"],
    structuredFields: [{ column: "field", value: "field" }],
    selectFields: "sys_id,name,active,table,field,type,sys_scope",
    nameField: "name",
  },

  // ===== Structured (exact field match) =====
  {
    type: "dictionary_dependent",
    table: "sys_dictionary",
    scope: { kind: "tableField", field: "name" },
    scriptFields: [],
    structuredFields: [
      { column: "dependent", value: "field" },
      { column: "dependent_on_field", value: "field" },
    ],
    selectFields: "sys_id,element,column_label,internal_type,dependent,dependent_on_field",
    nameField: "element",
  },

  // ===== Global script artifacts (no table column) =====
  {
    type: "script_includes",
    table: "sys_script_include",
    scope: { kind: "global" },
    scriptFields: ["script"],
    selectFields: "sys_id,name,api_name,active,sys_scope,client_callable,access",
    nameField: "name",
  },
  {
    type: "scheduled_jobs",
    table: "sysauto_script",
    scope: { kind: "global" },
    scriptFields: ["script"],
    selectFields: "sys_id,name,active,run_as,sys_scope,run_type",
    nameField: "name",
  },
  {
    type: "fix_scripts",
    table: "sys_script_fix",
    scope: { kind: "global" },
    scriptFields: ["script"],
    selectFields: "sys_id,name,active,sys_scope,unloadable",
    nameField: "name",
  },
  {
    type: "script_actions",
    table: "sysevent_script_action",
    scope: { kind: "global" },
    scriptFields: ["script"],
    selectFields: "sys_id,name,active,event_name,sys_scope",
    nameField: "name",
  },
  {
    type: "transform_scripts",
    table: "sys_transform_script",
    scope: { kind: "global" },
    scriptFields: ["script"],
    selectFields: "sys_id,name,when,order,active,map,sys_scope",
    nameField: "name",
  },
  {
    type: "transform_entries",
    table: "sys_transform_entry",
    scope: { kind: "dotwalk", query: (t) => `map.target_table=${t}^ORmap.source_table=${t}` },
    scriptFields: ["script"],
    structuredFields: [
      { column: "target_field", value: "field" },
      { column: "source_field", value: "field" },
    ],
    selectFields:
      "sys_id,target_field,source_field,use_source_script,coalesce,map,map.name,sys_scope",
  },
  {
    type: "processors",
    table: "sys_processor",
    scope: { kind: "global" },
    scriptFields: ["script"],
    selectFields: "sys_id,name,path,active,type,sys_scope",
    nameField: "name",
  },
  {
    type: "ui_scripts",
    table: "sys_ui_script",
    scope: { kind: "global" },
    scriptFields: ["script"],
    selectFields: "sys_id,name,script_name,active,sys_scope,global",
    nameField: "name",
  },
  {
    type: "scripted_rest_resources",
    table: "sys_ws_operation",
    scope: { kind: "global" },
    scriptFields: ["operation_script"],
    selectFields: "sys_id,name,operation_uri,http_method,active,web_service_definition,sys_scope",
    nameField: "name",
    requiresPlugin: "com.snc.integration.rest",
  },
  {
    type: "email_scripts",
    table: "sys_script_email",
    scope: { kind: "global" },
    scriptFields: ["script"],
    selectFields: "sys_id,name,active,sys_scope",
    nameField: "name",
  },
  {
    type: "inbound_email_actions",
    table: "sysevent_in_email_action",
    scope: { kind: "tableField", field: "target_table" },
    scriptFields: ["script"],
    conditionFields: ["condition"],
    selectFields: "sys_id,name,active,target_table,type,sys_scope",
    nameField: "name",
  },
  {
    type: "portal_widgets",
    table: "sp_widget",
    scope: { kind: "global" },
    scriptFields: ["script", "client_script", "link"],
    selectFields: "sys_id,name,id,active,sys_scope",
    nameField: "name",
    requiresPlugin: "com.glide.service-portal",
  },
  {
    type: "catalog_client_scripts",
    table: "catalog_script_client",
    scope: { kind: "global" },
    scriptFields: ["script"],
    selectFields: "sys_id,name,type,active,cat_item,variable_set,applies_to,sys_scope",
    nameField: "name",
    requiresPlugin: "com.glideapp.servicecatalog",
  },
  {
    type: "catalog_ui_policies",
    table: "catalog_ui_policy",
    scope: { kind: "global" },
    scriptFields: ["script_true", "script_false"],
    conditionFields: ["catalog_conditions"],
    selectFields: "sys_id,short_description,active,applies_to,cat_item,variable_set,sys_scope",
    nameField: "short_description",
    requiresPlugin: "com.glideapp.servicecatalog",
  },
  {
    type: "atf_steps",
    table: "sys_atf_step",
    scope: { kind: "global" },
    scriptFields: ["inputs"],
    selectFields: "sys_id,step_config,test,order,active,sys_scope",
    requiresPlugin: "com.snc.atf",
  },
]

/**
 * Quick lookup by type name
 */
export const ARTIFACT_SPEC_BY_TYPE: Record<string, ArtifactSearchSpec> = Object.fromEntries(
  ARTIFACT_SPECS.map((s) => [s.type, s]),
)

/**
 * All artifact type names as a literal tuple (for enum generation)
 */
export const ARTIFACT_TYPE_NAMES = ARTIFACT_SPECS.map((s) => s.type)

/**
 * Config types queried by `snow_blast_radius_table_configs` (plural form)
 */
export const TABLE_CONFIG_TYPES = [
  "business_rules",
  "client_scripts",
  "ui_actions",
  "ui_policies",
  "ui_policy_actions",
  "data_policies",
  "data_policy_rules",
  "acls",
  "email_notifications",
  "metric_definitions",
  "inbound_email_actions",
  "transform_entries",
  "script_includes",
] as const

export type ConfigType = (typeof TABLE_CONFIG_TYPES)[number]

/**
 * Metadata tables used for aggregate config counting per scope
 */
export const SCOPE_COUNT_TABLES = [
  { key: "business_rules", table: "sys_script" },
  { key: "client_scripts", table: "sys_script_client" },
  { key: "ui_actions", table: "sys_ui_action" },
  { key: "ui_policies", table: "sys_ui_policy" },
  { key: "script_includes", table: "sys_script_include" },
  { key: "acls", table: "sys_security_acl" },
] as const

/**
 * GlideRecord built-in methods to exclude from field detection
 */
export const GLIDE_RECORD_BUILTINS = new Set([
  "initialize",
  "query",
  "next",
  "get",
  "insert",
  "update",
  "deleteRecord",
  "hasNext",
  "getRowCount",
  "getTableName",
  "addEncodedQuery",
  "setLimit",
  "setWorkflow",
  "autoSysFields",
  "isValid",
  "isValidRecord",
  "canRead",
  "canWrite",
  "canCreate",
  "canDelete",
  "operation",
  "isNewRecord",
  "isActionAborted",
  "setAbortAction",
  "addActiveQuery",
  "orderBy",
  "orderByDesc",
  "setCategory",
  "chooseWindow",
  "getEncodedQuery",
  "getUniqueValue",
  "getClassDisplayValue",
  "getDisplayValue",
  "getElement",
  "getElements",
  "getLabel",
  "getLink",
  "getRecordClassName",
  "getAttribute",
  "setNewGuidValue",
])
