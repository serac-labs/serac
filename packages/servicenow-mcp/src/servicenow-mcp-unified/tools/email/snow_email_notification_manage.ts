/**
 * snow_email_notification_manage - Comprehensive email notification management
 *
 * Manage ServiceNow email notifications (sysevent_email_action) with full CRUD operations.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_email_notification_manage",
  description:
    "Manage email notifications (sysevent_email_action): list, get, create, update, delete, enable/disable. Supports all notification fields including triggers, recipients, content, and advanced options.",
  category: "automation",
  subcategory: "notifications",
  use_cases: ["notifications", "email", "automation"],
  complexity: "intermediate",
  frequency: "high",
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "get", "create", "update", "delete", "enable", "disable", "test", "clone"],
        description: "Action to perform",
      },
      notification_id: {
        type: "string",
        description: "Notification sys_id or name (required for get, update, delete, enable, disable, test, clone)",
      },
      // === Basic Fields ===
      table: {
        type: "string",
        description: "Table name (collection) the notification applies to",
      },
      name: {
        type: "string",
        description: "Notification name (display name in ServiceNow)",
      },
      active: {
        type: "boolean",
        description: "Whether notification is active",
        default: true,
      },
      // === Trigger Conditions ===
      action_insert: {
        type: "boolean",
        description: "Trigger on record INSERT",
        default: false,
      },
      action_update: {
        type: "boolean",
        description: "Trigger on record UPDATE",
        default: false,
      },
      event_name: {
        type: "string",
        description: "Event name to trigger on (alternative to action_insert/action_update)",
      },
      condition: {
        type: "string",
        description: 'Encoded query condition for when to send (e.g., "priority=1^state=2")',
      },
      advanced_condition: {
        type: "string",
        description: "Advanced condition script (JavaScript) - runs in addition to condition",
      },
      // === Recipients ===
      recipient_fields: {
        type: "array",
        items: { type: "string" },
        description: 'Field names containing recipients (e.g., ["assigned_to", "caller_id", "opened_by"])',
      },
      recipient_groups: {
        type: "array",
        items: { type: "string" },
        description: "Group sys_ids or names to receive notification",
      },
      recipient_users: {
        type: "array",
        items: { type: "string" },
        description: "User sys_ids or usernames to receive notification",
      },
      send_self: {
        type: "boolean",
        description: "Send to user who triggered the notification",
        default: false,
      },
      exclude_delegates: {
        type: "boolean",
        description: "Exclude delegate users from receiving notification",
        default: false,
      },
      // === Email Content ===
      subject: {
        type: "string",
        description: 'Email subject (supports ${field} substitution, e.g., "Incident ${number} assigned to you")',
      },
      message_html: {
        type: "string",
        description: "Email body HTML (supports ${field} substitution)",
      },
      message_text: {
        type: "string",
        description: "Email body plain text (fallback for non-HTML clients)",
      },
      template: {
        type: "string",
        description: "Email template sys_id or name - when set, uses template instead of inline message",
      },
      content_type: {
        type: "string",
        enum: ["text/html", "text/plain"],
        description: "Email content type",
        default: "text/html",
      },
      // === Email Headers ===
      from: {
        type: "string",
        description: "Custom FROM address (leave empty for system default)",
      },
      reply_to: {
        type: "string",
        description: "Reply-To address",
      },
      importance: {
        type: "string",
        enum: ["", "low", "normal", "high"],
        description: "Email importance/priority header",
      },
      // === Attachments ===
      include_attachments: {
        type: "boolean",
        description: "Include record attachments in email",
        default: false,
      },
      // === Notification Type ===
      type: {
        type: "string",
        enum: ["email", "sms", "push"],
        description: "Notification delivery type",
        default: "email",
      },
      push_message_only: {
        type: "boolean",
        description: "Send as push notification only (no email)",
        default: false,
      },
      sms_alternate: {
        type: "string",
        description: "SMS message content (when type=sms or as fallback)",
      },
      // === Advanced Options ===
      weight: {
        type: "number",
        description: "Priority weight for notification ordering (higher = more important)",
        default: 0,
      },
      order: {
        type: "number",
        description: "Execution order (lower = runs first)",
        default: 100,
      },
      force_delivery: {
        type: "boolean",
        description: "Force delivery even if user has notifications disabled",
        default: false,
      },
      omit_watermark: {
        type: "boolean",
        description: "Omit ServiceNow watermark from email",
        default: false,
      },
      mandatory: {
        type: "boolean",
        description: "Mark as mandatory notification (cannot be unsubscribed)",
        default: false,
      },
      subscribable: {
        type: "boolean",
        description: "Allow users to subscribe/unsubscribe from this notification",
        default: false,
      },
      category: {
        type: "string",
        description: "Notification category sys_id or name",
      },
      // === Event Parameters ===
      event_parm_1: {
        type: "boolean",
        description: "Use event.parm1 as recipient",
        default: false,
      },
      event_parm_2: {
        type: "boolean",
        description: "Use event.parm2 as recipient",
        default: false,
      },
      item: {
        type: "string",
        description: 'Event parameter item (e.g., "event.parm1", "event.parm2")',
      },
      // === Digest Options ===
      digestable: {
        type: "boolean",
        description: "Can be included in digest emails",
        default: false,
      },
      default_digest: {
        type: "boolean",
        description: "Include in digest by default",
        default: false,
      },
      digest_type: {
        type: "string",
        enum: ["single", "digest"],
        description: "Single email or digest mode",
        default: "single",
      },
      // === List/Query Options ===
      active_only: {
        type: "boolean",
        description: "Only list active notifications",
        default: false,
      },
      limit: {
        type: "number",
        description: "Max results for list action",
        default: 50,
      },
      // === Clone Options ===
      new_name: {
        type: "string",
        description: "Name for cloned notification (required for clone action)",
      },
    },
    required: ["action"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    action,
    notification_id,
    // Basic fields
    table,
    name,
    active = true,
    // Trigger conditions
    action_insert,
    action_update,
    event_name,
    condition,
    advanced_condition,
    // Recipients
    recipient_fields,
    recipient_groups,
    recipient_users,
    send_self = false,
    exclude_delegates = false,
    // Email content
    subject,
    message_html,
    message_text,
    template,
    content_type,
    // Email headers
    from,
    reply_to,
    importance,
    // Attachments
    include_attachments = false,
    // Notification type
    type,
    push_message_only = false,
    sms_alternate,
    // Advanced options
    weight = 0,
    order = 100,
    force_delivery = false,
    omit_watermark = false,
    mandatory = false,
    subscribable = false,
    category,
    // Event parameters
    event_parm_1 = false,
    event_parm_2 = false,
    item,
    // Digest options
    digestable = false,
    default_digest = false,
    digest_type,
    // List/query options
    active_only = false,
    limit = 50,
    // Clone options
    new_name,
  } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Helper to resolve notification name to sys_id
    async function resolveNotificationId(notifId: string): Promise<string> {
      if (notifId.length === 32 && !/\s/.test(notifId)) return notifId
      const lookup = await client.get("/api/now/table/sysevent_email_action", {
        params: {
          sysparm_query: "name=" + notifId,
          sysparm_fields: "sys_id",
          sysparm_limit: 1,
        },
      })
      if (!lookup.data.result?.[0]) {
        throw new SnowFlowError(ErrorType.NOT_FOUND, "Notification not found: " + notifId)
      }
      return lookup.data.result[0].sys_id
    }

    // Helper to resolve email template name to sys_id
    async function resolveTemplateId(templateId: string): Promise<string> {
      if (templateId.length === 32 && !/\s/.test(templateId)) return templateId
      var lookup = await client.get("/api/now/table/sysevent_email_template", {
        params: {
          sysparm_query: "name=" + templateId,
          sysparm_fields: "sys_id",
          sysparm_limit: 1,
        },
      })
      if (!lookup.data.result?.[0]) {
        throw new SnowFlowError(ErrorType.NOT_FOUND, "Email template not found: " + templateId)
      }
      return lookup.data.result[0].sys_id
    }

    switch (action) {
      case "list": {
        var query = ""
        if (table) {
          query = "collection=" + table
        }
        if (active_only) {
          query += (query ? "^" : "") + "active=true"
        }

        const response = await client.get("/api/now/table/sysevent_email_action", {
          params: {
            sysparm_query: query ? query + "^ORDERBYname" : "ORDERBYname",
            sysparm_fields:
              "sys_id,name,collection,event_name,active,subject,condition,template,action_insert,action_update,type,recipient_fields,sys_created_on,sys_updated_on",
            sysparm_display_value: "all",
            sysparm_limit: limit,
          },
        })

        var notifications = (response.data.result || []).map(function (n: any) {
          return {
            sys_id: n.sys_id?.value || n.sys_id,
            name: n.name?.value || n.name,
            table: n.collection?.value || n.collection,
            event: n.event_name?.value || n.event_name,
            active: (n.active?.value || n.active) === "true",
            trigger: {
              on_insert: (n.action_insert?.value || n.action_insert) === "true",
              on_update: (n.action_update?.value || n.action_update) === "true",
              event: n.event_name?.value || n.event_name || null,
            },
            subject: n.subject?.value || n.subject,
            has_condition: Boolean(n.condition?.value || n.condition),
            type: n.type?.value || n.type || "email",
            recipient_fields: n.recipient_fields?.value || n.recipient_fields || null,
            template: n.template?.value || n.template || null,
            template_display: n.template?.display_value || null,
            created: n.sys_created_on?.value || n.sys_created_on,
            updated: n.sys_updated_on?.value || n.sys_updated_on,
          }
        })

        return createSuccessResult({
          action: "list",
          count: notifications.length,
          notifications: notifications,
        })
      }

      case "get": {
        if (!notification_id) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "notification_id is required for get action")
        }

        var sysId = await resolveNotificationId(notification_id)

        const response = await client.get("/api/now/table/sysevent_email_action/" + sysId, {
          params: {
            sysparm_display_value: "all",
          },
        })
        var notif = response.data.result

        return createSuccessResult({
          action: "get",
          notification: {
            sys_id: notif.sys_id?.value || notif.sys_id,
            name: notif.name?.value || notif.name,
            table: notif.collection?.value || notif.collection,
            active: (notif.active?.value || notif.active) === "true",
            // Trigger conditions
            trigger: {
              on_insert: (notif.action_insert?.value || notif.action_insert) === "true",
              on_update: (notif.action_update?.value || notif.action_update) === "true",
              event_name: notif.event_name?.value || notif.event_name || null,
            },
            condition: notif.condition?.value || notif.condition || null,
            advanced_condition: notif.advanced_condition?.value || notif.advanced_condition || null,
            // Recipients
            recipients: {
              fields: notif.recipient_fields?.value || notif.recipient_fields || null,
              groups: notif.recipient_groups?.value || notif.recipient_groups || null,
              groups_display: notif.recipient_groups?.display_value || null,
              users: notif.recipient_users?.value || notif.recipient_users || null,
              users_display: notif.recipient_users?.display_value || null,
              send_self: (notif.send_self?.value || notif.send_self) === "true",
              exclude_delegates: (notif.exclude_delegates?.value || notif.exclude_delegates) === "true",
              event_parm_1: (notif.event_parm_1?.value || notif.event_parm_1) === "true",
              event_parm_2: (notif.event_parm_2?.value || notif.event_parm_2) === "true",
            },
            // Email content
            content: {
              subject: notif.subject?.value || notif.subject || null,
              message_html: notif.message_html?.value || notif.message_html || null,
              message_text: notif.message_text?.value || notif.message_text || null,
              template: notif.template?.value || notif.template || null,
              template_display: notif.template?.display_value || null,
              content_type: notif.content_type?.value || notif.content_type || "text/html",
            },
            // Email headers
            headers: {
              from: notif.from?.value || notif.from || null,
              reply_to: notif.reply_to?.value || notif.reply_to || null,
              importance: notif.importance?.value || notif.importance || null,
            },
            // Notification settings
            settings: {
              type: notif.type?.value || notif.type || "email",
              weight: parseInt(notif.weight?.value || notif.weight || "0"),
              order: parseInt(notif.order?.value || notif.order || "100"),
              include_attachments: (notif.include_attachments?.value || notif.include_attachments) === "true",
              force_delivery: (notif.force_delivery?.value || notif.force_delivery) === "true",
              omit_watermark: (notif.omit_watermark?.value || notif.omit_watermark) === "true",
              mandatory: (notif.mandatory?.value || notif.mandatory) === "true",
              subscribable: (notif.subscribable?.value || notif.subscribable) === "true",
              push_message_only: (notif.push_message_only?.value || notif.push_message_only) === "true",
              sms_alternate: notif.sms_alternate?.value || notif.sms_alternate || null,
            },
            // Digest options
            digest: {
              digestable: (notif.digestable?.value || notif.digestable) === "true",
              default_digest: (notif.default_digest?.value || notif.default_digest) === "true",
              digest_type: notif.digest_type?.value || notif.digest_type || "single",
            },
            // Category
            category: notif.category?.value || notif.category || null,
            category_display: notif.category?.display_value || null,
            // Event parameters
            item: notif.item?.value || notif.item || null,
            // Metadata
            created: notif.sys_created_on?.value || notif.sys_created_on,
            created_by: notif.sys_created_by?.value || notif.sys_created_by,
            updated: notif.sys_updated_on?.value || notif.sys_updated_on,
            updated_by: notif.sys_updated_by?.value || notif.sys_updated_by,
          },
          url: context.instanceUrl + "/nav_to.do?uri=sysevent_email_action.do?sys_id=" + sysId,
        })
      }

      case "create": {
        if (!name) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "name is required for create action")
        }
        if (!table) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "table is required for create action")
        }

        var createData: any = {
          name: name,
          collection: table,
          active: active,
        }

        // Trigger conditions
        if (action_insert !== undefined) createData.action_insert = action_insert
        if (action_update !== undefined) createData.action_update = action_update
        if (event_name) createData.event_name = event_name
        if (condition) createData.condition = condition
        if (advanced_condition) createData.advanced_condition = advanced_condition

        // Recipients
        if (recipient_fields)
          createData.recipient_fields = Array.isArray(recipient_fields) ? recipient_fields.join(",") : recipient_fields
        if (recipient_groups)
          createData.recipient_groups = Array.isArray(recipient_groups) ? recipient_groups.join(",") : recipient_groups
        if (recipient_users)
          createData.recipient_users = Array.isArray(recipient_users) ? recipient_users.join(",") : recipient_users
        if (send_self !== undefined) createData.send_self = send_self
        if (exclude_delegates !== undefined) createData.exclude_delegates = exclude_delegates
        if (event_parm_1 !== undefined) createData.event_parm_1 = event_parm_1
        if (event_parm_2 !== undefined) createData.event_parm_2 = event_parm_2

        // Email content
        if (subject) createData.subject = subject
        if (message_html) createData.message_html = message_html
        if (message_text) createData.message_text = message_text
        if (template) {
          var resolvedTemplateId = await resolveTemplateId(template)
          createData.template = resolvedTemplateId
        }
        if (content_type) createData.content_type = content_type

        // Email headers
        if (from) createData.from = from
        if (reply_to) createData.reply_to = reply_to
        if (importance) createData.importance = importance

        // Notification settings
        if (type) createData.type = type
        if (weight !== undefined) createData.weight = weight
        if (order !== undefined) createData.order = order
        if (include_attachments !== undefined) createData.include_attachments = include_attachments
        if (force_delivery !== undefined) createData.force_delivery = force_delivery
        if (omit_watermark !== undefined) createData.omit_watermark = omit_watermark
        if (mandatory !== undefined) createData.mandatory = mandatory
        if (subscribable !== undefined) createData.subscribable = subscribable
        if (push_message_only !== undefined) createData.push_message_only = push_message_only
        if (sms_alternate) createData.sms_alternate = sms_alternate

        // Category
        if (category) createData.category = category

        // Event parameters
        if (item) createData.item = item

        // Digest options
        if (digestable !== undefined) createData.digestable = digestable
        if (default_digest !== undefined) createData.default_digest = default_digest
        if (digest_type) createData.digest_type = digest_type

        const createResponse = await client.post("/api/now/table/sysevent_email_action", createData)
        var newSysId = createResponse.data.result.sys_id

        return createSuccessResult({
          action: "create",
          created: true,
          notification: {
            sys_id: newSysId,
            name: createResponse.data.result.name,
            table: createResponse.data.result.collection,
          },
          url: context.instanceUrl + "/nav_to.do?uri=sysevent_email_action.do?sys_id=" + newSysId,
        })
      }

      case "update": {
        if (!notification_id) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "notification_id is required for update action")
        }

        var updateSysId = await resolveNotificationId(notification_id)

        var updateData: any = {}

        // Basic fields
        if (name !== undefined) updateData.name = name
        if (table !== undefined) updateData.collection = table
        if (active !== undefined) updateData.active = active

        // Trigger conditions
        if (action_insert !== undefined) updateData.action_insert = action_insert
        if (action_update !== undefined) updateData.action_update = action_update
        if (event_name !== undefined) updateData.event_name = event_name
        if (condition !== undefined) updateData.condition = condition
        if (advanced_condition !== undefined) updateData.advanced_condition = advanced_condition

        // Recipients
        if (recipient_fields !== undefined)
          updateData.recipient_fields = Array.isArray(recipient_fields) ? recipient_fields.join(",") : recipient_fields
        if (recipient_groups !== undefined)
          updateData.recipient_groups = Array.isArray(recipient_groups) ? recipient_groups.join(",") : recipient_groups
        if (recipient_users !== undefined)
          updateData.recipient_users = Array.isArray(recipient_users) ? recipient_users.join(",") : recipient_users
        if (send_self !== undefined) updateData.send_self = send_self
        if (exclude_delegates !== undefined) updateData.exclude_delegates = exclude_delegates
        if (event_parm_1 !== undefined) updateData.event_parm_1 = event_parm_1
        if (event_parm_2 !== undefined) updateData.event_parm_2 = event_parm_2

        // Email content
        if (subject !== undefined) updateData.subject = subject
        if (message_html !== undefined) updateData.message_html = message_html
        if (message_text !== undefined) updateData.message_text = message_text
        if (template !== undefined) {
          if (template === "" || template === null) {
            updateData.template = "" // Clear template
          } else {
            var resolvedUpdateTemplateId = await resolveTemplateId(template)
            updateData.template = resolvedUpdateTemplateId
          }
        }
        if (content_type !== undefined) updateData.content_type = content_type

        // Email headers
        if (from !== undefined) updateData.from = from
        if (reply_to !== undefined) updateData.reply_to = reply_to
        if (importance !== undefined) updateData.importance = importance

        // Notification settings
        if (type !== undefined) updateData.type = type
        if (weight !== undefined) updateData.weight = weight
        if (order !== undefined) updateData.order = order
        if (include_attachments !== undefined) updateData.include_attachments = include_attachments
        if (force_delivery !== undefined) updateData.force_delivery = force_delivery
        if (omit_watermark !== undefined) updateData.omit_watermark = omit_watermark
        if (mandatory !== undefined) updateData.mandatory = mandatory
        if (subscribable !== undefined) updateData.subscribable = subscribable
        if (push_message_only !== undefined) updateData.push_message_only = push_message_only
        if (sms_alternate !== undefined) updateData.sms_alternate = sms_alternate

        // Category
        if (category !== undefined) updateData.category = category

        // Event parameters
        if (item !== undefined) updateData.item = item

        // Digest options
        if (digestable !== undefined) updateData.digestable = digestable
        if (default_digest !== undefined) updateData.default_digest = default_digest
        if (digest_type !== undefined) updateData.digest_type = digest_type

        if (Object.keys(updateData).length === 0) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "No fields to update")
        }

        await client.patch("/api/now/table/sysevent_email_action/" + updateSysId, updateData)

        return createSuccessResult({
          action: "update",
          updated: true,
          notification_id: updateSysId,
          fields_updated: Object.keys(updateData),
          url: context.instanceUrl + "/nav_to.do?uri=sysevent_email_action.do?sys_id=" + updateSysId,
        })
      }

      case "delete": {
        if (!notification_id) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "notification_id is required for delete action")
        }

        var deleteSysId = await resolveNotificationId(notification_id)
        await client.delete("/api/now/table/sysevent_email_action/" + deleteSysId)

        return createSuccessResult({
          action: "delete",
          deleted: true,
          notification_id: deleteSysId,
        })
      }

      case "enable":
      case "disable": {
        if (!notification_id) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "notification_id is required for " + action + " action")
        }

        var toggleSysId = await resolveNotificationId(notification_id)
        await client.patch("/api/now/table/sysevent_email_action/" + toggleSysId, {
          active: action === "enable",
        })

        return createSuccessResult({
          action: action,
          notification_id: toggleSysId,
          active: action === "enable",
          message: "Notification " + (action === "enable" ? "enabled" : "disabled"),
        })
      }

      case "test": {
        if (!notification_id) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "notification_id is required for test action")
        }

        var testSysId = await resolveNotificationId(notification_id)

        // Get notification details for test info
        const testNotif = await client.get("/api/now/table/sysevent_email_action/" + testSysId, {
          params: {
            sysparm_fields: "name,collection,event_name,subject,action_insert,action_update,active",
          },
        })

        var triggerInfo = []
        if (testNotif.data.result.action_insert === "true") triggerInfo.push("INSERT")
        if (testNotif.data.result.action_update === "true") triggerInfo.push("UPDATE")
        if (testNotif.data.result.event_name) triggerInfo.push("Event: " + testNotif.data.result.event_name)

        return createSuccessResult({
          action: "test",
          notification_id: testSysId,
          notification_name: testNotif.data.result.name,
          active: testNotif.data.result.active === "true",
          table: testNotif.data.result.collection,
          triggers: triggerInfo.length > 0 ? triggerInfo : ["No triggers configured"],
          message:
            "To test this notification, trigger the event or condition on the " +
            testNotif.data.result.collection +
            " table",
          test_tips: [
            "Check System Logs > Email for sent emails",
            "Use snow_get_email_logs tool to view email history",
            "Ensure notification is active (active=" + testNotif.data.result.active + ")",
          ],
          url: context.instanceUrl + "/nav_to.do?uri=sysevent_email_action.do?sys_id=" + testSysId,
        })
      }

      case "clone": {
        if (!notification_id) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "notification_id is required for clone action")
        }
        if (!new_name) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "new_name is required for clone action")
        }

        var cloneSysId = await resolveNotificationId(notification_id)

        // Get the original notification
        const originalNotif = await client.get("/api/now/table/sysevent_email_action/" + cloneSysId)
        var original = originalNotif.data.result

        // Create clone with all fields except sys_ fields
        var cloneData: any = {
          name: new_name,
          collection: original.collection,
          active: active !== undefined ? active : false, // Clone as inactive by default
          action_insert: original.action_insert,
          action_update: original.action_update,
          event_name: original.event_name,
          condition: original.condition,
          advanced_condition: original.advanced_condition,
          recipient_fields: original.recipient_fields,
          recipient_groups: original.recipient_groups,
          recipient_users: original.recipient_users,
          send_self: original.send_self,
          exclude_delegates: original.exclude_delegates,
          event_parm_1: original.event_parm_1,
          event_parm_2: original.event_parm_2,
          subject: original.subject,
          message_html: original.message_html,
          message_text: original.message_text,
          template: original.template,
          content_type: original.content_type,
          from: original.from,
          reply_to: original.reply_to,
          importance: original.importance,
          type: original.type,
          weight: original.weight,
          order: original.order,
          include_attachments: original.include_attachments,
          force_delivery: original.force_delivery,
          omit_watermark: original.omit_watermark,
          mandatory: original.mandatory,
          subscribable: original.subscribable,
          push_message_only: original.push_message_only,
          sms_alternate: original.sms_alternate,
          category: original.category,
          item: original.item,
          digestable: original.digestable,
          default_digest: original.default_digest,
          digest_type: original.digest_type,
        }

        // Remove empty/null values
        Object.keys(cloneData).forEach(function (key) {
          if (cloneData[key] === null || cloneData[key] === "" || cloneData[key] === undefined) {
            delete cloneData[key]
          }
        })

        const cloneResponse = await client.post("/api/now/table/sysevent_email_action", cloneData)
        var clonedSysId = cloneResponse.data.result.sys_id

        return createSuccessResult({
          action: "clone",
          cloned: true,
          original: {
            sys_id: cloneSysId,
            name: original.name,
          },
          clone: {
            sys_id: clonedSysId,
            name: new_name,
            active: cloneData.active,
          },
          message:
            "Notification cloned successfully. The clone is " +
            (cloneData.active ? "active" : "inactive") +
            " by default.",
          url: context.instanceUrl + "/nav_to.do?uri=sysevent_email_action.do?sys_id=" + clonedSysId,
        })
      }

      default:
        throw new SnowFlowError(
          ErrorType.VALIDATION_ERROR,
          "Unknown action: " +
            action +
            ". Valid actions: list, get, create, update, delete, enable, disable, test, clone",
        )
    }
  } catch (error: any) {
    return createErrorResult(
      error instanceof SnowFlowError
        ? error
        : new SnowFlowError(ErrorType.UNKNOWN_ERROR, error.message, { originalError: error }),
    )
  }
}

export const version = "1.0.0"
export const author = "Serac"
