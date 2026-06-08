/**
 * Serac Flow Designer Tool
 *
 * DISCLAIMER:
 * This tool uses both official and undocumented ServiceNow APIs to interact
 * with Flow Designer. The GraphQL-based operations (snFlowDesigner) use
 * internal ServiceNow APIs that are not officially documented and may change
 * without notice. Use at your own risk.
 *
 * This tool is not affiliated with, endorsed by, or sponsored by ServiceNow, Inc.
 * ServiceNow is a registered trademark of ServiceNow, Inc.
 *
 * A valid ServiceNow subscription and credentials are required to use this tool.
 */

export { toolDefinition as snow_manage_flow_def, execute as snow_manage_flow_exec } from "./snow_manage_flow.js"
