/**
 * Predictive Intelligence Tools
 * Build and manage native ServiceNow PI solutions conversationally
 *
 * The `_def`/`_exec` suffixes are not decoration: `loadStaticTools` in
 * shared/tool-registry.ts finds tools by filtering exports ending in `_def`
 * and pairing each with `<base>_exec`. This file used to export
 * `<name>_tool` / `<name>` / `<name>_version`, so even once the domain was
 * added to STATIC_TOOL_MODULES not one of these five would have registered.
 */

export {
  toolDefinition as snow_create_pi_solution_def,
  execute as snow_create_pi_solution_exec,
} from "./snow_create_pi_solution.js"
export {
  toolDefinition as snow_train_pi_solution_def,
  execute as snow_train_pi_solution_exec,
} from "./snow_train_pi_solution.js"
export {
  toolDefinition as snow_monitor_pi_training_def,
  execute as snow_monitor_pi_training_exec,
} from "./snow_monitor_pi_training.js"
export {
  toolDefinition as snow_activate_pi_solution_def,
  execute as snow_activate_pi_solution_exec,
} from "./snow_activate_pi_solution.js"
export {
  toolDefinition as snow_list_pi_solutions_def,
  execute as snow_list_pi_solutions_exec,
} from "./snow_list_pi_solutions.js"
