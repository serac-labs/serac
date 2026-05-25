---
name: email-notifications
description: Create ServiceNow sysevent_email_action notifications — templates with substitution variables, mail scripts for dynamic content/recipients/attachments, custom events, weights, and digest configuration.
license: Apache-2.0
compatibility: Designed for Snow-Code and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_configure_email
  - snow_query_table
  - snow_find_artifact
  - snow_execute_script_with_output
---

# Email Notifications for ServiceNow

ServiceNow notifications are triggered by events and send emails, SMS, or other alerts to users.

## Notification Components

| Component              | Table                   | Purpose                  |
| ---------------------- | ----------------------- | ------------------------ |
| **Notification**       | sysevent_email_action   | Main notification record |
| **Email Template**     | sysevent_email_template | Reusable email layouts   |
| **Event**              | sysevent                | Triggers notifications   |
| **Event Registration** | sysevent_register       | Defines custom events    |
| **Email Script**       | sys_script_email        | Dynamic content scripts  |

## Creating Notifications

### Basic Notification Structure

```
Notification: Incident Assigned
├── When to send
│   ├── Table: incident
│   ├── When: Record inserted or updated
│   └── Conditions: assigned_to changes AND is not empty
├── Who will receive
│   ├── Users: ${assigned_to}
│   └── Groups: (optional)
├── What it will contain
│   ├── Subject: Incident ${number} assigned to you
│   ├── Message: HTML body with ${field} references
│   └── Email Template: (optional)
└── Advanced
    ├── Weight: 0 (priority)
    └── Send to event creator: false
```

### Notification Conditions

```javascript
// Simple field conditions
assigned_to CHANGES
priority = 1
state = 6  // Resolved

// Script condition (ES5 only!)
// Returns true to send, false to skip
(function() {
    // Only notify for VIP callers
    var caller = current.caller_id.getRefRecord();
    return caller.vip == true;
})()

// Advanced condition with multiple checks
(function() {
    // Don't notify on bulk updates
    if (current.sys_mod_count > 100) return false;

    // Only for production CIs
    var ci = current.cmdb_ci.getRefRecord();
    return ci.used_for == 'Production';
})()
```

## Email Templates

### Template Variables

```html
<!-- Field references -->
${number}
<!-- Direct field value -->
${caller_id.name}
<!-- Dot-walked reference -->
${opened_at.display_value}
<!-- Display value -->

<!-- Special variables -->
${URI}
<!-- Link to record -->
${URI_REF}
<!-- Reference link -->
${mail_script:script_name}
<!-- Include email script -->

<!-- Conditional content -->
${mailto:assigned_to}
<!-- Mailto link -->
```

### Template Example

```html
<html>
  <body style="font-family: Arial, sans-serif;">
    <h2>Incident ${number} - ${short_description}</h2>

    <table border="0" cellpadding="5">
      <tr>
        <td><strong>Priority:</strong></td>
        <td>${priority}</td>
      </tr>
      <tr>
        <td><strong>Caller:</strong></td>
        <td>${caller_id.name}</td>
      </tr>
      <tr>
        <td><strong>Assigned to:</strong></td>
        <td>${assigned_to.name}</td>
      </tr>
      <tr>
        <td><strong>Description:</strong></td>
        <td>${description}</td>
      </tr>
    </table>

    <p>
      <a href="${URI}">View Incident</a>
    </p>

    ${mail_script:incident_history}
  </body>
</html>
```

## Email Scripts

### Basic Email Script

```javascript
// Email Script: incident_history
// Table: incident
// Script (ES5 only!):

;(function runMailScript(current, template, email, email_action, event) {
  // Build activity history
  var html = "<h3>Recent Activity</h3><ul>"

  var history = new GlideRecord("sys_journal_field")
  history.addQuery("element_id", current.sys_id)
  history.addQuery("name", "incident")
  history.orderByDesc("sys_created_on")
  history.setLimit(5)
  history.query()

  while (history.next()) {
    html += "<li><strong>" + history.sys_created_on.getDisplayValue() + "</strong>: "
    html += history.value.substring(0, 200) + "</li>"
  }
  html += "</ul>"

  template.print(html)
})(current, template, email, email_action, event)
```

### Email Script with Attachments

```javascript
// Add attachments from the record to the email
;(function runMailScript(current, template, email, email_action, event) {
  var gr = new GlideRecord("sys_attachment")
  gr.addQuery("table_sys_id", current.sys_id)
  gr.addQuery("table_name", "incident")
  gr.query()

  while (gr.next()) {
    email.addAttachment(gr)
  }
})(current, template, email, email_action, event)
```

### Dynamic Recipients

```javascript
// Email Script to add CC recipients dynamically
;(function runMailScript(current, template, email, email_action, event) {
  // Add all group members as CC
  var group = current.assignment_group
  if (!group.nil()) {
    var members = new GlideRecord("sys_user_grmember")
    members.addQuery("group", group)
    members.query()

    while (members.next()) {
      var user = members.user.getRefRecord()
      if (user.email) {
        email.addAddress("cc", user.email, user.name)
      }
    }
  }
})(current, template, email, email_action, event)
```

## Custom Events

### Registering a Custom Event

```javascript
// Event Registration
// Name: x_myapp.incident.escalated
// Table: incident
// Description: Fired when incident is escalated to management
// Fired by: Business Rule

// In Business Rule (ES5 only!)
;(function executeRule(current, previous) {
  // Check if escalation occurred
  if (current.escalation > previous.escalation) {
    // Fire custom event
    gs.eventQueue(
      "x_myapp.incident.escalated",
      current,
      current.escalation.getDisplayValue(), // parm1
      current.assigned_to.name, // parm2
    )
  }
})(current, previous)
```

### Notification on Custom Event

```
Notification: Escalation Alert
├── When to send
│   ├── Send when: Event is fired
│   └── Event name: x_myapp.incident.escalated
├── Who will receive
│   └── Users/Groups: Escalation Managers
└── What it will contain
    ├── Subject: Escalation: ${number} - ${event.parm1}
    └── Message: Incident escalated. Assigned to: ${event.parm2}
```

## Recipient Types

### Who Will Receive

| Type                      | Description           | Example                      |
| ------------------------- | --------------------- | ---------------------------- |
| **Users**                 | Specific users        | ${assigned_to}, ${caller_id} |
| **Groups**                | User groups           | Service Desk, CAB            |
| **Group Managers**        | Group manager field   | ${assignment_group.manager}  |
| **Event Parm 1/2**        | From event parameters | ${event.parm1}               |
| **Additional Recipients** | Email addresses       | External emails              |

### Recipient Script

```javascript
// Recipient Script (ES5 only!)
// Returns comma-separated list of emails or sys_ids

;(function getRecipients(current, event) {
  var recipients = []

  // Add the caller
  if (!current.caller_id.nil()) {
    recipients.push(current.caller_id.email.toString())
  }

  // Add VIP's manager
  var caller = current.caller_id.getRefRecord()
  if (caller.vip == true && !caller.manager.nil()) {
    recipients.push(caller.manager.email.toString())
  }

  return recipients.join(",")
})(current, event)
```

## Notification Weight

Priority system for multiple matching notifications:

| Weight    | Use Case                                         |
| --------- | ------------------------------------------------ |
| 0         | Default priority                                 |
| 1-99      | Higher priority (lower weight = higher priority) |
| -1 to -99 | Lower priority                                   |
| 100+      | Rarely used                                      |

```javascript
// Only highest weight notification sends if "Exclude subscribers" checked
// Weight 0 notification beats Weight 10 notification
```

## Digest Notifications

### Configuring Digest

```
Notification: Daily Incident Summary
├── Digest: Checked
├── Digest Interval: Daily
├── Digest Time: 08:00
└── Content: Summary of all incidents
```

### Digest Email Script

```javascript
// Summarize digest records
;(function runMailScript(current, template, email, email_action, event) {
  var count = 0
  var html = '<table border="1" cellpadding="5">'
  html += "<tr><th>Number</th><th>Description</th><th>Priority</th></tr>"

  // 'current' is a GlideRecord with all digest records
  while (current.next()) {
    count++
    html += "<tr>"
    html += "<td>" + current.number + "</td>"
    html += "<td>" + current.short_description + "</td>"
    html += "<td>" + current.priority.getDisplayValue() + "</td>"
    html += "</tr>"
  }
  html += "</table>"
  html += "<p>Total: " + count + " incidents</p>"

  template.print(html)
})(current, template, email, email_action, event)
```

## Outbound Email Configuration

### Email Properties

```javascript
// System Properties for email
glide.email.smtp.active // Enable/disable outbound email
glide.email.smtp.host // SMTP server
glide.email.smtp.port // SMTP port (usually 25 or 587)
glide.email.default.sender // Default from address
glide.email.test.user // Test recipient (all emails go here)
```

### Testing Notifications

```javascript
// Background Script to test notification (ES5 only!)
var gr = new GlideRecord("incident")
gr.get("sys_id_here")

// Fire event to trigger notification
gs.eventQueue("incident.assigned", gr, gr.assigned_to.getDisplayValue(), gs.getUserDisplayName())

gs.info("Event queued for incident: " + gr.number)
```

## Best Practices

1. **Use Templates** - Reuse layouts across notifications
2. **Test Thoroughly** - Use test user property during development
3. **Consider Digests** - For high-volume notifications
4. **Weight Carefully** - Prevent duplicate emails
5. **ES5 Only** - All scripts must be ES5 compliant
6. **Limit Recipients** - Don't spam large groups
7. **Include Context** - Provide enough info to act without login
8. **Mobile-Friendly** - Keep HTML simple for mobile clients

## Common Issues

| Issue            | Cause                   | Solution                        |
| ---------------- | ----------------------- | ------------------------------- |
| Email not sent   | Event not fired         | Check business rule fires event |
| Wrong recipients | Script error            | Debug recipient script          |
| Missing content  | Template variable wrong | Check field names               |
| Duplicate emails | Multiple notifications  | Check weights and conditions    |
| Delayed emails   | Email job schedule      | Check sysauto_script            |
