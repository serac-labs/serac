---
name: field-service
description: Build ServiceNow Field Service Management — wm_order work orders, wm_task tasks, wm_resource technicians with skills/territories, dispatch/auto-assignment, mobile status updates, and time entries.
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

# Field Service Management for ServiceNow

Field Service Management (FSM) manages work orders, technician dispatch, and mobile field operations.

## FSM Architecture

```
Work Order (wm_order)
    ├── Work Order Tasks (wm_task)
    │   ├── Time Entries
    │   └── Parts Used
    ├── Asset/CI
    └── Location

Dispatch
    ├── Scheduling
    └── Route Optimization
```

## Key Tables

| Table               | Purpose             |
| ------------------- | ------------------- |
| `wm_order`          | Work orders         |
| `wm_task`           | Work order tasks    |
| `wm_resource`       | Field technicians   |
| `wm_schedule_entry` | Schedule entries    |
| `wm_territory`      | Service territories |

## Work Orders (ES5)

### Create Work Order

```javascript
// Create work order (ES5 ONLY!)
var workOrder = new GlideRecord("wm_order")
workOrder.initialize()

// Basic info
workOrder.setValue("short_description", "HVAC repair - Building A")
workOrder.setValue("description", "AC unit not cooling properly")
workOrder.setValue("priority", 2)

// Classification
workOrder.setValue("work_order_type", "repair")
workOrder.setValue("category", "hvac")

// Location
workOrder.setValue("location", locationSysId)
workOrder.setValue("cmdb_ci", hvacUnitCISysId)

// Customer/Contact
workOrder.setValue("account", customerAccountSysId)
workOrder.setValue("contact", contactSysId)

// Scheduling
var scheduledStart = new GlideDateTime()
scheduledStart.addDaysLocalTime(1)
workOrder.setValue("scheduled_start", scheduledStart)

// Assignment
workOrder.setValue("assignment_group", fieldServiceGroupSysId)

// SLA
workOrder.setValue("sla", slaDefinitionSysId)

workOrder.insert()
```

### Work Order Tasks

```javascript
// Create work order tasks (ES5 ONLY!)
function createWorkOrderTasks(workOrderSysId, tasks) {
  var createdTasks = []

  for (var i = 0; i < tasks.length; i++) {
    var task = new GlideRecord("wm_task")
    task.initialize()
    task.setValue("work_order", workOrderSysId)
    task.setValue("short_description", tasks[i].description)
    task.setValue("order", (i + 1) * 100)

    // Estimated duration
    task.setValue("estimated_duration", tasks[i].duration)

    // Skills required
    if (tasks[i].skills) {
      task.setValue("skills", tasks[i].skills)
    }

    // Parts needed
    if (tasks[i].parts) {
      task.setValue("u_parts_required", tasks[i].parts)
    }

    var taskSysId = task.insert()
    createdTasks.push({
      sys_id: taskSysId,
      number: task.getValue("number"),
    })
  }

  return createdTasks
}

// Example
createWorkOrderTasks(workOrderSysId, [
  { description: "Diagnose AC unit", duration: "01:00:00", skills: "hvac_certified" },
  { description: "Replace compressor", duration: "02:00:00", parts: "COMP-AC-001" },
  { description: "Test and verify", duration: "00:30:00" },
])
```

## Technician Management (ES5)

### Create Resource Profile

```javascript
// Create field technician profile (ES5 ONLY!)
var resource = new GlideRecord("wm_resource")
resource.initialize()

// Link to user
resource.setValue("user", userSysId)

// Skills
resource.setValue("skills", "hvac_certified,electrical,plumbing")

// Territory
resource.setValue("territory", territorySysId)

// Availability
resource.setValue("work_schedule", scheduleId)

// Vehicle/Equipment
resource.setValue("vehicle", vehicleCISysId)

// Active
resource.setValue("active", true)

resource.insert()
```

### Check Technician Availability

```javascript
// Get available technicians for time slot (ES5 ONLY!)
function getAvailableTechnicians(scheduledStart, scheduledEnd, requiredSkills, territory) {
  var available = []

  // Get all active technicians in territory
  var resource = new GlideRecord("wm_resource")
  resource.addQuery("active", true)
  if (territory) {
    resource.addQuery("territory", territory)
  }
  resource.query()

  while (resource.next()) {
    // Check skills
    if (requiredSkills && !hasRequiredSkills(resource, requiredSkills)) {
      continue
    }

    // Check availability
    if (!isAvailable(resource, scheduledStart, scheduledEnd)) {
      continue
    }

    var user = resource.user.getRefRecord()
    available.push({
      resource_sys_id: resource.getUniqueValue(),
      user_sys_id: user.getUniqueValue(),
      name: user.getDisplayValue(),
      skills: resource.getValue("skills"),
      territory: resource.territory.getDisplayValue(),
    })
  }

  return available
}

function hasRequiredSkills(resource, requiredSkills) {
  var techSkills = resource.getValue("skills").split(",")
  var required = requiredSkills.split(",")

  for (var i = 0; i < required.length; i++) {
    if (techSkills.indexOf(required[i].trim()) === -1) {
      return false
    }
  }
  return true
}

function isAvailable(resource, start, end) {
  // Check for conflicting assignments
  var assignment = new GlideRecord("wm_schedule_entry")
  assignment.addQuery("resource", resource.getUniqueValue())
  assignment.addQuery("start", "<", end)
  assignment.addQuery("end", ">", start)
  assignment.query()

  return !assignment.hasNext()
}
```

## Dispatch & Scheduling (ES5)

### Assign Work Order

```javascript
// Dispatch work order to technician (ES5 ONLY!)
function dispatchWorkOrder(workOrderSysId, resourceSysId, scheduledStart, scheduledEnd) {
  // Create schedule entry
  var schedule = new GlideRecord("wm_schedule_entry")
  schedule.initialize()
  schedule.setValue("work_order", workOrderSysId)
  schedule.setValue("resource", resourceSysId)
  schedule.setValue("start", scheduledStart)
  schedule.setValue("end", scheduledEnd)
  schedule.setValue("state", "scheduled")
  schedule.insert()

  // Update work order
  var wo = new GlideRecord("wm_order")
  if (wo.get(workOrderSysId)) {
    wo.setValue("assigned_to", getResourceUser(resourceSysId))
    wo.setValue("scheduled_start", scheduledStart)
    wo.setValue("scheduled_end", scheduledEnd)
    wo.setValue("state", "assigned")
    wo.update()
  }

  // Notify technician
  gs.eventQueue("wm.work_order.assigned", wo, resourceSysId, "")

  return schedule.getUniqueValue()
}
```

### Auto-Dispatch

```javascript
// Auto-dispatch to best available technician (ES5 ONLY!)
function autoDispatch(workOrderSysId) {
  var wo = new GlideRecord("wm_order")
  if (!wo.get(workOrderSysId)) {
    return { success: false, message: "Work order not found" }
  }

  // Get requirements
  var scheduledStart = new GlideDateTime(wo.getValue("scheduled_start"))
  var estimatedDuration = wo.getValue("estimated_duration") || "02:00:00"

  var scheduledEnd = new GlideDateTime(scheduledStart)
  var durationParts = estimatedDuration.split(":")
  scheduledEnd.addSeconds(
    parseInt(durationParts[0], 10) * 3600 + parseInt(durationParts[1], 10) * 60 + parseInt(durationParts[2], 10),
  )

  var requiredSkills = wo.getValue("u_required_skills")
  var location = wo.location.getRefRecord()
  var territory = location.getValue("u_territory")

  // Find available technicians
  var available = getAvailableTechnicians(scheduledStart, scheduledEnd, requiredSkills, territory)

  if (available.length === 0) {
    return { success: false, message: "No available technicians" }
  }

  // Select best match (first available, could add routing optimization)
  var bestMatch = available[0]

  // Dispatch
  var scheduleId = dispatchWorkOrder(workOrderSysId, bestMatch.resource_sys_id, scheduledStart, scheduledEnd)

  return {
    success: true,
    technician: bestMatch.name,
    schedule_id: scheduleId,
  }
}
```

## Mobile Field Service (ES5)

### Update Work Order Status (Mobile)

```javascript
// Update from mobile app (ES5 ONLY!)
function updateWorkOrderFromMobile(workOrderSysId, statusUpdate) {
  var wo = new GlideRecord("wm_order")
  if (!wo.get(workOrderSysId)) {
    return { success: false, message: "Work order not found" }
  }

  // Update state
  if (statusUpdate.state) {
    wo.setValue("state", statusUpdate.state)

    if (statusUpdate.state === "work_in_progress") {
      wo.setValue("actual_start", new GlideDateTime())
    } else if (statusUpdate.state === "closed_complete") {
      wo.setValue("actual_end", new GlideDateTime())
    }
  }

  // Add work notes
  if (statusUpdate.notes) {
    wo.work_notes = statusUpdate.notes
  }

  // Update location (GPS)
  if (statusUpdate.latitude && statusUpdate.longitude) {
    wo.setValue("u_technician_latitude", statusUpdate.latitude)
    wo.setValue("u_technician_longitude", statusUpdate.longitude)
  }

  wo.update()

  return { success: true }
}
```

### Record Time Entry

```javascript
// Record technician time (ES5 ONLY!)
function recordTimeEntry(workOrderSysId, timeData) {
  var entry = new GlideRecord("time_card")
  entry.initialize()

  entry.setValue("task", workOrderSysId)
  entry.setValue("user", gs.getUserID())
  entry.setValue("type", timeData.type) // work, travel, break

  entry.setValue("start_time", timeData.startTime)
  entry.setValue("end_time", timeData.endTime)

  // Calculate duration
  var start = new GlideDateTime(timeData.startTime)
  var end = new GlideDateTime(timeData.endTime)
  var duration = GlideDateTime.subtract(start, end)
  entry.setValue("duration", duration)

  // Notes
  entry.setValue("comments", timeData.notes)

  return entry.insert()
}
```

## MCP Tool Integration

### Available Tools

| Tool                   | Purpose                              |
| ---------------------- | ------------------------------------ |
| `snow_query_table`     | Query FSM tables                     |
| `snow_execute_script`  | Test FSM scripts                     |
| `snow_artifact_manage` | Find configurations (action='find')  |

### Example Workflow

```javascript
// 1. Query open work orders
await snow_query_table({
  table: "wm_order",
  query: "state!=closed_complete^state!=cancelled",
  fields: "number,short_description,location,scheduled_start,assigned_to",
})

// 2. Find available technicians
await snow_execute_script({
  script: `
        var available = getAvailableTechnicians(
            new GlideDateTime(),
            new GlideDateTime().addHours(2),
            'hvac_certified',
            null
        );
        gs.info(JSON.stringify(available));
    `,
})

// 3. Get technician schedule
await snow_query_table({
  table: "wm_schedule_entry",
  query: "resource.user=technician_user_id^startONToday",
  fields: "work_order,start,end,state",
})
```

## Best Practices

1. **Skills Matching** - Match technician skills to requirements
2. **Territory Planning** - Optimize service areas
3. **Route Optimization** - Minimize travel time
4. **Mobile-First** - Design for field use
5. **Real-Time Updates** - GPS and status tracking
6. **Parts Management** - Track inventory
7. **Time Tracking** - Accurate time entries
8. **ES5 Only** - No modern JavaScript syntax
