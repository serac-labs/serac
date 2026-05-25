/**
 * snow_record_manage - Unified Record Management
 *
 * Comprehensive CRUD+Query operations for ANY ServiceNow table with:
 * - Smart table presets with default fields
 * - Helper shortcuts for common record types (incident, change, problem, user, etc.)
 * - Validation with enums and defaults
 * - Auto-assignment logic
 * - Optimistic locking and dependency checking
 *
 * Replaces ALL individual record tools:
 * - snow_create_incident, snow_update_incident, snow_query_incidents
 * - snow_create_change, snow_change_query
 * - snow_create_problem, snow_query_problems
 * - snow_create_ci, snow_update_ci, snow_create_ci_relationship
 * - snow_create_user_group, snow_user_lookup
 * - snow_create_asset, snow_retire_asset
 * - snow_create_hr_case, snow_create_hr_task
 * - snow_create_customer_account, snow_create_customer_case
 * - snow_create_project, snow_create_project_task
 * - snow_create_purchase_order
 * - And many more...
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"
import { getFieldValue } from "../../shared/output-formatter.js"

// ==================== TABLE PRESETS ====================
const TABLE_PRESETS: Record<string, { table: string; label: string; defaultFields: string[]; numberField?: string }> = {
  // ITSM Core
  incident: {
    table: "incident",
    label: "Incident",
    defaultFields: [
      "number",
      "short_description",
      "description",
      "state",
      "priority",
      "urgency",
      "impact",
      "assigned_to",
      "assignment_group",
      "caller_id",
      "category",
      "subcategory",
      "opened_at",
      "resolved_at",
      "closed_at",
    ],
    numberField: "number",
  },
  problem: {
    table: "problem",
    label: "Problem",
    defaultFields: [
      "number",
      "short_description",
      "description",
      "state",
      "priority",
      "assigned_to",
      "assignment_group",
      "opened_at",
      "resolved_at",
    ],
    numberField: "number",
  },
  change: {
    table: "change_request",
    label: "Change Request",
    defaultFields: [
      "number",
      "short_description",
      "description",
      "state",
      "type",
      "priority",
      "risk",
      "impact",
      "assigned_to",
      "assignment_group",
      "start_date",
      "end_date",
      "cab_required",
    ],
    numberField: "number",
  },
  change_request: {
    table: "change_request",
    label: "Change Request",
    defaultFields: [
      "number",
      "short_description",
      "description",
      "state",
      "type",
      "priority",
      "risk",
      "impact",
      "assigned_to",
      "assignment_group",
      "start_date",
      "end_date",
    ],
    numberField: "number",
  },
  change_task: {
    table: "change_task",
    label: "Change Task",
    defaultFields: ["number", "short_description", "state", "assigned_to", "change_request"],
    numberField: "number",
  },
  request: {
    table: "sc_request",
    label: "Request",
    defaultFields: ["number", "short_description", "state", "requested_for", "opened_by", "opened_at", "price"],
    numberField: "number",
  },
  sc_request: {
    table: "sc_request",
    label: "Request",
    defaultFields: ["number", "short_description", "state", "requested_for", "opened_by"],
    numberField: "number",
  },
  request_item: {
    table: "sc_req_item",
    label: "Requested Item",
    defaultFields: ["number", "short_description", "state", "cat_item", "request", "quantity", "price"],
    numberField: "number",
  },
  task: {
    table: "sc_task",
    label: "Catalog Task",
    defaultFields: ["number", "short_description", "state", "assigned_to", "request_item"],
    numberField: "number",
  },
  ci: {
    table: "cmdb_ci",
    label: "Configuration Item",
    defaultFields: [
      "name",
      "sys_class_name",
      "operational_status",
      "install_status",
      "location",
      "assigned_to",
      "support_group",
      "manufacturer",
      "model_id",
    ],
    numberField: "name",
  },
  cmdb_ci: {
    table: "cmdb_ci",
    label: "Configuration Item",
    defaultFields: ["name", "sys_class_name", "operational_status", "install_status", "location"],
    numberField: "name",
  },
  server: {
    table: "cmdb_ci_server",
    label: "Server",
    defaultFields: ["name", "ip_address", "os", "os_version", "cpu_count", "ram", "disk_space", "operational_status"],
    numberField: "name",
  },
  computer: {
    table: "cmdb_ci_computer",
    label: "Computer",
    defaultFields: ["name", "ip_address", "os", "os_version", "cpu_type", "ram", "operational_status"],
    numberField: "name",
  },
  ci_relationship: {
    table: "cmdb_rel_ci",
    label: "CI Relationship",
    defaultFields: ["parent", "child", "type"],
    numberField: "sys_id",
  },
  user: {
    table: "sys_user",
    label: "User",
    defaultFields: [
      "user_name",
      "first_name",
      "last_name",
      "email",
      "active",
      "department",
      "location",
      "manager",
      "title",
    ],
    numberField: "user_name",
  },
  sys_user: {
    table: "sys_user",
    label: "User",
    defaultFields: ["user_name", "first_name", "last_name", "email", "active", "department"],
    numberField: "user_name",
  },
  group: {
    table: "sys_user_group",
    label: "Group",
    defaultFields: ["name", "description", "manager", "email", "active", "type"],
    numberField: "name",
  },
  sys_user_group: {
    table: "sys_user_group",
    label: "Group",
    defaultFields: ["name", "description", "manager", "email", "active"],
    numberField: "name",
  },
  group_member: {
    table: "sys_user_grmember",
    label: "Group Member",
    defaultFields: ["user", "group"],
    numberField: "sys_id",
  },
  asset: {
    table: "alm_asset",
    label: "Asset",
    defaultFields: [
      "display_name",
      "asset_tag",
      "model",
      "serial_number",
      "install_status",
      "assigned_to",
      "location",
      "cost",
      "acquisition_method",
    ],
    numberField: "asset_tag",
  },
  alm_asset: {
    table: "alm_asset",
    label: "Asset",
    defaultFields: ["display_name", "asset_tag", "model", "serial_number", "install_status"],
    numberField: "asset_tag",
  },
  hardware_asset: {
    table: "alm_hardware",
    label: "Hardware Asset",
    defaultFields: ["display_name", "asset_tag", "model", "serial_number", "install_status", "ci"],
    numberField: "asset_tag",
  },
  software_license: {
    table: "alm_license",
    label: "Software License",
    defaultFields: ["display_name", "product", "license_type", "quantity", "rights", "start_date", "end_date"],
    numberField: "display_name",
  },
  hr_case: {
    table: "sn_hr_core_case",
    label: "HR Case",
    defaultFields: ["number", "short_description", "state", "hr_service", "opened_for", "assigned_to", "opened_at"],
    numberField: "number",
  },
  hr_task: {
    table: "sn_hr_core_task",
    label: "HR Task",
    defaultFields: ["number", "short_description", "state", "assigned_to", "parent"],
    numberField: "number",
  },
  customer_case: {
    table: "sn_customerservice_case",
    label: "Customer Case",
    defaultFields: ["number", "short_description", "state", "account", "contact", "assigned_to", "priority"],
    numberField: "number",
  },
  customer_account: {
    table: "customer_account",
    label: "Customer Account",
    defaultFields: ["name", "account_code", "primary_contact", "phone", "city", "country"],
    numberField: "name",
  },
  customer_contact: {
    table: "customer_contact",
    label: "Customer Contact",
    defaultFields: ["name", "email", "phone", "account", "active"],
    numberField: "name",
  },
  project: {
    table: "pm_project",
    label: "Project",
    defaultFields: [
      "number",
      "short_description",
      "state",
      "project_manager",
      "start_date",
      "end_date",
      "percent_complete",
    ],
    numberField: "number",
  },
  project_task: {
    table: "pm_project_task",
    label: "Project Task",
    defaultFields: ["number", "short_description", "state", "assigned_to", "parent", "percent_complete"],
    numberField: "number",
  },
  purchase_order: {
    table: "proc_po",
    label: "Purchase Order",
    defaultFields: ["number", "short_description", "state", "vendor", "ordered_by", "total_cost"],
    numberField: "number",
  },
  knowledge_article: {
    table: "kb_knowledge",
    label: "Knowledge Article",
    defaultFields: ["number", "short_description", "text", "workflow_state", "author", "kb_knowledge_base", "category"],
    numberField: "number",
  },
  kb_knowledge: {
    table: "kb_knowledge",
    label: "Knowledge Article",
    defaultFields: ["number", "short_description", "text", "workflow_state", "author"],
    numberField: "number",
  },
  security_incident: {
    table: "sn_si_incident",
    label: "Security Incident",
    defaultFields: ["number", "short_description", "state", "priority", "assigned_to", "category"],
    numberField: "number",
  },
  devops_change: {
    table: "sn_devops_change",
    label: "DevOps Change",
    defaultFields: ["number", "short_description", "state", "pipeline", "artifact"],
    numberField: "number",
  },
}

const TABLE_PRESET_NAMES = Object.keys(TABLE_PRESETS)

// ==================== HELPER FIELDS PER TABLE TYPE ====================
// These are the shortcut parameters that get merged into data
const HELPER_FIELDS: Record<string, string[]> = {
  incident: [
    "short_description",
    "description",
    "caller_id",
    "urgency",
    "impact",
    "priority",
    "category",
    "subcategory",
    "assignment_group",
    "assigned_to",
    "configuration_item",
    "state",
    "work_notes",
    "comments",
  ],
  problem: [
    "short_description",
    "description",
    "priority",
    "assignment_group",
    "assigned_to",
    "category",
    "subcategory",
    "state",
    "work_notes",
    "related_incidents",
  ],
  change_request: [
    "short_description",
    "description",
    "type",
    "priority",
    "risk",
    "impact",
    "assignment_group",
    "assigned_to",
    "start_date",
    "end_date",
    "justification",
    "implementation_plan",
    "backout_plan",
    "test_plan",
    "state",
    "cab_required",
  ],
  change: [
    "short_description",
    "description",
    "type",
    "priority",
    "risk",
    "impact",
    "assignment_group",
    "assigned_to",
    "start_date",
    "end_date",
    "justification",
    "implementation_plan",
    "backout_plan",
    "test_plan",
    "state",
    "cab_required",
  ],
  change_task: [
    "short_description",
    "description",
    "change_request",
    "assignment_group",
    "assigned_to",
    "state",
    "planned_start_date",
    "planned_end_date",
  ],
  request: ["short_description", "description", "requested_for", "price", "state"],
  request_item: ["short_description", "cat_item", "request", "requested_for", "quantity", "state"],
  task: ["short_description", "description", "request_item", "assignment_group", "assigned_to", "state"],
  ci: [
    "name",
    "sys_class_name",
    "operational_status",
    "install_status",
    "location",
    "assigned_to",
    "support_group",
    "manufacturer",
    "model_id",
    "serial_number",
    "ip_address",
    "mac_address",
  ],
  cmdb_ci: [
    "name",
    "sys_class_name",
    "operational_status",
    "install_status",
    "location",
    "assigned_to",
    "support_group",
  ],
  server: [
    "name",
    "ip_address",
    "os",
    "os_version",
    "cpu_count",
    "cpu_type",
    "ram",
    "disk_space",
    "operational_status",
    "install_status",
    "location",
    "assigned_to",
    "support_group",
  ],
  computer: [
    "name",
    "ip_address",
    "os",
    "os_version",
    "cpu_type",
    "ram",
    "operational_status",
    "install_status",
    "location",
    "assigned_to",
  ],
  ci_relationship: ["parent", "child", "type"],
  user: [
    "user_name",
    "first_name",
    "last_name",
    "email",
    "active",
    "department",
    "location",
    "manager",
    "title",
    "phone",
    "mobile_phone",
    "employee_number",
  ],
  sys_user: ["user_name", "first_name", "last_name", "email", "active", "department", "location", "manager", "title"],
  group: ["name", "description", "manager", "email", "active", "type", "parent"],
  sys_user_group: ["name", "description", "manager", "email", "active", "type"],
  group_member: ["user", "group"],
  asset: [
    "display_name",
    "asset_tag",
    "model",
    "serial_number",
    "install_status",
    "assigned_to",
    "location",
    "cost",
    "acquisition_method",
    "vendor",
    "warranty_expiration",
  ],
  hr_case: ["short_description", "description", "hr_service", "opened_for", "assigned_to", "priority", "state"],
  hr_task: ["short_description", "description", "parent", "assigned_to", "state"],
  customer_case: [
    "short_description",
    "description",
    "account",
    "contact",
    "assigned_to",
    "priority",
    "state",
    "product",
  ],
  customer_account: ["name", "account_code", "primary_contact", "phone", "city", "state", "country", "website"],
  customer_contact: ["name", "first_name", "last_name", "email", "phone", "account", "active", "title"],
  project: [
    "short_description",
    "description",
    "project_manager",
    "start_date",
    "end_date",
    "state",
    "percent_complete",
    "primary_goal",
  ],
  project_task: [
    "short_description",
    "description",
    "parent",
    "assigned_to",
    "start_date",
    "end_date",
    "state",
    "percent_complete",
  ],
  purchase_order: ["short_description", "description", "vendor", "ordered_by", "total_cost", "state", "ship_to"],
  knowledge_article: [
    "short_description",
    "text",
    "kb_knowledge_base",
    "category",
    "author",
    "workflow_state",
    "valid_to",
  ],
}

export const toolDefinition: MCPToolDefinition = {
  name: "snow_record_manage",
  description: `Primary tool for CRUD+query on any ServiceNow record. Replaces the per-table create/update/get/delete tools (snow_create_incident, snow_update_change, snow_query_problems, etc.) — use this for any record operation.

Actions: create, get, update, delete, query.

Supported table presets (friendly names map to platform tables, with sensible default field sets):
- ITSM: incident, problem, change, change_request, change_task, request, task
- CMDB: ci, server, computer, ci_relationship
- Users: user, group, group_member
- Assets: asset, hardware_asset, software_license
- HR/CSM: hr_case, hr_task, customer_case, customer_account
- Projects: project, project_task
- Other: purchase_order, knowledge_article

Pass any other table name directly — presets are a convenience, not a restriction.

Examples:
- { action: "create", table: "incident", short_description: "...", urgency: 2 }
- { action: "update", table: "incident", sys_id: "...", state: 6 }
- { action: "query", table: "incident", query: "state=1" }
- { action: "get", table: "incident", number: "INC0010001" }`,
  category: "core-operations",
  subcategory: "crud",
  use_cases: [
    "create incident",
    "update incident",
    "get incident",
    "delete incident",
    "query incidents",
    "create change",
    "update change",
    "get change",
    "delete change",
    "query changes",
    "create problem",
    "update problem",
    "get problem",
    "delete problem",
    "query problems",
    "create user",
    "update user",
    "get user",
    "delete user",
    "query users",
    "create asset",
    "update asset",
    "get asset",
    "delete asset",
    "query assets",
    "create ci",
    "update ci",
    "get ci",
    "delete ci",
    "query ci",
    "create record",
    "update record",
    "get record",
    "delete record",
    "query records",
    "incident management",
    "change management",
    "problem management",
    "user management",
    "modify incident",
    "edit incident",
    "change incident state",
    "assign incident",
    "modify change",
    "edit change",
    "modify problem",
    "edit problem",
  ],
  complexity: "intermediate",
  frequency: "high",

  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Operation to perform",
        enum: ["create", "get", "update", "delete", "query"],
      },
      table: {
        type: "string",
        description: "Table name or preset (incident, change, user, asset, etc.)",
      },

      // ==================== GET/UPDATE/DELETE parameters ====================
      sys_id: {
        type: "string",
        description: "[get/update/delete] Record sys_id",
      },
      number: {
        type: "string",
        description: "[get] Record number (e.g., INC0010001, CHG0001234)",
      },

      // ==================== CREATE/UPDATE data object ====================
      data: {
        type: "object",
        description: "[create/update] Field values for the record (alternative to helper shortcuts)",
      },

      // ==================== INCIDENT HELPER SHORTCUTS ====================
      short_description: {
        type: "string",
        description: "[create/update] Brief description (incident, problem, change, etc.)",
      },
      description: {
        type: "string",
        description: "[create/update] Detailed description",
      },
      caller_id: {
        type: "string",
        description: "[incident] User sys_id or username of caller",
      },
      urgency: {
        type: "number",
        description: "[incident/problem] 1=High, 2=Medium, 3=Low",
        enum: [1, 2, 3],
        default: 3,
      },
      impact: {
        type: "number",
        description: "[incident/change] 1=High, 2=Medium, 3=Low",
        enum: [1, 2, 3],
        default: 3,
      },
      priority: {
        type: "number",
        description: "[incident/problem/change] 1=Critical, 2=High, 3=Moderate, 4=Low, 5=Planning",
        enum: [1, 2, 3, 4, 5],
      },
      category: {
        type: "string",
        description: '[incident/problem] Category (e.g., "software", "hardware", "network")',
      },
      subcategory: {
        type: "string",
        description: "[incident/problem] Subcategory",
      },
      assignment_group: {
        type: "string",
        description: "[incident/change/problem] Assignment group sys_id or name",
      },
      assigned_to: {
        type: "string",
        description: "[incident/change/problem] Assigned user sys_id or username",
      },
      configuration_item: {
        type: "string",
        description: "[incident] Configuration Item sys_id or name",
      },
      work_notes: {
        type: "string",
        description: "[incident/change/problem] Work notes (internal)",
      },
      comments: {
        type: "string",
        description: "[incident/change/problem] Additional comments (customer visible)",
      },
      state: {
        type: "number",
        description: "[incident] State: 1=New, 2=InProgress, 3=OnHold, 6=Resolved, 7=Closed",
      },

      // ==================== CHANGE HELPER SHORTCUTS ====================
      type: {
        type: "string",
        description: "[change] Change type",
        enum: ["normal", "standard", "emergency"],
      },
      risk: {
        type: "number",
        description: "[change] Risk level: 1=Very High, 2=High, 3=Moderate, 4=Low",
        enum: [1, 2, 3, 4],
      },
      start_date: {
        type: "string",
        description: "[change/project] Planned start date (YYYY-MM-DD HH:mm:ss)",
      },
      end_date: {
        type: "string",
        description: "[change/project] Planned end date (YYYY-MM-DD HH:mm:ss)",
      },
      justification: {
        type: "string",
        description: "[change] Business justification",
      },
      implementation_plan: {
        type: "string",
        description: "[change] Implementation plan",
      },
      backout_plan: {
        type: "string",
        description: "[change] Backout/rollback plan",
      },
      test_plan: {
        type: "string",
        description: "[change] Test plan",
      },
      cab_required: {
        type: "boolean",
        description: "[change] Requires CAB approval",
        default: false,
      },

      // ==================== USER HELPER SHORTCUTS ====================
      user_name: {
        type: "string",
        description: "[user] Username (login ID)",
      },
      first_name: {
        type: "string",
        description: "[user/contact] First name",
      },
      last_name: {
        type: "string",
        description: "[user/contact] Last name",
      },
      email: {
        type: "string",
        description: "[user/contact/group] Email address",
      },
      active: {
        type: "boolean",
        description: "[user/group/contact] Active status",
        default: true,
      },
      department: {
        type: "string",
        description: "[user] Department sys_id or name",
      },
      location: {
        type: "string",
        description: "[user/ci/asset] Location sys_id or name",
      },
      manager: {
        type: "string",
        description: "[user/group] Manager sys_id or username",
      },
      title: {
        type: "string",
        description: "[user/contact] Job title",
      },
      phone: {
        type: "string",
        description: "[user/contact/account] Phone number",
      },

      // ==================== GROUP HELPER SHORTCUTS ====================
      name: {
        type: "string",
        description: "[group/ci/asset/account] Name",
      },

      // ==================== CI HELPER SHORTCUTS ====================
      ip_address: {
        type: "string",
        description: "[ci/server/computer] IP address",
      },
      mac_address: {
        type: "string",
        description: "[ci] MAC address",
      },
      os: {
        type: "string",
        description: "[server/computer] Operating system",
      },
      os_version: {
        type: "string",
        description: "[server/computer] OS version",
      },
      operational_status: {
        type: "number",
        description: "[ci] 1=Operational, 2=Non-Operational, 3=Repair, 4=Retired",
        enum: [1, 2, 3, 4],
      },
      install_status: {
        type: "number",
        description: "[ci/asset] 1=Installed, 2=In Stock, 3=On Order, 6=In Maintenance, 7=Retired",
        enum: [1, 2, 3, 6, 7],
      },
      support_group: {
        type: "string",
        description: "[ci] Support group sys_id or name",
      },
      manufacturer: {
        type: "string",
        description: "[ci] Manufacturer sys_id or name",
      },
      model_id: {
        type: "string",
        description: "[ci] Model sys_id or name",
      },
      serial_number: {
        type: "string",
        description: "[ci/asset] Serial number",
      },
      cpu_count: {
        type: "number",
        description: "[server] Number of CPUs",
      },
      cpu_type: {
        type: "string",
        description: "[server/computer] CPU type",
      },
      ram: {
        type: "number",
        description: "[server/computer] RAM in MB",
      },
      disk_space: {
        type: "number",
        description: "[server] Disk space in GB",
      },

      // ==================== CI RELATIONSHIP SHORTCUTS ====================
      parent: {
        type: "string",
        description: "[ci_relationship/project_task/hr_task] Parent CI/record sys_id",
      },
      child: {
        type: "string",
        description: "[ci_relationship] Child CI sys_id",
      },
      relationship_type: {
        type: "string",
        description: "[ci_relationship] Relationship type sys_id or name",
      },

      // ==================== ASSET HELPER SHORTCUTS ====================
      display_name: {
        type: "string",
        description: "[asset] Display name",
      },
      asset_tag: {
        type: "string",
        description: "[asset] Asset tag",
      },
      model: {
        type: "string",
        description: "[asset] Model sys_id or name",
      },
      cost: {
        type: "number",
        description: "[asset] Cost",
      },
      acquisition_method: {
        type: "string",
        description: "[asset] Acquisition method",
      },
      vendor: {
        type: "string",
        description: "[asset/purchase_order] Vendor sys_id or name",
      },
      warranty_expiration: {
        type: "string",
        description: "[asset] Warranty expiration date (YYYY-MM-DD)",
      },

      // ==================== HR/CSM HELPER SHORTCUTS ====================
      hr_service: {
        type: "string",
        description: "[hr_case] HR Service sys_id or name",
      },
      opened_for: {
        type: "string",
        description: "[hr_case] Opened for user sys_id or username",
      },
      account: {
        type: "string",
        description: "[customer_case/contact] Customer account sys_id or name",
      },
      contact: {
        type: "string",
        description: "[customer_case] Customer contact sys_id or name",
      },
      product: {
        type: "string",
        description: "[customer_case] Product sys_id or name",
      },
      account_code: {
        type: "string",
        description: "[customer_account] Account code",
      },
      primary_contact: {
        type: "string",
        description: "[customer_account] Primary contact sys_id or name",
      },
      city: {
        type: "string",
        description: "[customer_account] City",
      },
      country: {
        type: "string",
        description: "[customer_account] Country",
      },
      website: {
        type: "string",
        description: "[customer_account] Website URL",
      },

      // ==================== PROJECT HELPER SHORTCUTS ====================
      project_manager: {
        type: "string",
        description: "[project] Project manager sys_id or username",
      },
      percent_complete: {
        type: "number",
        description: "[project/project_task] Percent complete (0-100)",
      },
      primary_goal: {
        type: "string",
        description: "[project] Primary goal",
      },

      // ==================== KNOWLEDGE HELPER SHORTCUTS ====================
      text: {
        type: "string",
        description: "[knowledge_article] Article body/content",
      },
      kb_knowledge_base: {
        type: "string",
        description: "[knowledge_article] Knowledge base sys_id or name",
      },
      author: {
        type: "string",
        description: "[knowledge_article] Author sys_id or username",
      },
      workflow_state: {
        type: "string",
        description: "[knowledge_article] Workflow state",
        enum: ["draft", "review", "published", "retired"],
      },
      valid_to: {
        type: "string",
        description: "[knowledge_article] Valid until date (YYYY-MM-DD)",
      },

      // ==================== AUTO FEATURES ====================
      auto_assign: {
        type: "boolean",
        description: "[incident/change/problem] Auto-assign based on category and assignment rules",
        default: false,
      },

      // ==================== QUERY parameters ====================
      query: {
        type: "string",
        description: '[query] Encoded query string (e.g., "state=1^priority<=2^active=true")',
      },
      limit: {
        type: "number",
        description: "[query] Maximum records to return (default: 20, max: 1000)",
        default: 20,
      },
      offset: {
        type: "number",
        description: "[query] Number of records to skip for pagination",
        default: 0,
      },
      order_by: {
        type: "string",
        description: "[query] Field to order by (prefix with - for descending)",
      },
      fields: {
        type: "string",
        description: "[get/query] Comma-separated fields to return",
      },

      // ==================== Common options ====================
      display_value: {
        type: "boolean",
        description: "Return display values instead of sys_ids",
        default: true,
      },
      validate_references: {
        type: "boolean",
        description: "[create] Validate reference fields exist",
        default: true,
      },
      check_version: {
        type: "boolean",
        description: "[update] Perform optimistic locking check",
        default: false,
      },
      expected_version: {
        type: "string",
        description: "[update] Expected sys_mod_count for optimistic locking",
      },
      check_references: {
        type: "boolean",
        description: "[delete] Check for dependent records",
        default: true,
      },
      soft_delete: {
        type: "boolean",
        description: "[delete] Mark as inactive instead of hard delete",
        default: false,
      },
      force: {
        type: "boolean",
        description: "[delete] Force deletion even with dependencies",
        default: false,
      },
    },
    required: ["action", "table"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  var action = args.action
  var table = args.table

  // Resolve table from preset
  var resolvedTable = resolveTable(table)

  try {
    switch (action) {
      case "create":
        return await executeCreate(args, context, resolvedTable)
      case "get":
        return await executeGet(args, context, resolvedTable)
      case "update":
        return await executeUpdate(args, context, resolvedTable)
      case "delete":
        return await executeDelete(args, context, resolvedTable)
      case "query":
        return await executeQuery(args, context, resolvedTable)
      default:
        return createErrorResult("Unknown action: " + action + ". Valid actions: create, get, update, delete, query")
    }
  } catch (error: any) {
    return createErrorResult(
      error instanceof SnowFlowError
        ? error
        : new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, "Record " + action + " failed: " + error.message, {
            originalError: error,
            details: { table: resolvedTable.table },
          }),
    )
  }
}

function resolveTable(tableName: string): {
  table: string
  label: string
  defaultFields: string[]
  numberField: string
  isPreset: boolean
} {
  var preset = TABLE_PRESETS[tableName.toLowerCase()]
  if (preset) {
    return {
      table: preset.table,
      label: preset.label,
      defaultFields: preset.defaultFields,
      numberField: preset.numberField || "number",
      isPreset: true,
    }
  }

  return {
    table: tableName,
    label: tableName,
    defaultFields: ["sys_id", "sys_created_on", "sys_updated_on"],
    numberField: "number",
    isPreset: false,
  }
}

// Build record data from args, merging helper shortcuts with data object
function buildRecordData(args: any, tableKey: string): any {
  var data = args.data ? { ...args.data } : {}

  // Get helper fields for this table type
  var helperFields = HELPER_FIELDS[tableKey] || HELPER_FIELDS[tableKey.toLowerCase()] || []

  // Also include common fields
  var commonFields = [
    "short_description",
    "description",
    "assignment_group",
    "assigned_to",
    "state",
    "active",
    "work_notes",
    "comments",
  ]

  var allHelperFields = [...new Set([...helperFields, ...commonFields])]

  // Merge helper shortcut params into data (shortcuts take precedence)
  for (var i = 0; i < allHelperFields.length; i++) {
    var field = allHelperFields[i]
    if (args[field] !== undefined && args[field] !== null) {
      data[field] = args[field]
    }
  }

  // Handle special mappings
  if (args.configuration_item !== undefined) {
    data.cmdb_ci = args.configuration_item
  }
  if (args.relationship_type !== undefined) {
    data.type = args.relationship_type
  }

  return data
}

// ==================== CREATE ====================
async function executeCreate(args: any, context: ServiceNowContext, tableInfo: any): Promise<ToolResult> {
  var table = tableInfo.table
  var tableKey = args.table.toLowerCase()
  var display_value = args.display_value !== false
  var validate_references = args.validate_references !== false
  var auto_assign = args.auto_assign === true

  // Build data from helper shortcuts + data object
  var data = buildRecordData(args, tableKey)

  if (Object.keys(data).length === 0) {
    return createErrorResult(
      "No data provided. Use helper shortcuts (short_description, priority, etc.) or data object.",
    )
  }

  var client = await getAuthenticatedClient(context)

  // Apply defaults based on table type
  if (tableKey === "incident") {
    if (data.urgency === undefined) data.urgency = 3
    if (data.impact === undefined) data.impact = 3
  }

  if (tableKey === "change" || tableKey === "change_request") {
    if (data.type === undefined) data.type = "normal"
    if (data.risk === undefined) data.risk = 4
  }

  // Auto-assign logic for incidents
  if (auto_assign && (tableKey === "incident" || tableKey === "change" || tableKey === "problem")) {
    var assignmentResult = await performAutoAssignment(client, table, data)
    if (assignmentResult.assignment_group) {
      data.assignment_group = assignmentResult.assignment_group
    }
    if (assignmentResult.assigned_to) {
      data.assigned_to = assignmentResult.assigned_to
    }
  }

  // Resolve reference fields (user names to sys_ids, group names to sys_ids)
  data = await resolveReferenceFields(client, table, data)

  // Validate table exists
  var tableCheck = await client.get("/api/now/table/sys_db_object", {
    params: {
      sysparm_query: "name=" + table,
      sysparm_fields: "name,label",
      sysparm_limit: 1,
    },
  })

  if (!tableCheck.data.result || tableCheck.data.result.length === 0) {
    throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "Table '" + table + "' does not exist.", {
      details: { table: table, available_presets: TABLE_PRESET_NAMES.slice(0, 20) },
    })
  }

  // Validate reference fields if requested
  if (validate_references) {
    var fieldsResponse = await client.get("/api/now/table/sys_dictionary", {
      params: {
        sysparm_query: "name=" + table + "^internal_type=reference",
        sysparm_fields: "element,reference",
        sysparm_limit: 1000,
      },
    })

    for (var j = 0; j < (fieldsResponse.data.result || []).length; j++) {
      var field = fieldsResponse.data.result[j]
      var fieldName = field.element
      var referenceTable = field.reference

      if (data[fieldName]) {
        try {
          var refCheck = await client.get("/api/now/table/" + referenceTable + "/" + data[fieldName], {
            params: { sysparm_fields: "sys_id" },
          })

          if (!refCheck.data.result) {
            throw new SnowFlowError(
              ErrorType.VALIDATION_ERROR,
              "Reference validation failed: Field '" + fieldName + "' points to non-existent record.",
              { details: { field: fieldName, value: data[fieldName], reference_table: referenceTable } },
            )
          }
        } catch (refError: any) {
          if (refError instanceof SnowFlowError) {
            throw refError
          }
        }
      }
    }
  }

  // Create record
  try {
    var response = await client.post("/api/now/table/" + table, data, {
      params: {
        sysparm_display_value: display_value ? "all" : "false",
        sysparm_exclude_reference_link: "true",
      },
    })

    var record = response.data.result
    var numberValue = record[tableInfo.numberField] || record.number || record.name || record.sys_id

    var result: any = {
      action: "create",
      created: true,
      sys_id: getFieldValue(record.sys_id),
      table: table,
      table_label: tableInfo.label,
      record: record,
      url: context.instanceUrl + "/nav_to.do?uri=" + table + ".do?sys_id=" + getFieldValue(record.sys_id),
    }

    result[tableInfo.numberField] = getFieldValue(numberValue)

    if (auto_assign) {
      result.auto_assigned = true
      if (data.assignment_group) result.assigned_group = data.assignment_group
      if (data.assigned_to) result.assigned_user = data.assigned_to
    }

    return createSuccessResult(result)
  } catch (createError: any) {
    var snowError = createError.response?.data?.error || {}
    var errorMessage = snowError.message || createError.message

    throw new SnowFlowError(
      ErrorType.VALIDATION_ERROR,
      "Failed to create record in '" + tableInfo.label + "': " + errorMessage,
      { details: { table: table, data: data, snow_error: snowError } },
    )
  }
}

// ==================== GET ====================
async function executeGet(args: any, context: ServiceNowContext, tableInfo: any): Promise<ToolResult> {
  var table = tableInfo.table
  var sys_id = args.sys_id
  var number = args.number
  var fields = args.fields
  var display_value = args.display_value !== false

  if (!sys_id && !number) {
    return createErrorResult("sys_id or number is required for get action")
  }

  var client = await getAuthenticatedClient(context)
  var record: any = null

  var fieldList = fields || tableInfo.defaultFields.join(",")

  if (sys_id) {
    try {
      var response = await client.get("/api/now/table/" + table + "/" + sys_id, {
        params: {
          sysparm_fields: fieldList,
          sysparm_display_value: display_value ? "all" : "false",
        },
      })
      record = response.data.result
    } catch (e) {
      // Not found
    }
  }

  if (!record && number) {
    var numberField = tableInfo.numberField || "number"
    var searchResponse = await client.get("/api/now/table/" + table, {
      params: {
        sysparm_query: numberField + "=" + number,
        sysparm_fields: fieldList,
        sysparm_display_value: display_value ? "all" : "false",
        sysparm_limit: 1,
      },
    })

    if (searchResponse.data.result && searchResponse.data.result.length > 0) {
      record = searchResponse.data.result[0]
    }
  }

  if (!record) {
    return createErrorResult(tableInfo.label + " not found: " + (sys_id || number))
  }

  var result: any = {
    action: "get",
    found: true,
    sys_id: getFieldValue(record.sys_id),
    table: table,
    table_label: tableInfo.label,
    record: record,
    url: context.instanceUrl + "/nav_to.do?uri=" + table + ".do?sys_id=" + record.sys_id,
  }

  result[tableInfo.numberField] = getFieldValue(record[tableInfo.numberField] || record.number || record.name)

  return createSuccessResult(result)
}

// ==================== UPDATE ====================
async function executeUpdate(args: any, context: ServiceNowContext, tableInfo: any): Promise<ToolResult> {
  var table = tableInfo.table
  var tableKey = args.table.toLowerCase()
  var sys_id = args.sys_id
  var display_value = args.display_value !== false
  var check_version = args.check_version === true
  var expected_version = args.expected_version

  if (!sys_id) {
    return createErrorResult("sys_id is required for update action")
  }

  var data = buildRecordData(args, tableKey)

  if (Object.keys(data).length === 0) {
    return createErrorResult("No data provided for update.")
  }

  var client = await getAuthenticatedClient(context)

  // Resolve reference fields
  data = await resolveReferenceFields(client, table, data)

  // Get current record
  var currentRecord = await client.get("/api/now/table/" + table + "/" + sys_id, {
    params: { sysparm_fields: check_version ? "sys_id,sys_mod_count" : "sys_id" },
  })

  if (!currentRecord.data.result) {
    throw new SnowFlowError(ErrorType.NOT_FOUND_ERROR, tableInfo.label + " not found with sys_id '" + sys_id + "'", {
      details: { table: table, sys_id: sys_id },
    })
  }

  // Optimistic locking
  if (check_version && expected_version) {
    var currentVersion = currentRecord.data.result.sys_mod_count
    if (currentVersion !== expected_version) {
      throw new SnowFlowError(
        ErrorType.VALIDATION_ERROR,
        "Record has been modified by another user (optimistic lock conflict)",
        { details: { expected_version: expected_version, current_version: currentVersion } },
      )
    }
  }

  // Update record
  var response = await client.patch("/api/now/table/" + table + "/" + sys_id, data, {
    params: {
      sysparm_display_value: display_value ? "all" : "false",
      sysparm_exclude_reference_link: "true",
    },
  })

  var updatedRecord = response.data.result
  var changedFields = Object.keys(data)

  var result: any = {
    action: "update",
    updated: true,
    sys_id: getFieldValue(updatedRecord.sys_id),
    table: table,
    table_label: tableInfo.label,
    changed_fields: changedFields,
    record: updatedRecord,
    new_version: getFieldValue(updatedRecord.sys_mod_count),
    url: context.instanceUrl + "/nav_to.do?uri=" + table + ".do?sys_id=" + getFieldValue(updatedRecord.sys_id),
  }

  result[tableInfo.numberField] = getFieldValue(
    updatedRecord[tableInfo.numberField] || updatedRecord.number || updatedRecord.name,
  )

  return createSuccessResult(result)
}

// ==================== DELETE ====================
async function executeDelete(args: any, context: ServiceNowContext, tableInfo: any): Promise<ToolResult> {
  var table = tableInfo.table
  var sys_id = args.sys_id
  var check_references = args.check_references !== false
  var soft_delete = args.soft_delete === true
  var force = args.force === true

  if (!sys_id) {
    return createErrorResult("sys_id is required for delete action")
  }

  var client = await getAuthenticatedClient(context)

  var recordCheck = await client.get("/api/now/table/" + table + "/" + sys_id, {
    params: { sysparm_fields: "sys_id," + tableInfo.numberField },
  })

  if (!recordCheck.data.result) {
    throw new SnowFlowError(ErrorType.NOT_FOUND_ERROR, tableInfo.label + " not found with sys_id '" + sys_id + "'", {
      details: { table: table, sys_id: sys_id },
    })
  }

  var recordInfo = recordCheck.data.result

  // Check dependencies
  var dependencies: any[] = []
  if (check_references && !force) {
    var refFieldsResponse = await client.get("/api/now/table/sys_dictionary", {
      params: {
        sysparm_query: "reference=" + table + "^internal_type=reference",
        sysparm_fields: "name,element",
        sysparm_limit: 100,
      },
    })

    for (var k = 0; k < (refFieldsResponse.data.result || []).length; k++) {
      var refField = refFieldsResponse.data.result[k]
      try {
        var dependentRecords = await client.get("/api/now/table/" + refField.name, {
          params: {
            sysparm_query: refField.element + "=" + sys_id,
            sysparm_fields: "sys_id,number",
            sysparm_limit: 5,
          },
        })

        if (dependentRecords.data.result && dependentRecords.data.result.length > 0) {
          dependencies.push({
            table: refField.name,
            field: refField.element,
            count: dependentRecords.data.result.length,
          })
        }
      } catch (e) {
        // Ignore
      }
    }

    if (dependencies.length > 0) {
      throw new SnowFlowError(
        ErrorType.VALIDATION_ERROR,
        "Cannot delete " + tableInfo.label + " with dependencies. Use force=true to override.",
        { details: { dependencies: dependencies } },
      )
    }
  }

  if (soft_delete) {
    var hasActiveField = await client.get("/api/now/table/sys_dictionary", {
      params: {
        sysparm_query: "name=" + table + "^element=active",
        sysparm_fields: "element",
        sysparm_limit: 1,
      },
    })

    if (hasActiveField.data.result && hasActiveField.data.result.length > 0) {
      await client.patch("/api/now/table/" + table + "/" + sys_id, { active: "false" })

      var softResult: any = {
        action: "delete",
        deleted: true,
        soft_delete: true,
        sys_id: sys_id,
        table: table,
        table_label: tableInfo.label,
        message: tableInfo.label + " marked as inactive (soft delete)",
      }
      softResult[tableInfo.numberField] = getFieldValue(recordInfo[tableInfo.numberField] || recordInfo.number)

      return createSuccessResult(softResult)
    } else {
      throw new SnowFlowError(
        ErrorType.VALIDATION_ERROR,
        "Table '" + table + "' does not support soft delete (no 'active' field)",
        { details: { table: table } },
      )
    }
  }

  // Hard delete
  await client.delete("/api/now/table/" + table + "/" + sys_id)

  var hardResult: any = {
    action: "delete",
    deleted: true,
    soft_delete: false,
    sys_id: sys_id,
    table: table,
    table_label: tableInfo.label,
    message: tableInfo.label + " permanently deleted",
    forced: force && dependencies.length > 0,
  }
  hardResult[tableInfo.numberField] = getFieldValue(recordInfo[tableInfo.numberField] || recordInfo.number)

  return createSuccessResult(hardResult)
}

// ==================== QUERY ====================
async function executeQuery(args: any, context: ServiceNowContext, tableInfo: any): Promise<ToolResult> {
  var table = tableInfo.table
  var query = args.query || ""
  var limit = args.limit || 20
  var offset = args.offset || 0
  var order_by = args.order_by
  var fields = args.fields
  var display_value = args.display_value !== false

  var client = await getAuthenticatedClient(context)

  var fieldList = fields || tableInfo.defaultFields.join(",")

  var params: any = {
    sysparm_limit: Math.min(limit, 1000),
    sysparm_offset: offset,
    sysparm_fields: fieldList,
    sysparm_display_value: display_value ? "all" : "false",
    sysparm_exclude_reference_link: "true",
  }

  if (query) {
    params.sysparm_query = query
  }

  if (order_by) {
    if (order_by.charAt(0) === "-") {
      params.sysparm_query =
        (params.sysparm_query ? params.sysparm_query + "^" : "") + "ORDERBYDESC" + order_by.substring(1)
    } else {
      params.sysparm_query = (params.sysparm_query ? params.sysparm_query + "^" : "") + "ORDERBY" + order_by
    }
  }

  var response = await client.get("/api/now/table/" + table, { params: params })
  var records = response.data.result || []

  // Get total count
  var countParams: any = { sysparm_count: true }
  if (query) {
    countParams.sysparm_query = query
  }
  var countResponse = await client.get("/api/now/table/" + table, { params: countParams })
  var totalCount = parseInt(countResponse.headers["x-total-count"] || "0", 10)

  // Build human-readable summary for display
  var summaryLines: string[] = []
  summaryLines.push("✓ Query completed")
  summaryLines.push("  table: " + table)
  summaryLines.push("  Records: " + records.length + (totalCount > records.length ? " of " + totalCount : ""))

  // Format each record for display
  var maxDisplay = Math.min(records.length, 10)
  for (var i = 0; i < maxDisplay; i++) {
    var r = records[i]
    // Get the primary identifier for display
    var identifier =
      getFieldValue(r[tableInfo.numberField]) ||
      getFieldValue(r.number) ||
      getFieldValue(r.name) ||
      getFieldValue(r.sys_id)

    // Get a secondary field for context (short_description, description, etc.)
    var description =
      getFieldValue(r.short_description) ||
      getFieldValue(r.description) ||
      getFieldValue(r.title) ||
      getFieldValue(r.label) ||
      ""

    // Build display line
    var displayLine = "  • " + identifier
    if (description) {
      // Truncate long descriptions
      var truncatedDesc = description.length > 50 ? description.substring(0, 47) + "..." : description
      displayLine += " - " + truncatedDesc
    }
    summaryLines.push(displayLine)
  }

  if (records.length > maxDisplay) {
    summaryLines.push("  ... and " + (records.length - maxDisplay) + " more")
  }

  if (totalCount > records.length) {
    summaryLines.push("  (Use offset=" + (offset + records.length) + " to get next page)")
  }

  return createSuccessResult(
    {
      action: "query",
      table: table,
      table_label: tableInfo.label,
      count: records.length,
      total_count: totalCount,
      offset: offset,
      limit: limit,
      has_more: offset + records.length < totalCount,
      query: query || "(all records)",
      records: records.map(function (r: any) {
        var rec: any = {
          sys_id: getFieldValue(r.sys_id),
          ...r,
          _url: context.instanceUrl + "/nav_to.do?uri=" + table + ".do?sys_id=" + getFieldValue(r.sys_id),
        }
        rec[tableInfo.numberField] = getFieldValue(r[tableInfo.numberField] || r.number || r.name)
        return rec
      }),
    },
    {},
    summaryLines.join("\n"),
  )
}

// ==================== HELPER FUNCTIONS ====================

// Resolve user names and group names to sys_ids
async function resolveReferenceFields(client: any, table: string, data: any): Promise<any> {
  var resolved = { ...data }

  // Resolve user fields
  var userFields = [
    "caller_id",
    "assigned_to",
    "opened_for",
    "manager",
    "project_manager",
    "author",
    "contact",
    "primary_contact",
    "requested_for",
  ]
  for (var i = 0; i < userFields.length; i++) {
    var field = userFields[i]
    if (resolved[field] && !isValidSysId(resolved[field])) {
      var userSysId = await resolveUser(client, resolved[field])
      if (userSysId) {
        resolved[field] = userSysId
      }
    }
  }

  // Resolve group fields
  var groupFields = ["assignment_group", "support_group"]
  for (var j = 0; j < groupFields.length; j++) {
    var gField = groupFields[j]
    if (resolved[gField] && !isValidSysId(resolved[gField])) {
      var groupSysId = await resolveGroup(client, resolved[gField])
      if (groupSysId) {
        resolved[gField] = groupSysId
      }
    }
  }

  // Resolve CI/cmdb_ci
  if (resolved.cmdb_ci && !isValidSysId(resolved.cmdb_ci)) {
    var ciSysId = await resolveCI(client, resolved.cmdb_ci)
    if (ciSysId) {
      resolved.cmdb_ci = ciSysId
    }
  }

  // Resolve department
  if (resolved.department && !isValidSysId(resolved.department)) {
    var deptSysId = await resolveDepartment(client, resolved.department)
    if (deptSysId) {
      resolved.department = deptSysId
    }
  }

  // Resolve location
  if (resolved.location && !isValidSysId(resolved.location)) {
    var locSysId = await resolveLocation(client, resolved.location)
    if (locSysId) {
      resolved.location = locSysId
    }
  }

  return resolved
}

function isValidSysId(value: string): boolean {
  // ServiceNow sys_ids are 32 character hex strings
  return /^[a-f0-9]{32}$/i.test(value)
}

async function resolveUser(client: any, identifier: string): Promise<string | null> {
  try {
    var response = await client.get("/api/now/table/sys_user", {
      params: {
        sysparm_query: "user_name=" + identifier + "^ORemail=" + identifier + "^ORname=" + identifier,
        sysparm_fields: "sys_id",
        sysparm_limit: 1,
      },
    })
    if (response.data.result && response.data.result.length > 0) {
      return response.data.result[0].sys_id
    }
  } catch (e) {
    // Ignore
  }
  return null
}

async function resolveGroup(client: any, identifier: string): Promise<string | null> {
  try {
    var response = await client.get("/api/now/table/sys_user_group", {
      params: {
        sysparm_query: "name=" + identifier,
        sysparm_fields: "sys_id",
        sysparm_limit: 1,
      },
    })
    if (response.data.result && response.data.result.length > 0) {
      return response.data.result[0].sys_id
    }
  } catch (e) {
    // Ignore
  }
  return null
}

async function resolveCI(client: any, identifier: string): Promise<string | null> {
  try {
    var response = await client.get("/api/now/table/cmdb_ci", {
      params: {
        sysparm_query: "name=" + identifier,
        sysparm_fields: "sys_id",
        sysparm_limit: 1,
      },
    })
    if (response.data.result && response.data.result.length > 0) {
      return response.data.result[0].sys_id
    }
  } catch (e) {
    // Ignore
  }
  return null
}

async function resolveDepartment(client: any, identifier: string): Promise<string | null> {
  try {
    var response = await client.get("/api/now/table/cmn_department", {
      params: {
        sysparm_query: "name=" + identifier,
        sysparm_fields: "sys_id",
        sysparm_limit: 1,
      },
    })
    if (response.data.result && response.data.result.length > 0) {
      return response.data.result[0].sys_id
    }
  } catch (e) {
    // Ignore
  }
  return null
}

async function resolveLocation(client: any, identifier: string): Promise<string | null> {
  try {
    var response = await client.get("/api/now/table/cmn_location", {
      params: {
        sysparm_query: "name=" + identifier,
        sysparm_fields: "sys_id",
        sysparm_limit: 1,
      },
    })
    if (response.data.result && response.data.result.length > 0) {
      return response.data.result[0].sys_id
    }
  } catch (e) {
    // Ignore
  }
  return null
}

// Auto-assignment based on category/assignment rules
async function performAutoAssignment(
  client: any,
  table: string,
  data: any,
): Promise<{ assignment_group?: string; assigned_to?: string }> {
  var result: { assignment_group?: string; assigned_to?: string } = {}

  // If category is specified, try to find matching assignment rule
  if (data.category) {
    try {
      // Look for assignment rules matching this category
      var rulesResponse = await client.get("/api/now/table/sysrule_assignment", {
        params: {
          sysparm_query: "table=" + table + "^active=true^conditionLIKEcategory=" + data.category,
          sysparm_fields: "group,user",
          sysparm_limit: 1,
        },
      })

      if (rulesResponse.data.result && rulesResponse.data.result.length > 0) {
        var rule = rulesResponse.data.result[0]
        if (rule.group) {
          result.assignment_group = typeof rule.group === "object" ? rule.group.value : rule.group
        }
        if (rule.user) {
          result.assigned_to = typeof rule.user === "object" ? rule.user.value : rule.user
        }
        return result
      }
    } catch (e) {
      // No assignment rules found, continue with fallback
    }
  }

  // Fallback: If no rules match, try to find a default group for this table
  try {
    var defaultGroupResponse = await client.get("/api/now/table/sys_user_group", {
      params: {
        sysparm_query: "nameLIKE" + table + "^active=true",
        sysparm_fields: "sys_id,name",
        sysparm_limit: 1,
      },
    })

    if (defaultGroupResponse.data.result && defaultGroupResponse.data.result.length > 0) {
      result.assignment_group = defaultGroupResponse.data.result[0].sys_id
    }
  } catch (e) {
    // Ignore
  }

  return result
}

export var version = "4.0.0"
export var author = "Serac v8.3.0 Tool Consolidation"
