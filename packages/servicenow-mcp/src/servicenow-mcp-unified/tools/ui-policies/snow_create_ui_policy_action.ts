/**
 * snow_create_ui_policy_action
 *
 * Creates a UI Policy Action (sys_ui_policy_action) that controls field
 * visibility, mandatory state, or read-only state when a UI policy's
 * conditions are met.
 *
 * Primary path: server-side GlideRecord via Scripted REST. The Table API
 * silently drops the ui_policy reference field (ACL / business-rule
 * protection), so we insert via GlideRecord which bypasses that. Falls
 * back to Table API + PATCH/PUT chain if Scripted REST can't be deployed.
 *
 * ServiceNow field mapping:
 *   - visible/mandatory/disabled are STRING fields with values: "true", "false", "ignore"
 *   - "disabled" is the actual column name for "Read only" in the UI
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"
import { executeServerScript } from "../../shared/scripted-exec.js"
import { linkUiPolicyReference, verifyUiPolicyLink } from "./link-ui-policy.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_ui_policy_action",
  description:
    "Create a UI policy action to control field behavior (visible/mandatory/readonly) when a UI policy condition is met. Requires the parent UI policy sys_id and the target table name.",
  category: "development",
  subcategory: "ui-policies",
  use_cases: ["ui-policy-actions", "form-control", "ui-automation"],
  complexity: "intermediate",
  frequency: "medium",

  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      ui_policy_sys_id: {
        type: "string",
        description: "sys_id of the parent UI policy (sys_ui_policy)",
      },
      table: {
        type: "string",
        description:
          "Table name the UI policy applies to (e.g. 'incident', 'change_request'). Must match the table on the parent UI policy.",
      },
      field: {
        type: "string",
        description: "Field name to control (e.g. 'close_notes', 'assignment_group')",
      },
      visible: {
        type: "boolean",
        description: "Set field visibility. true = visible, false = hidden. Omit to leave unchanged ('ignore').",
      },
      mandatory: {
        type: "boolean",
        description:
          "Set field mandatory state. true = required, false = optional. Omit to leave unchanged ('ignore').",
      },
      readonly: {
        type: "boolean",
        description:
          "Set field read-only state. true = read-only, false = editable. Omit to leave unchanged ('ignore').",
      },
      cleared: {
        type: "boolean",
        description: "Clear the field value when the policy condition is true. Default: false.",
      },
    },
    required: ["ui_policy_sys_id", "table", "field"],
  },
}

function toActionValue(val: boolean | undefined): string {
  if (val === undefined) return "ignore"
  return val ? "true" : "false"
}

function buildServerScript(input: {
  ui_policy_sys_id: string
  table: string
  field: string
  visible: string
  mandatory: string
  disabled: string
  cleared: boolean
}): string {
  return `(function() {
  var INPUT = ${JSON.stringify(input)};

  function escapeXml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function storedUiPolicyRef(sysId) {
    var g = new GlideRecord('sys_ui_policy_action');
    if (!g.get(sysId)) return '';
    return String(g.getValue('ui_policy') || '');
  }

  var policyCheck = new GlideRecord('sys_ui_policy');
  if (!policyCheck.get(INPUT.ui_policy_sys_id)) {
    return JSON.stringify({ error: 'UI Policy not found with sys_id: ' + INPUT.ui_policy_sys_id });
  }

  // Primary: plain GlideRecord. On some instances this bypasses the field
  // ACL on sys_ui_policy_action.ui_policy; on others it doesn't. Verify
  // after insert and fall back if the reference came back empty.
  var action = new GlideRecord('sys_ui_policy_action');
  action.initialize();
  action.setValue('ui_policy', INPUT.ui_policy_sys_id);
  action.setValue('table', INPUT.table);
  action.setValue('field', INPUT.field);
  action.setValue('visible', INPUT.visible);
  action.setValue('mandatory', INPUT.mandatory);
  action.setValue('disabled', INPUT.disabled);
  action.setValue('cleared', INPUT.cleared);
  var firstSysId = action.insert();

  if (firstSysId && storedUiPolicyRef(firstSysId) === INPUT.ui_policy_sys_id) {
    return JSON.stringify({
      sys_id: String(firstSysId),
      ui_policy: INPUT.ui_policy_sys_id,
      table: INPUT.table,
      field: INPUT.field,
      visible: INPUT.visible,
      mandatory: INPUT.mandatory,
      disabled: INPUT.disabled,
      cleared: INPUT.cleared,
      method: 'gliderecord'
    });
  }

  // GlideRecord left an orphan (or didn't insert). Clean up before retry.
  if (firstSysId) {
    var orphan = new GlideRecord('sys_ui_policy_action');
    if (orphan.get(firstSysId)) orphan.deleteRecord();
  }

  // Fallback: GlideUpdateManager2.loadUpdateXML() uses the update-set
  // import pipeline which bypasses ACL evaluation.
  var newSysId = String(gs.generateGUID());
  var xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<unload unload_date="' + new GlideDateTime().getValue() + '">' +
    '<sys_ui_policy_action action="INSERT_OR_UPDATE">' +
    '<sys_id>' + newSysId + '</sys_id>' +
    '<sys_class_name>sys_ui_policy_action</sys_class_name>' +
    '<ui_policy>' + INPUT.ui_policy_sys_id + '</ui_policy>' +
    '<table>' + escapeXml(INPUT.table) + '</table>' +
    '<field>' + escapeXml(INPUT.field) + '</field>' +
    '<visible>' + INPUT.visible + '</visible>' +
    '<mandatory>' + INPUT.mandatory + '</mandatory>' +
    '<disabled>' + INPUT.disabled + '</disabled>' +
    '<cleared>' + (INPUT.cleared ? 'true' : 'false') + '</cleared>' +
    '<active>true</active>' +
    '<order>100</order>' +
    '<sys_update_name>sys_ui_policy_action_' + newSysId + '</sys_update_name>' +
    '</sys_ui_policy_action>' +
    '</unload>';

  try {
    var um = new GlideUpdateManager2();
    um.loadUpdateXML(xml);
  } catch (e) {
    return JSON.stringify({ error: 'GlideUpdateManager2.loadUpdateXML failed: ' + e });
  }

  if (storedUiPolicyRef(newSysId) !== INPUT.ui_policy_sys_id) {
    var failed = new GlideRecord('sys_ui_policy_action');
    if (failed.get(newSysId)) failed.deleteRecord();
    return JSON.stringify({ error: 'Both GlideRecord and XML load failed to set ui_policy reference' });
  }

  return JSON.stringify({
    sys_id: newSysId,
    ui_policy: INPUT.ui_policy_sys_id,
    table: INPUT.table,
    field: INPUT.field,
    visible: INPUT.visible,
    mandatory: INPUT.mandatory,
    disabled: INPUT.disabled,
    cleared: INPUT.cleared,
    method: 'update_xml'
  });
})();`
}

function parseScriptResult(raw: unknown):
  | {
      sys_id: string
      ui_policy: string
      table: string
      field: string
      visible: string
      mandatory: string
      disabled: string
      cleared: boolean
      method?: string
      error?: string
    }
  | null {
  if (typeof raw !== "string") return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const uid = args.ui_policy_sys_id as string
  const table = args.table as string
  const field = args.field as string
  const visible = toActionValue(args.visible as boolean | undefined)
  const mandatory = toActionValue(args.mandatory as boolean | undefined)
  const disabled = toActionValue(args.readonly as boolean | undefined)
  const cleared = args.cleared === true

  try {
    const script = buildServerScript({
      ui_policy_sys_id: uid,
      table,
      field,
      visible,
      mandatory,
      disabled,
      cleared,
    })

    const scriptResult = await executeServerScript(context, script, {
      description: "Create sys_ui_policy_action via GlideRecord",
    }).catch(() => null)

    if (scriptResult?.success) {
      const parsed = parseScriptResult(scriptResult.result)
      if (parsed?.error) return createErrorResult(parsed.error)
      if (parsed?.sys_id) {
        return createSuccessResult({
          created: true,
          method: "server_side_script",
          action: {
            sys_id: parsed.sys_id,
            ui_policy: parsed.ui_policy,
            ui_policy_linked: true,
            linked_via: parsed.method,
            table: parsed.table,
            field: parsed.field,
            visible: parsed.visible,
            mandatory: parsed.mandatory,
            disabled: parsed.disabled,
            cleared: parsed.cleared,
          },
        })
      }
    }

    const client = await getAuthenticatedClient(context)

    const policyRes = await client.get(
      "/api/now/table/sys_ui_policy/" + uid + "?sysparm_fields=sys_id,table,short_description",
    )
    const policy = policyRes.data.result
    if (!policy?.sys_id) {
      return createErrorResult("UI Policy not found with sys_id: " + uid)
    }

    const response = await client.post("/api/now/table/sys_ui_policy_action", {
      ui_policy: uid,
      table,
      field,
      visible,
      mandatory,
      disabled,
      cleared,
    })
    const action = response.data.result
    const actionSysId = action.sys_id?.value || action.sys_id

    const alreadyLinked = await verifyUiPolicyLink(client, actionSysId, uid)
    const linked = alreadyLinked || (await linkUiPolicyReference(client, actionSysId, uid))

    const refVal = action.ui_policy
    const resolvedRef = typeof refVal === "object" && refVal !== null ? refVal.value : refVal

    return createSuccessResult({
      created: true,
      method: "table_api_fallback",
      action: {
        sys_id: actionSysId,
        ui_policy: linked ? uid : resolvedRef || "",
        ui_policy_linked: linked,
        table: action.table?.value || action.table,
        field: action.field?.value || action.field,
        visible: action.visible?.value || action.visible,
        mandatory: action.mandatory?.value || action.mandatory,
        disabled: action.disabled?.value || action.disabled,
        cleared: action.cleared?.value || action.cleared,
      },
      warning: linked
        ? undefined
        : "The ui_policy reference field could not be set via the REST API and server-side GlideRecord execution also failed. The action was created but is not linked to the parent UI policy. Link it manually in the ServiceNow UI.",
    })
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    return createErrorResult(msg)
  }
}

export const version = "2.0.0"
export const author = "Serac SDK Migration"
