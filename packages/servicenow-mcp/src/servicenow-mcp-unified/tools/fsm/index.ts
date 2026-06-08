/**
 * Field Service Management (FSM) tools
 *
 * Wraps the tables installed by the ServiceNow Field Service Management
 * plugin (com.snc.work_management). Greenfield: first FSM coverage in
 * the repo — tables, fields and state catalogs are best-effort against
 * the documented FSM data model and should be verified against a live
 * instance before relying on the write paths.
 */

export {
  toolDefinition as snow_fsm_work_order_manage_def,
  execute as snow_fsm_work_order_manage_exec,
} from "./snow_fsm_work_order_manage.js"

export {
  toolDefinition as snow_fsm_dispatch_manage_def,
  execute as snow_fsm_dispatch_manage_exec,
} from "./snow_fsm_dispatch_manage.js"

export {
  toolDefinition as snow_fsm_parts_manage_def,
  execute as snow_fsm_parts_manage_exec,
} from "./snow_fsm_parts_manage.js"
