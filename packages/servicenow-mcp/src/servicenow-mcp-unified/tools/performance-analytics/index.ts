/**
 * Performance Analytics Tools - v8.2.0 Merged Architecture
 *
 * Phase 2: 14 → 6 (-8 tools)
 * - snow_pa_create: Replaces indicator, kpi, breakdown, threshold, widget, visualization, scheduled_report (7 → 1)
 * - snow_pa_discover: Replaces discover_pa_indicators, discover_report_fields, discover_reporting_tables (3 → 1)
 *
 * Phase 3: 6 → 3 (-3 tools)
 * - snow_pa_operate: Replaces collect_pa_data, export_report_data, generate_insights, get_pa_scores (4 → 1)
 */

// Merged Tools (v8.2.0 Phase 2)
export { toolDefinition as snow_pa_create_def, execute as snow_pa_create_exec } from "./snow_pa_create.js"
export { toolDefinition as snow_pa_discover_def, execute as snow_pa_discover_exec } from "./snow_pa_discover.js"

// Merged Tools (v8.2.0 Phase 3)
export { toolDefinition as snow_pa_operate_def, execute as snow_pa_operate_exec } from "./snow_pa_operate.js"

// Tier 1 foundation tools
export {
  toolDefinition as snow_pa_indicator_manage_def,
  execute as snow_pa_indicator_manage_exec,
} from "./snow_pa_indicator_manage.js"
