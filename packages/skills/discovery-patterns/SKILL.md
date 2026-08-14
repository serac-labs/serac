---
name: discovery-patterns
description: Configure ServiceNow Discovery — schedules, IP ranges, credential affinities, MID Server assignment, custom probes/sensors, identification rules, and run-status monitoring on discovery_* tables.
license: Apache-2.0
compatibility: Designed for Snow-Code and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_asset_discovery
  - snow_cmdb_search
  - snow_query_table
  - snow_execute_script
---

# Discovery Patterns for ServiceNow

Discovery automatically populates the CMDB by scanning networks and systems.

## Discovery Architecture

```
Discovery Schedule
    ↓
MID Server
    ↓
Probes (collect data)
    ↓
Sensors (process data)
    ↓
Identification Rules (match/create CIs)
    ↓
CMDB Population
```

## Key Tables

| Table                      | Purpose               |
| -------------------------- | --------------------- |
| `discovery_schedule`       | Discovery schedules   |
| `discovery_credentials`    | Discovery credentials |
| `discovery_range`          | IP ranges to scan     |
| `cmdb_identification_rule` | CI identification     |
| `ecc_agent`                | MID Server records    |
| `discovery_status`         | Discovery run status  |

## Discovery Schedules (ES5)

### Create Discovery Schedule

```javascript
// Create discovery schedule (ES5 ONLY!)
var schedule = new GlideRecord("discovery_schedule")
schedule.initialize()

// Basic info
schedule.setValue("name", "Data Center Discovery")
schedule.setValue("description", "Weekly discovery of data center infrastructure")

// Type
schedule.setValue("discover", "IP") // IP, CI, Cloud Resources

// Schedule
schedule.setValue("run_type", "weekly")
schedule.setValue("run_dayofweek", "sunday")
schedule.setValue("run_time", "02:00:00")

// MID Server
schedule.setValue("mid_server", getMIDServerSysId("DataCenterMID"))

// Enable
schedule.setValue("active", true)

var scheduleSysId = schedule.insert()

// Add IP range
addDiscoveryRange(scheduleSysId, "10.0.0.0", "10.0.255.255", "Data Center Network")
```

### Add Discovery Range

```javascript
// Add IP range to discovery schedule (ES5 ONLY!)
function addDiscoveryRange(scheduleSysId, startIP, endIP, name) {
  var range = new GlideRecord("discovery_range")
  range.initialize()
  range.setValue("schedule", scheduleSysId)
  range.setValue("name", name)
  range.setValue("type", "range")
  range.setValue("range_start", startIP)
  range.setValue("range_end", endIP)
  range.setValue("active", true)
  return range.insert()
}

// Add CIDR range
function addDiscoveryCIDR(scheduleSysId, cidr, name) {
  var range = new GlideRecord("discovery_range")
  range.initialize()
  range.setValue("schedule", scheduleSysId)
  range.setValue("name", name)
  range.setValue("type", "cidr")
  range.setValue("range", cidr) // e.g., '10.0.0.0/24'
  range.setValue("active", true)
  return range.insert()
}
```

## Discovery Credentials (ES5)

### Create Credentials

```javascript
// Create Windows credential (ES5 ONLY!)
var cred = new GlideRecord("discovery_credentials")
cred.initialize()
cred.setValue("name", "Windows Domain Admin")
cred.setValue("type", "windows")
cred.setValue("user_name", "domain\\admin")
cred.setValue("password", "") // Set via secure method
cred.setValue("active", true)

// Credential order
cred.setValue("order", 100)

// Assign to credential affinity
cred.setValue("credential_alias", credentialAliasSysId)

cred.insert()
```

### Credential Affinity

```javascript
// Create credential affinity (map credentials to IP ranges) (ES5 ONLY!)
var affinity = new GlideRecord("dscy_credentials_affinity")
affinity.initialize()
affinity.setValue("credential", credentialSysId)
affinity.setValue("range", discoveryRangeSysId)
affinity.setValue("order", 100)
affinity.insert()
```

## Custom Probes and Sensors (ES5)

### Custom Probe

```javascript
// Create custom probe script (ES5 ONLY!)
// Probes run on MID Server to collect data

// Table: discovery_probes_script
var probe = new GlideRecord("discovery_probes_script")
probe.initialize()
probe.setValue("name", "Custom Application Version")
probe.setValue("active", true)

// Probe script (runs on MID Server - ES5 ONLY!)
probe.setValue(
  "script",
  "var output = {};\n" +
    "\n" +
    "// Command to run\n" +
    'var cmd = "cat /opt/myapp/version.txt";\n' +
    "\n" +
    "try {\n" +
    "    var result = Packages.com.service_now.mid.probe.tpcon.OperatingSystemCommand.execute(cmd);\n" +
    "    output.app_version = result.getOutput().trim();\n" +
    "    output.success = true;\n" +
    "} catch (e) {\n" +
    "    output.success = false;\n" +
    "    output.error = e.message;\n" +
    "}\n" +
    "\n" +
    "output;",
)

probe.insert()
```

### Custom Sensor

```javascript
// Create custom sensor (ES5 ONLY!)
// Sensors run on ServiceNow instance to process probe results

// Table: discovery_sensors_script
var sensor = new GlideRecord("discovery_sensors_script")
sensor.initialize()
sensor.setValue("name", "Process Custom Application Version")
sensor.setValue("active", true)
sensor.setValue("probe", probeSysId)

// Sensor script (runs on instance - ES5 ONLY!)
sensor.setValue(
  "script",
  "(function process(result, source) {\n" +
    "    var output = JSON.parse(result.output);\n" +
    "    \n" +
    "    if (!output.success) {\n" +
    '        gs.warn("Custom app discovery failed: " + output.error);\n' +
    "        return;\n" +
    "    }\n" +
    "    \n" +
    "    // Find or create CI\n" +
    "    var ci = source.getDeviceRecord();\n" +
    "    if (ci) {\n" +
    "        ci.u_custom_app_version = output.app_version;\n" +
    "        ci.update();\n" +
    '        gs.info("Updated CI with app version: " + output.app_version);\n' +
    "    }\n" +
    "})(result, source);",
)

sensor.insert()
```

## Identification Rules (ES5)

### CI Identification Rule

```javascript
// Create identification rule (ES5 ONLY!)
var rule = new GlideRecord("cmdb_identifier")
rule.initialize()

rule.setValue("name", "Server Identification")
rule.setValue("table", "cmdb_ci_server")
rule.setValue("active", true)

// Priority (lower = higher priority)
rule.setValue("order", 100)

// Identification entries (criteria)
rule.insert()

// Add identification criteria
var entry = new GlideRecord("cmdb_identifier_entry")
entry.initialize()
entry.setValue("identifier", rule.getUniqueValue())
entry.setValue("criterion_attributes", "serial_number") // Match by serial
entry.setValue("search_type", "equals")
entry.setValue("active", true)
entry.insert()
```

### Custom Identification Script

```javascript
// Identification script for complex matching (ES5 ONLY!)
// Table: cmdb_identifier_script

var script = new GlideRecord("cmdb_identifier_script")
script.initialize()
script.setValue("name", "Custom Server Match")
script.setValue("table", "cmdb_ci_server")
script.setValue("active", true)

script.setValue(
  "script",
  "(function identify(source) {\n" +
    '    var serial = source.getValue("serial_number");\n' +
    '    var hostname = source.getValue("name");\n' +
    "    \n" +
    "    // Try serial match first\n" +
    '    var gr = new GlideRecord("cmdb_ci_server");\n' +
    "    if (serial) {\n" +
    '        gr.addQuery("serial_number", serial);\n' +
    "        gr.query();\n" +
    "        if (gr.next()) {\n" +
    "            return gr.getUniqueValue();\n" +
    "        }\n" +
    "    }\n" +
    "    \n" +
    "    // Try hostname + IP match\n" +
    '    gr = new GlideRecord("cmdb_ci_server");\n' +
    '    gr.addQuery("name", hostname);\n' +
    '    gr.addQuery("ip_address", source.getValue("ip_address"));\n' +
    "    gr.query();\n" +
    "    if (gr.next()) {\n" +
    "        return gr.getUniqueValue();\n" +
    "    }\n" +
    "    \n" +
    "    // No match - return null to create new CI\n" +
    "    return null;\n" +
    "})(source);",
)

script.insert()
```

## Discovery Status (ES5)

### Monitor Discovery Status

```javascript
// Check discovery run status (ES5 ONLY!)
function getDiscoveryStatus(scheduleSysId) {
  var status = new GlideRecord("discovery_status")
  status.addQuery("dscheduler", scheduleSysId)
  status.orderByDesc("sys_created_on")
  status.setLimit(1)
  status.query()

  if (status.next()) {
    return {
      state: status.state.getDisplayValue(),
      started: status.getValue("started"),
      completed: status.getValue("completed"),
      devices_found: status.getValue("devices_found"),
      devices_completed: status.getValue("devices_completed"),
      errors: status.getValue("error_count"),
    }
  }
  return null
}
```

### Discovery Device Results

```javascript
// Get discovered devices from a run (ES5 ONLY!)
function getDiscoveredDevices(statusSysId) {
  var devices = []

  var device = new GlideRecord("discovery_device_history")
  device.addQuery("status", statusSysId)
  device.query()

  while (device.next()) {
    devices.push({
      ip_address: device.getValue("source"),
      ci: device.cmdb_ci.getDisplayValue(),
      ci_class: device.getValue("ci_type"),
      state: device.state.getDisplayValue(),
      issues: device.getValue("issue_count"),
    })
  }

  return devices
}
```

## MCP Tool Integration

### Available Tools

| Tool                   | Purpose                          |
| ---------------------- | -------------------------------- |
| `snow_query_table`     | Query discovery tables           |
| `snow_artifact_manage` | Find artifacts (`action='find'`) |
| `snow_execute_script`  | Test discovery scripts           |
| `snow_cmdb_search`     | Search discovered CIs            |

### Example Workflow

```javascript
// 1. Query active schedules
await snow_query_table({
  table: "discovery_schedule",
  query: "active=true",
  fields: "name,discover,run_type,mid_server",
})

// 2. Check recent discovery status
await snow_execute_script({
  script: `
        var status = getDiscoveryStatus('schedule_sys_id');
        gs.info(JSON.stringify(status));
    `,
})

// 3. Find discovery errors
await snow_query_table({
  table: "discovery_log",
  query: "level=error^sys_created_on>=javascript:gs.daysAgo(1)",
  fields: "message,source,sys_created_on",
})
```

## Best Practices

1. **Credential Security** - Use credential vault
2. **Schedule Off-Peak** - Minimize network impact
3. **Range Management** - Organize by network segment
4. **MID Server** - Proper placement and sizing
5. **Identification** - Clear matching criteria
6. **Reconciliation** - Regular CMDB validation
7. **Monitoring** - Track discovery health
8. **ES5 Only** - No modern JavaScript syntax
