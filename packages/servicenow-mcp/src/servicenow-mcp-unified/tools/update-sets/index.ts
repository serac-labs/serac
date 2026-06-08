/**
 * Update Set Tools - v8.2.0 Merged Tool Architecture
 *
 * Tools merged: 8 → 3 (-5 tools)
 * - snow_update_set_manage: Replaces create, switch, complete, export, preview, add_artifact (6 tools → 1)
 * - snow_update_set_query: Replaces current, list (2 tools → 1)
 * - snow_ensure_active_update_set: Kept (complex logic)
 */

// Merged Tools (v8.2.0)
export {
  toolDefinition as snow_update_set_manage_def,
  execute as snow_update_set_manage_exec,
} from "./snow_update_set_manage.js"
export {
  toolDefinition as snow_update_set_query_def,
  execute as snow_update_set_query_exec,
} from "./snow_update_set_query.js"

// Complex Logic Tools (Kept)
export {
  toolDefinition as snow_ensure_active_update_set_def,
  execute as snow_ensure_active_update_set_exec,
} from "./snow_ensure_active_update_set.js"
