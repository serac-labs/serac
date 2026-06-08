/**
 * System Properties Tools - v8.2.0 Merged Tool Architecture
 *
 * Tools merged: 12 → 4 (-8 tools)
 * - snow_property_manage: Replaces get, set, delete, validate (4 tools → 1)
 * - snow_property_query: Replaces list, search, categories (3 tools → 1)
 * - snow_property_bulk: Replaces bulk_get, bulk_set (2 tools → 1)
 * - snow_property_io: Replaces import, export, history (3 tools → 1)
 */

// Merged Tools (v8.2.0)
export {
  toolDefinition as snow_property_manage_def,
  execute as snow_property_manage_exec,
} from "./snow_property_manage.js"
export {
  toolDefinition as snow_property_query_def,
  execute as snow_property_query_exec,
} from "./snow_property_query.js"
export { toolDefinition as snow_property_bulk_def, execute as snow_property_bulk_exec } from "./snow_property_bulk.js"
export { toolDefinition as snow_property_io_def, execute as snow_property_io_exec } from "./snow_property_io.js"
