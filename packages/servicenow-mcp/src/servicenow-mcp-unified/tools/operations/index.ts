/**
 * Operations Tools - Export all operations tool modules
 *
 * ⚡ RECOMMENDED: Use snow_record_manage for ALL record CRUD operations:
 * - create: Create records (incident, change, problem, user, asset, etc.)
 * - get: Get record by sys_id or number
 * - update: Update records
 * - delete: Delete records (soft/hard delete)
 * - query: Search/list records with filters
 *
 * Table presets: incident, problem, change, request, user, group, asset, ci, server,
 * hr_case, customer_case, project, purchase_order, knowledge_article, etc.
 */

// ==================== Unified Record Management ====================
export { toolDefinition as snow_record_manage_def, execute as snow_record_manage_exec } from "./snow_record_manage.js"

// ==================== Core Query & Discovery Tools ====================
export { toolDefinition as snow_query_table_def, execute as snow_query_table_exec } from "./snow_query_table.js"
export {
  toolDefinition as snow_discover_table_fields_def,
  execute as snow_discover_table_fields_exec,
} from "./snow_discover_table_fields.js"
export { toolDefinition as snow_get_by_sysid_def, execute as snow_get_by_sysid_exec } from "./snow_get_by_sysid.js"
export {
  toolDefinition as snow_search_artifacts_def,
  toolDefinitionAlias as snow_comprehensive_search_def,
  execute as snow_search_artifacts_exec,
  execute as snow_comprehensive_search_exec,
} from "./snow_comprehensive_search.js"
export { toolDefinition as snow_attach_file_def, execute as snow_attach_file_exec } from "./snow_attach_file.js"

// ==================== Analytics & AI Tools ====================
export {
  toolDefinition as snow_analyze_incident_def,
  execute as snow_analyze_incident_exec,
} from "./snow_analyze_incident.js"
export {
  toolDefinition as snow_auto_resolve_incident_def,
  execute as snow_auto_resolve_incident_exec,
} from "./snow_auto_resolve_incident.js"
export {
  toolDefinition as snow_operational_metrics_def,
  execute as snow_operational_metrics_exec,
} from "./snow_operational_metrics.js"
export {
  toolDefinition as snow_pattern_analysis_def,
  execute as snow_pattern_analysis_exec,
} from "./snow_pattern_analysis.js"
export {
  toolDefinition as snow_predictive_analysis_def,
  execute as snow_predictive_analysis_exec,
} from "./snow_predictive_analysis.js"

// ==================== CMDB & Catalog ====================
export { toolDefinition as snow_cmdb_search_def, execute as snow_cmdb_search_exec } from "./snow_cmdb_search.js"
export {
  toolDefinition as snow_catalog_item_manager_def,
  execute as snow_catalog_item_manager_exec,
} from "./snow_catalog_item_manager.js"
export {
  toolDefinition as snow_catalog_item_search_def,
  execute as snow_catalog_item_search_exec,
} from "./snow_catalog_item_search.js"

// ==================== Utility ====================
export {
  toolDefinition as snow_cleanup_test_artifacts_def,
  execute as snow_cleanup_test_artifacts_exec,
} from "./snow_cleanup_test_artifacts.js"
export { toolDefinition as snow_assign_task_def, execute as snow_assign_task_exec } from "./snow_assign_task.js"
export {
  toolDefinition as snow_manage_group_membership_def,
  execute as snow_manage_group_membership_exec,
} from "./snow_manage_group_membership.js"
