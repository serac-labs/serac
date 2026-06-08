/**
 * UI Builder Tools - Export all UI Builder tool modules
 */

// Merged Page Management Tools (v8.2.0 Phase 2)
// Replaces: create_uib_page, delete_uib_page, add_uib_page_element, remove_uib_page_element (4 → 1)
export {
  toolDefinition as snow_uib_page_manage_def,
  execute as snow_uib_page_manage_exec,
} from "./snow_uib_page_manage.js"

// Merged Discovery Tools (v8.2.0 Phase 2)
// Replaces: discover_uib_components, discover_uib_page_usage, discover_uib_pages, discover_uib_routes (4 → 1)
export { toolDefinition as snow_uib_discover_def, execute as snow_uib_discover_exec } from "./snow_uib_discover.js"

// Merged Component Management Tools (v8.2.0 Phase 3)
// Replaces: create_uib_component, clone_uib_component (2 → 1)
export {
  toolDefinition as snow_uib_component_manage_def,
  execute as snow_uib_component_manage_exec,
} from "./snow_uib_component_manage.js"

// UI Builder Operations (kept)
export {
  toolDefinition as snow_analyze_uib_page_performance_def,
  execute as snow_analyze_uib_page_performance_exec,
} from "./snow_analyze_uib_page_performance.js"
export {
  toolDefinition as snow_configure_uib_data_broker_def,
  execute as snow_configure_uib_data_broker_exec,
} from "./snow_configure_uib_data_broker.js"
export {
  toolDefinition as snow_create_uib_client_script_def,
  execute as snow_create_uib_client_script_exec,
} from "./snow_create_uib_client_script.js"
export {
  toolDefinition as snow_create_uib_client_state_def,
  execute as snow_create_uib_client_state_exec,
} from "./snow_create_uib_client_state.js"
export {
  toolDefinition as snow_create_uib_data_broker_def,
  execute as snow_create_uib_data_broker_exec,
} from "./snow_create_uib_data_broker.js"
export {
  toolDefinition as snow_create_uib_event_def,
  execute as snow_create_uib_event_exec,
} from "./snow_create_uib_event.js"
export {
  toolDefinition as snow_create_uib_page_registry_def,
  execute as snow_create_uib_page_registry_exec,
} from "./snow_create_uib_page_registry.js"
export {
  toolDefinition as snow_create_workspace_def,
  execute as snow_create_workspace_exec,
} from "./snow_create_workspace.js"
export {
  toolDefinition as snow_debug_widget_fetch_def,
  execute as snow_debug_widget_fetch_exec,
} from "./snow_debug_widget_fetch.js"
