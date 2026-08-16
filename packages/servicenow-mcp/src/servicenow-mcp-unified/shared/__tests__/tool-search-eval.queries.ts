/**
 * Retrieval fixture for `ToolSearch.search` — see `tool-search-eval.test.ts`.
 *
 * Each entry is a request phrased the way a person (or the model relaying for
 * them) would actually type it, paired with the tool(s) from `tools.json` that
 * should come back. Queries deliberately do NOT echo tool ids: a query built
 * out of the tool's own name measures the index's ability to find a string it
 * already contains, which is not the thing that decides whether a session
 * reaches the right tool.
 *
 * `expected` lists more than one tool only where the catalog genuinely has
 * near-duplicates for the same intent (snow_create_acl vs
 * snow_create_access_control, three separate attachment uploaders, …). Any of
 * them is a correct answer, so a hit on any of them counts. It is not a place
 * to widen the target until the number looks better.
 *
 * Every name here is asserted to exist in `tools.json` before scoring, so a
 * renamed or deleted tool fails the suite instead of silently counting as a
 * retrieval miss.
 */

export const EVAL_QUERIES = [
  // Records, tasks, SLAs
  { query: "find all P1 incidents opened last week", expected: ["snow_query_table", "snow_record_manage"] },
  { query: "close the incident and fill in the resolution notes", expected: ["snow_record_manage"] },
  { query: "add a work note to a ticket", expected: ["snow_add_comment"] },
  { query: "pull up a record when all I have is its sys_id", expected: ["snow_get_by_sysid"] },
  { query: "set the assignment group on 200 old tickets at once", expected: ["snow_bulk_update"] },
  { query: "give this task to whoever has the lightest workload", expected: ["snow_assign_task"] },
  { query: "are we about to breach the response target on this ticket", expected: ["snow_get_sla_status", "snow_sla_manage"] },
  { query: "define a four hour response target for priority 1", expected: ["snow_create_sla_definition", "snow_create_sla"] },

  // Change and approvals
  { query: "raise a normal change for the firewall upgrade", expected: ["snow_change_manage"] },
  { query: "how risky is this change", expected: ["snow_change_query"] },
  { query: "show the approvals still waiting on me", expected: ["snow_get_pending_approvals"] },
  { query: "sign this off and add a comment", expected: ["snow_approve_reject"] },
  { query: "ask the line manager to authorise this record", expected: ["snow_request_approval"] },

  // Platform configuration
  { query: "add a field to the change request form", expected: ["snow_add_form_field", "snow_create_field"] },
  { query: "new column on the incident table for the vendor ticket number", expected: ["snow_create_field"] },
  { query: "make assignment group mandatory when priority is 1", expected: ["snow_create_ui_policy", "snow_create_ui_policy_action"] },
  { query: "run some server side logic before every insert on sc_task", expected: ["snow_create_business_rule"] },
  { query: "I want a reusable function I can call from several scripts", expected: ["snow_create_script_include"] },
  { query: "put a button on the incident form that closes the record", expected: ["snow_create_ui_action"] },
  { query: "hide a field on the form when the category changes", expected: ["snow_create_client_script"] },
  { query: "make a new table that extends task", expected: ["snow_create_table"] },
  { query: "turn off that business rule without deleting it", expected: ["snow_disable_business_rule"] },
  { query: "what columns does cmdb_ci_server have", expected: ["snow_discover_table_fields", "snow_table_schema_discovery"] },
  { query: "keep the field read only even for imports and API writes", expected: ["snow_create_data_policy", "snow_create_data_policy_rule"] },
  { query: "save a set of prefilled values people can reuse on new records", expected: ["snow_create_template", "snow_apply_template"] },

  // Scripting and execution
  { query: "run this javascript against the instance and show me the output", expected: ["snow_execute_script"] },
  { query: "my script uses arrow functions and the instance throws a syntax error", expected: ["snow_convert_es6_to_es5", "snow_convert_to_es5"] },
  { query: "look for anti patterns in our scripts", expected: ["snow_detect_code_patterns"] },

  // Search, dependencies, impact
  { query: "find every script that calls GlideAjax", expected: ["snow_code_search"] },
  { query: "what breaks if I change this script include", expected: ["snow_blast_radius_dependents"] },
  { query: "which artifacts still read the u_vendor_ticket column", expected: ["snow_blast_radius_field_references"] },
  { query: "list everything that runs on the sc_req_item table", expected: ["snow_blast_radius_table_configs"] },
  { query: "was this widget already picked up in an update set", expected: ["snow_blast_radius_update_sets"] },
  // Genuinely ambiguous: the honest answers are "see what is configured on the
  // table", "look at the form's own config", or "read the logs".
  { query: "why did this business rule not fire", expected: ["snow_analyze_form", "snow_blast_radius_table_configs", "snow_get_logs"] },
  { query: "find the widget we built for the employee portal", expected: ["snow_search_artifacts"] },

  // Flow Designer and legacy workflow
  { query: "build something that emails the manager when a request is submitted", expected: ["snow_manage_flow"] },
  { query: "it says it ran but nothing happened", expected: ["snow_get_flow_execution_logs"] },
  { query: "custom Flow Designer action that calls our own API", expected: ["snow_create_flow_action"] },

  // Notifications
  { query: "email the assigned user about the outage", expected: ["snow_send_email", "snow_send_notification"] },
  { query: "automatically mail the on call team whenever a P1 comes in", expected: ["snow_create_notification", "snow_email_notification_manage"] },
  { query: "did that mail actually go out yesterday", expected: ["snow_get_email_logs"] },
  { query: "tell everyone in the company the datacenter is down", expected: ["snow_emergency_broadcast"] },
  { query: "alert people on their phones", expected: ["snow_send_push_notification", "snow_send_push"] },

  // Service catalog
  { query: "publish a new laptop request people can order", expected: ["snow_create_catalog_item"] },
  { query: "add a dropdown question to the laptop request", expected: ["snow_create_catalog_variable", "snow_create_variable"] },
  { query: "order that for a user without going through the portal", expected: ["snow_order_catalog_item"] },
  { query: "what can employees request for onboarding", expected: ["snow_search_catalog", "snow_catalog_item_search"] },
  { query: "hide a question on the order form unless another answer is yes", expected: ["snow_create_catalog_ui_policy"] },

  // Security, users, roles
  { query: "why can this user not see the record", expected: ["snow_test_acl", "snow_impersonate_user"] },
  { query: "give the itil role write access to our custom table", expected: ["snow_create_access_control", "snow_create_acl"] },
  { query: "what roles does this user have", expected: ["snow_get_user_roles"] },
  { query: "put someone in the network support group", expected: ["snow_manage_group_membership", "snow_role_group_manage"] },
  { query: "create an account for a new contractor", expected: ["snow_user_manage"] },
  { query: "I need elevated rights to change an ACL", expected: ["snow_elevate_role"] },

  // Update sets, scope, deployment
  { query: "which update set are my changes going into", expected: ["snow_update_set_query", "snow_update_set_manage"] },
  { query: "copy this widget from dev to test", expected: ["snow_clone_instance_artifact"] },
  { query: "check the artifact for ES5 and dependency problems before it goes live", expected: ["snow_validate_deployment"] },
  { query: "the release broke something, put it back", expected: ["snow_rollback_deployment"] },
  { query: "which application scope am I working in", expected: ["snow_get_current_scope"] },

  // Monitoring and logs
  { query: "show me the errors from the last hour", expected: ["snow_get_logs"] },
  { query: "our calls out to the vendor keep timing out", expected: ["snow_get_outbound_http_logs"] },
  { query: "the instance is slow, which queries are the worst", expected: ["snow_get_slow_queries"] },
  { query: "did the nightly cleanup run last night", expected: ["snow_get_scheduled_job_logs", "snow_job_status"] },
  { query: "what changed on the instance between 2 and 3 this morning", expected: ["snow_inspect_mutations", "snow_audit_trail_analysis"] },

  // CMDB and discovery
  { query: "find the configuration item for the payroll database", expected: ["snow_search_cmdb", "snow_cmdb_search"] },
  { query: "what services go down if this server fails", expected: ["snow_get_ci_impact", "snow_impact_analysis"] },
  { query: "record that this application runs on that server", expected: ["snow_create_ci_relationship"] },
  { query: "scan this subnet and bring the hardware into the CMDB", expected: ["snow_run_discovery"] },

  // HR, CSM, field service, agile, PPM
  { query: "open an HR case for an address change", expected: ["snow_create_hr_case"] },
  { query: "someone leaves on friday, start the leaver process", expected: ["snow_employee_offboarding"] },
  { query: "log a complaint from a customer account", expected: ["snow_create_customer_case"] },
  { query: "send a technician out to fix the printer on site", expected: ["snow_fsm_work_order_manage", "snow_fsm_dispatch_manage"] },
  { query: "how many story points does the team deliver per sprint", expected: ["snow_agile_velocity_report"] },
  { query: "move this story into the next sprint", expected: ["snow_agile_story_manage", "snow_agile_backlog_groom"] },
  { query: "set up a project with a start date and a project manager", expected: ["snow_create_project"] },

  // Reporting and analytics
  { query: "pie chart of incidents by category", expected: ["snow_create_report"] },
  { query: "mail that report to the managers every monday morning", expected: ["snow_schedule_report_delivery", "snow_report_manage"] },
  { query: "count open incidents grouped by assignment group", expected: ["snow_aggregate_metrics"] },

  // Integration
  { query: "call an external API from ServiceNow", expected: ["snow_create_rest_message", "snow_rest_message_manage"] },
  { query: "install the jira spoke", expected: ["snow_install_spoke"] },
  { query: "store an API key somewhere safe for the integration", expected: ["snow_create_credential_alias"] },
  { query: "can the MID server reach the vendor endpoint", expected: ["snow_test_mid_connectivity"] },
  { query: "load a csv of users into the platform", expected: ["snow_create_import_set", "snow_create_transform_map"] },

  // Testing
  { query: "automated test that fills in a form and submits it", expected: ["snow_create_atf_test", "snow_create_atf_test_step"] },
  { query: "run the regression suite and show me what failed", expected: ["snow_execute_atf_test", "snow_get_atf_results"] },

  // Portal, lists, workspaces
  { query: "build a page where employees can see their own requests", expected: ["snow_create_sp_page"] },
  { query: "write an angularjs widget for the portal", expected: ["snow_create_sp_widget"] },
  { query: "restyle the portal with our brand colours", expected: ["snow_sp_theme_manage"] },
  { query: "show one more column in the default list", expected: ["snow_add_list_column", "snow_create_list_view", "snow_create_list_layout"] },
  { query: "spin up an agent workspace for the service desk", expected: ["snow_create_complete_workspace", "snow_create_configurable_agent_workspace", "snow_create_workspace"] },

  // Attachments and local utilities
  { query: "attach this file to the ticket", expected: ["snow_file_upload", "snow_upload_attachment", "snow_attach_file"] },
  { query: "get the screenshot off that ticket", expected: ["snow_file_download"] },
  { query: "generate a sys_id for a test record", expected: ["snow_generate_guid"] },
  { query: "what is inside this bearer token", expected: ["snow_jwt_decode"] },
  { query: "build the encoded query for records opened in the last seven days", expected: ["snow_date_filter", "snow_query_filter"] },
  { query: "export the table to csv", expected: ["snow_data_export"] },
  { query: "change a system property value", expected: ["snow_property_manage", "snow_property_manager"] },

  // Virtual agent, knowledge, scheduling
  { query: "chatbot conversation for password reset", expected: ["snow_create_va_topic"] },
  { query: "publish an article about how to set up the vpn", expected: ["snow_knowledge_article_manage"] },
  { query: "run a script every night at 2am", expected: ["snow_schedule_job", "snow_scheduled_job_manage"] },
  { query: "block out the christmas holidays in the business hours", expected: ["snow_add_schedule_entry", "snow_create_schedule"] },
  { query: "who is on call this weekend", expected: ["snow_oncall_manage"] },
]
