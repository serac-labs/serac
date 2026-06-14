---
name: mobile-development
description: Configure ServiceNow Mobile (Now Mobile/Agent) — sys_sg_mobile_app screens, card builders, push notifications, offline sync rules, mobile actions for barcode/GPS, and offline-queue change processing.
license: Apache-2.0
compatibility: Designed for Snow-Code and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_query_table
  - snow_execute_script
  - snow_artifact_manage
---

# Mobile Development for ServiceNow

Mobile development enables native mobile experiences with offline capabilities.

## Mobile Architecture

```
Mobile App Configuration
    ├── App Screens
    │   ├── List Views
    │   ├── Detail Views
    │   └── Card Builders
    ├── Push Notifications
    ├── Offline Rules
    └── Mobile Actions
```

## Key Tables

| Table                   | Purpose            |
| ----------------------- | ------------------ |
| `sys_sg_mobile_app`     | Mobile app configs |
| `sys_sg_screen`         | Mobile screens     |
| `sys_sg_card_builder`   | Card builders      |
| `sys_push_notification` | Push configs       |
| `sys_sg_offline_rule`   | Offline rules      |

## Mobile App Configuration (ES5)

### Create Mobile App

```javascript
// Create mobile app configuration (ES5 ONLY!)
var app = new GlideRecord("sys_sg_mobile_app")
app.initialize()

app.setValue("name", "IT Support")
app.setValue("description", "Mobile app for IT support tasks")

// App settings
app.setValue("active", true)
app.setValue("version", "1.0.0")

// Branding
app.setValue("primary_color", "#1976D2")
app.setValue("secondary_color", "#FFFFFF")
app.setValue("icon", "attachment_sys_id")

// Default screen
app.setValue("home_screen", homeScreenSysId)

// Roles
app.setValue("roles", "itil")

app.insert()
```

### Configure Mobile Screen

```javascript
// Create mobile screen (ES5 ONLY!)
var screen = new GlideRecord("sys_sg_screen")
screen.initialize()

screen.setValue("name", "My Incidents")
screen.setValue("mobile_app", mobileAppSysId)
screen.setValue("type", "list") // list, record, custom

// Data source
screen.setValue("table", "incident")
screen.setValue("filter", "assigned_to=javascript:gs.getUserID()^active=true")

// Display
screen.setValue("title", "My Incidents")
screen.setValue("icon", "list")

// Ordering
screen.setValue("order", 100)

screen.insert()
```

## Card Builder (ES5)

### Create Card Configuration

```javascript
// Create card builder for list display (ES5 ONLY!)
var card = new GlideRecord("sys_sg_card_builder")
card.initialize()

card.setValue("name", "Incident Card")
card.setValue("table", "incident")

// Card layout
card.setValue("primary_field", "number")
card.setValue("secondary_field", "short_description")
card.setValue("tertiary_field", "priority")

// Additional fields
card.setValue(
  "fields",
  JSON.stringify([
    { field: "caller_id", label: "Caller" },
    { field: "state", label: "Status" },
    { field: "opened_at", label: "Opened" },
  ]),
)

// Visual indicators
card.setValue("color_field", "priority")
card.setValue(
  "color_mapping",
  JSON.stringify({
    1: "#D32F2F", // Critical - Red
    2: "#F57C00", // High - Orange
    3: "#FBC02D", // Moderate - Yellow
    4: "#388E3C", // Low - Green
    5: "#1976D2", // Planning - Blue
  }),
)

card.insert()
```

### Custom Card Actions

```javascript
// Add actions to card (ES5 ONLY!)
function addCardAction(cardSysId, actionDef) {
  var action = new GlideRecord("sys_sg_card_action")
  action.initialize()

  action.setValue("card_builder", cardSysId)
  action.setValue("label", actionDef.label)
  action.setValue("icon", actionDef.icon)
  action.setValue("order", actionDef.order)

  // Action type
  action.setValue("action_type", actionDef.type) // script, navigate, share

  // Script action (ES5 ONLY!)
  if (actionDef.type === "script") {
    action.setValue("script", actionDef.script)
  }

  action.insert()
}

// Example actions
addCardAction(cardSysId, {
  label: "Acknowledge",
  icon: "check",
  order: 100,
  type: "script",
  script:
    "(function(gr) {\n" +
    "    gr.state = 2;  // In Progress\n" +
    '    gr.work_notes = "Acknowledged via mobile";\n' +
    "    gr.update();\n" +
    '    gs.addInfoMessage("Incident acknowledged");\n' +
    "})(current);",
})
```

## Push Notifications (ES5)

### Configure Push Notification

```javascript
// Create push notification config (ES5 ONLY!)
var push = new GlideRecord("sys_push_notification")
push.initialize()

push.setValue("name", "High Priority Incident Assigned")
push.setValue("description", "Notify when high priority incident assigned")

// Target table and condition
push.setValue("table", "incident")
push.setValue("condition", "priority<=2^assigned_to.changes()")

// Notification content
push.setValue("title", "High Priority Incident Assigned")
push.setValue("body", "${number}: ${short_description}")

// Recipients
push.setValue("recipient_type", "field")
push.setValue("recipient_field", "assigned_to")

// Deep link
push.setValue("deep_link", true)
push.setValue("link_url", "/incident/${sys_id}")

push.setValue("active", true)

push.insert()
```

### Send Push Notification Programmatically

```javascript
// Send push notification (ES5 ONLY!)
function sendPushNotification(userSysId, message) {
  try {
    var push = new sn_notification.PushNotification()

    push.setTitle(message.title)
    push.setBody(message.body)

    if (message.data) {
      push.setData(message.data)
    }

    if (message.deepLink) {
      push.setDeepLink(message.deepLink)
    }

    push.send(userSysId)

    return { success: true }
  } catch (e) {
    gs.error("Push notification failed: " + e.message)
    return { success: false, error: e.message }
  }
}

// Example
sendPushNotification(userSysId, {
  title: "Task Assigned",
  body: "You have a new task assigned",
  deepLink: "/task/" + taskSysId,
})
```

## Offline Capabilities (ES5)

### Configure Offline Rules

```javascript
// Create offline sync rule (ES5 ONLY!)
var rule = new GlideRecord("sys_sg_offline_rule")
rule.initialize()

rule.setValue("name", "My Open Incidents")
rule.setValue("mobile_app", mobileAppSysId)
rule.setValue("table", "incident")

// Sync filter
rule.setValue("filter", "assigned_to=javascript:gs.getUserID()^active=true")

// Fields to sync
rule.setValue("fields", "number,short_description,description,priority,state,caller_id,opened_at")

// Related records
rule.setValue("include_references", true)
rule.setValue("reference_fields", "caller_id,assignment_group")

// Sync limits
rule.setValue("max_records", 100)

// Update frequency
rule.setValue("sync_frequency", "on_demand") // on_demand, periodic

rule.setValue("active", true)

rule.insert()
```

### Handle Offline Data

```javascript
// Check for offline changes on sync (ES5 ONLY!)
function processOfflineChanges(userId) {
  var offlineQueue = new GlideRecord("sys_sg_offline_queue")
  offlineQueue.addQuery("user", userId)
  offlineQueue.addQuery("processed", false)
  offlineQueue.orderBy("created_on")
  offlineQueue.query()

  var results = { processed: 0, errors: [] }

  while (offlineQueue.next()) {
    try {
      var tableName = offlineQueue.getValue("table")
      var recordSysId = offlineQueue.getValue("record")
      var changes = JSON.parse(offlineQueue.getValue("changes"))

      // Apply changes
      var gr = new GlideRecord(tableName)
      if (gr.get(recordSysId)) {
        for (var field in changes) {
          if (changes.hasOwnProperty(field)) {
            gr.setValue(field, changes[field])
          }
        }
        gr.update()
        results.processed++
      }

      // Mark as processed
      offlineQueue.processed = true
      offlineQueue.update()
    } catch (e) {
      results.errors.push({
        record: offlineQueue.getValue("record"),
        error: e.message,
      })
    }
  }

  return results
}
```

## Mobile Actions (ES5)

### Create Mobile Action

```javascript
// Create mobile-specific action (ES5 ONLY!)
var action = new GlideRecord("sys_sg_action")
action.initialize()

action.setValue("name", "Scan Barcode")
action.setValue("label", "Scan Asset")
action.setValue("description", "Scan barcode to find asset")

// Action type
action.setValue("type", "native") // native, script, link
action.setValue("native_action", "barcode_scan")

// Available on
action.setValue("screens", screenSysIds)

// Callback script (ES5 ONLY!)
action.setValue(
  "callback_script",
  "(function(result) {\n" +
    "    if (!result.value) return;\n" +
    "    \n" +
    '    var asset = new GlideRecord("alm_asset");\n' +
    '    asset.addQuery("asset_tag", result.value);\n' +
    "    asset.query();\n" +
    "    \n" +
    "    if (asset.next()) {\n" +
    "        // Navigate to asset\n" +
    '        sn_mobile.navigate("record", {\n' +
    '            table: "alm_asset",\n' +
    "            sys_id: asset.getUniqueValue()\n" +
    "        });\n" +
    "    } else {\n" +
    '        gs.addErrorMessage("Asset not found: " + result.value);\n' +
    "    }\n" +
    "})(scanResult);",
)

action.insert()
```

### Location-Based Action

```javascript
// Get user location for mobile (ES5 ONLY!)
// Available in mobile context

function getCurrentLocation() {
  try {
    var location = sn_mobile.getLocation()
    return {
      latitude: location.latitude,
      longitude: location.longitude,
      accuracy: location.accuracy,
    }
  } catch (e) {
    return null
  }
}

// Use location for nearby assets
function findNearbyAssets(latitude, longitude, radiusMeters) {
  var assets = []

  var gr = new GlideRecord("alm_asset")
  gr.addNotNullQuery("location.latitude")
  gr.query()

  while (gr.next()) {
    var assetLat = parseFloat(gr.location.latitude)
    var assetLon = parseFloat(gr.location.longitude)

    var distance = calculateDistance(latitude, longitude, assetLat, assetLon)

    if (distance <= radiusMeters) {
      assets.push({
        sys_id: gr.getUniqueValue(),
        name: gr.getDisplayValue(),
        distance: Math.round(distance),
      })
    }
  }

  return assets.sort(function (a, b) {
    return a.distance - b.distance
  })
}
```

## MCP Tool Integration

### Available Tools

| Tool                                  | Purpose              |
| ------------------------------------- | -------------------- |
| `snow_query_table`                    | Query mobile configs |
| `snow_execute_script`                 | Test mobile scripts  |
| `snow_artifact_manage` (action='find')| Find configurations  |

### Example Workflow

```javascript
// 1. Query mobile apps
await snow_query_table({
  table: "sys_sg_mobile_app",
  query: "active=true",
  fields: "name,description,version,roles",
})

// 2. Get push notification configs
await snow_query_table({
  table: "sys_push_notification",
  query: "active=true",
  fields: "name,table,condition,title",
})

// 3. Check offline rules
await snow_query_table({
  table: "sys_sg_offline_rule",
  query: "active=true",
  fields: "name,table,filter,max_records",
})
```

## Best Practices

1. **Offline First** - Design for connectivity issues
2. **Minimal Data** - Sync only necessary fields
3. **Push Wisely** - Don't overwhelm with notifications
4. **Native Features** - Use camera, GPS, barcode
5. **Card Design** - Key info at a glance
6. **Performance** - Optimize for mobile
7. **Testing** - Test on actual devices
8. **ES5 Only** - No modern JavaScript syntax
