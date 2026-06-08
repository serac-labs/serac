/**
 * User Administration Tools - v8.2.0 Merged Architecture
 *
 * Tools merged: 5 → 2 (-3 tools)
 * - snow_user_manage: Replaces create_user, deactivate_user (2 → 1)
 * - snow_role_group_manage: Replaces create_role, assign_role, create_group (3 → 1)
 */

// Debugging & Security Helpers
export {
  toolDefinition as snow_impersonate_user_def,
  execute as snow_impersonate_user_exec,
} from "./snow_impersonate_user.js"

// Merged Tools (v8.2.0)
export { toolDefinition as snow_user_manage_def, execute as snow_user_manage_exec } from "./snow_user_manage.js"
export {
  toolDefinition as snow_role_group_manage_def,
  execute as snow_role_group_manage_exec,
} from "./snow_role_group_manage.js"
