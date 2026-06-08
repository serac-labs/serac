/**
 * Development Tools - Index
 *
 * Exports all development assistant tools for the ServiceNow Unified MCP Server
 *
 * NOTE: For artifact operations, use snow_artifact_manage from deployment tools:
 * - snow_artifact_manage action='find' - Find artifacts
 * - snow_artifact_manage action='analyze' - Analyze dependencies
 * - snow_artifact_manage action='update' - Edit/update artifacts
 * - snow_artifact_manage action='get' - Get artifact by sys_id
 */

// ==================== Development Tools ====================
export { toolDefinition as snow_code_search_def, execute as snow_code_search_exec } from "./snow_code_search.js"
// snow_get_by_sysid is now exclusively in tools/operations/. The artifact-
// specialized variant that used to live here is covered by
// snow_artifact_manage action='get' (deployment tools).
export {
  toolDefinition as snow_analyze_requirements_def,
  execute as snow_analyze_requirements_exec,
} from "./snow_analyze_requirements.js"
export { toolDefinition as snow_edit_by_sysid_def, execute as snow_edit_by_sysid_exec } from "./snow_edit_by_sysid.js"
export { toolDefinition as snow_memory_search_def, execute as snow_memory_search_exec } from "./snow_memory_search.js"
export {
  toolDefinition as snow_orchestrate_development_def,
  execute as snow_orchestrate_development_exec,
} from "./snow_orchestrate_development.js"
export {
  toolDefinition as snow_sync_data_consistency_def,
  execute as snow_sync_data_consistency_exec,
} from "./snow_sync_data_consistency.js"
export {
  toolDefinition as snow_validate_live_connection_def,
  execute as snow_validate_live_connection_exec,
} from "./snow_validate_live_connection.js"

// Developer-only test tool (issue #127). Should be excluded from
// production end-user surfaces via portal CATEGORY_FEATURES.
export {
  toolDefinition as snow_dev_test_connection_def,
  execute as snow_dev_test_connection_exec,
} from "./snow_dev_test_connection.js"
