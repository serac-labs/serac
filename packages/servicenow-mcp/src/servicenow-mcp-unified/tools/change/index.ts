/**
 * Change Management Tools - v8.2.0 Merged Architecture
 *
 * Tools merged: 8 → 2 (-6 tools)
 * - snow_change_manage: Replaces create, update_state, approve, create_task, schedule_cab (5 → 1)
 * - snow_change_query: Replaces get, search, assess_risk (3 → 1)
 */

// Merged Tools (v8.2.0)
export { toolDefinition as snow_change_manage_def, execute as snow_change_manage_exec } from "./snow_change_manage.js"
export { toolDefinition as snow_change_query_def, execute as snow_change_query_exec } from "./snow_change_query.js"
