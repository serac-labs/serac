---
name: mid-server
description: Communicate with ServiceNow MID Servers via the ECC queue — send Command/JSProbe/PowerShell/SSHCommand payloads to ecc_agent, build custom probes/sensors, and monitor MID health on ecc_agent.
license: Apache-2.0
compatibility: Designed for Serac and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_query_table
  - snow_artifact_manage
  - snow_execute_script
---

# MID Server for ServiceNow

MID Server enables ServiceNow to communicate with resources inside your network.

## MID Server Architecture

```
ServiceNow Instance
    ↓ ECC Queue
MID Server
    ├── Probes (Outbound)
    │   └── Commands sent TO MID
    ├── Sensors (Inbound)
    │   └── Results sent FROM MID
    └── Script Execution
```

## Key Tables

| Table                  | Purpose                   |
| ---------------------- | ------------------------- |
| `ecc_agent`            | MID Server records        |
| `ecc_queue`            | Input/Output queue        |
| `discovery_probes`     | Probe definitions         |
| `discovery_sensors`    | Sensor definitions        |
| `sys_script_execution` | Script execution requests |

## ECC Queue Communication (ES5)

### Send Command to MID Server

```javascript
// Send command via ECC queue (ES5 ONLY!)
function sendMIDCommand(midServerName, command, parameters) {
  var mid = getMIDServer(midServerName)
  if (!mid) {
    gs.error("MID Server not found: " + midServerName)
    return null
  }

  var ecc = new GlideRecord("ecc_queue")
  ecc.initialize()

  // ECC Queue settings
  ecc.setValue("agent", mid.getUniqueValue())
  ecc.setValue("topic", "Command")
  ecc.setValue("name", command)
  ecc.setValue("source", "CustomScript")

  // Parameters as payload
  ecc.setValue("payload", buildPayload(parameters))

  // Direction: output = to MID, input = from MID
  ecc.setValue("queue", "output")

  // State
  ecc.setValue("state", "ready")

  return ecc.insert()
}

function getMIDServer(name) {
  var mid = new GlideRecord("ecc_agent")
  mid.addQuery("name", name)
  mid.addQuery("status", "Up")
  mid.query()
  if (mid.next()) {
    return mid
  }
  return null
}

function buildPayload(params) {
  var xml = '<?xml version="1.0" encoding="UTF-8"?>'
  xml += "<parameters>"
  for (var key in params) {
    if (params.hasOwnProperty(key)) {
      xml += '<parameter name="' + key + '">'
      xml += "<value>" + escapeXML(params[key]) + "</value>"
      xml += "</parameter>"
    }
  }
  xml += "</parameters>"
  return xml
}

function escapeXML(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}
```

### Monitor ECC Response

```javascript
// Wait for ECC queue response (ES5 ONLY!)
function waitForECCResponse(eccSysId, timeoutSeconds) {
  var startTime = new Date().getTime()
  var timeout = timeoutSeconds * 1000

  while (true) {
    // Check for response
    var response = new GlideRecord("ecc_queue")
    response.addQuery("response_to", eccSysId)
    response.addQuery("queue", "input")
    response.query()

    if (response.next()) {
      return {
        success: response.getValue("state") === "processed",
        payload: response.getValue("payload"),
        error: response.getValue("error_string"),
      }
    }

    // Check timeout
    if (new Date().getTime() - startTime > timeout) {
      return {
        success: false,
        error: "Timeout waiting for MID response",
      }
    }

    // Wait before retry
    gs.sleep(1000)
  }
}
```

## MID Server Scripts (ES5)

### Execute Script on MID

```javascript
// Execute JavaScript on MID Server (ES5 ONLY!)
function executeMIDScript(midServerName, script) {
  var mid = getMIDServer(midServerName)
  if (!mid) {
    return { success: false, error: "MID Server not found" }
  }

  var ecc = new GlideRecord("ecc_queue")
  ecc.initialize()
  ecc.setValue("agent", mid.getUniqueValue())
  ecc.setValue("topic", "JSProbe")
  ecc.setValue("name", "Custom Script Execution")

  // Script payload
  var payload = '<?xml version="1.0" encoding="UTF-8"?>'
  payload += "<parameters>"
  payload += '<parameter name="script"><value><![CDATA[' + script + "]]></value></parameter>"
  payload += "</parameters>"

  ecc.setValue("payload", payload)
  ecc.setValue("queue", "output")
  ecc.setValue("state", "ready")

  var eccSysId = ecc.insert()

  return {
    success: true,
    ecc_sys_id: eccSysId,
  }
}

// Example: Check disk space on remote server
var diskCheckScript = [
  "var output = {};",
  "try {",
  '    var cmd = "df -h /";',
  "    var result = Packages.com.service_now.mid.probe.tpcon.OperatingSystemCommand.execute(cmd);",
  "    output.disk_info = result.getOutput();",
  "    output.success = true;",
  "} catch (e) {",
  "    output.success = false;",
  "    output.error = e.message;",
  "}",
  "output;",
].join("\n")
```

## Custom Probes (ES5)

### Create Probe

```javascript
// Create custom probe (ES5 ONLY!)
var probe = new GlideRecord("discovery_probes")
probe.initialize()

probe.setValue("name", "Custom Application Status")
probe.setValue("short_description", "Check custom application status")
probe.setValue("active", true)

// Probe type
probe.setValue("mid_type", "probe")

// Trigger type
probe.setValue("triggered_by", "on_demand")

// Probe script (runs on MID Server - ES5/Rhino!)
probe.setValue(
  "script",
  "var output = {};\n" +
    "\n" +
    "// Get parameters\n" +
    'var host = probe.getParameter("host");\n' +
    'var port = probe.getParameter("port");\n' +
    "\n" +
    "try {\n" +
    "    // Execute health check\n" +
    '    var url = "http://" + host + ":" + port + "/health";\n' +
    "    var conn = new java.net.URL(url).openConnection();\n" +
    '    conn.setRequestMethod("GET");\n' +
    "    conn.setConnectTimeout(5000);\n" +
    "    conn.setReadTimeout(5000);\n" +
    "    \n" +
    "    var responseCode = conn.getResponseCode();\n" +
    '    output.status = (responseCode === 200) ? "healthy" : "unhealthy";\n' +
    "    output.response_code = responseCode;\n" +
    "    output.success = true;\n" +
    "} catch (e) {\n" +
    '    output.status = "unreachable";\n' +
    "    output.error = e.message;\n" +
    "    output.success = false;\n" +
    "}\n" +
    "\n" +
    "output;",
)

probe.insert()
```

### Create Sensor

```javascript
// Create sensor to process probe results (ES5 ONLY!)
var sensor = new GlideRecord("discovery_sensors")
sensor.initialize()

sensor.setValue("name", "Process Application Status")
sensor.setValue("short_description", "Process custom application status results")
sensor.setValue("active", true)

// Link to probe
sensor.setValue("triggered_by", probeSysId)

// Sensor script (runs on ServiceNow instance - ES5!)
sensor.setValue(
  "script",
  "(function process(result, source) {\n" +
    "    var output = JSON.parse(result.output);\n" +
    "    \n" +
    "    // Find or create application CI\n" +
    '    var appCI = new GlideRecord("cmdb_ci_appl");\n' +
    '    appCI.addQuery("name", source.getParameter("app_name"));\n' +
    "    appCI.query();\n" +
    "    \n" +
    "    if (!appCI.next()) {\n" +
    "        appCI.initialize();\n" +
    '        appCI.name = source.getParameter("app_name");\n' +
    "        appCI.insert();\n" +
    "    }\n" +
    "    \n" +
    "    // Update status\n" +
    "    appCI.u_health_status = output.status;\n" +
    "    appCI.u_last_health_check = new GlideDateTime();\n" +
    "    appCI.update();\n" +
    "    \n" +
    "    // Create event if unhealthy\n" +
    '    if (output.status !== "healthy") {\n' +
    "        createHealthAlert(appCI, output);\n" +
    "    }\n" +
    "})(result, source);",
)

sensor.insert()
```

## Orchestration (ES5)

### Remote PowerShell

```javascript
// Execute PowerShell on Windows server (ES5 ONLY!)
function executeRemotePowerShell(midServerName, targetHost, script, credential) {
  var payload = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<parameters>",
    '  <parameter name="host"><value>' + targetHost + "</value></parameter>",
    '  <parameter name="credential_id"><value>' + credential + "</value></parameter>",
    '  <parameter name="script"><value><![CDATA[' + script + "]]></value></parameter>",
    "</parameters>",
  ].join("\n")

  var mid = getMIDServer(midServerName)
  if (!mid) {
    return { success: false, error: "MID Server not found" }
  }

  var ecc = new GlideRecord("ecc_queue")
  ecc.initialize()
  ecc.setValue("agent", mid.getUniqueValue())
  ecc.setValue("topic", "PowerShell")
  ecc.setValue("name", "Remote PowerShell Execution")
  ecc.setValue("payload", payload)
  ecc.setValue("queue", "output")
  ecc.setValue("state", "ready")

  return {
    success: true,
    ecc_sys_id: ecc.insert(),
  }
}
```

### Remote SSH

```javascript
// Execute SSH command (ES5 ONLY!)
function executeRemoteSSH(midServerName, targetHost, command, credential) {
  var payload = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<parameters>",
    '  <parameter name="host"><value>' + targetHost + "</value></parameter>",
    '  <parameter name="credential_id"><value>' + credential + "</value></parameter>",
    '  <parameter name="command"><value>' + escapeXML(command) + "</value></parameter>",
    "</parameters>",
  ].join("\n")

  var mid = getMIDServer(midServerName)
  if (!mid) {
    return { success: false, error: "MID Server not found" }
  }

  var ecc = new GlideRecord("ecc_queue")
  ecc.initialize()
  ecc.setValue("agent", mid.getUniqueValue())
  ecc.setValue("topic", "SSHCommand")
  ecc.setValue("name", "Remote SSH Execution")
  ecc.setValue("payload", payload)
  ecc.setValue("queue", "output")
  ecc.setValue("state", "ready")

  return {
    success: true,
    ecc_sys_id: ecc.insert(),
  }
}
```

## MID Server Monitoring (ES5)

### Check MID Status

```javascript
// Get MID Server status (ES5 ONLY!)
function getMIDServerStatus() {
  var servers = []

  var mid = new GlideRecord("ecc_agent")
  mid.addQuery("status", "!=", "Decommissioned")
  mid.query()

  while (mid.next()) {
    servers.push({
      name: mid.getValue("name"),
      status: mid.getValue("status"),
      ip: mid.getValue("ip_address"),
      version: mid.getValue("version"),
      validated: mid.getValue("validated"),
      last_refreshed: mid.getValue("last_refreshed"),
      host_name: mid.getValue("host_name"),
    })
  }

  return servers
}
```

## MCP Tool Integration

### Available Tools

| Tool                                  | Purpose                  |
| ------------------------------------- | ------------------------ |
| `snow_query_table`                    | Query MID and ECC tables |
| `snow_artifact_manage` (action='find') | Find probes/sensors      |
| `snow_execute_script`                 | Test MID scripts         |

### Example Workflow

```javascript
// 1. Check MID Server status
await snow_query_table({
  table: "ecc_agent",
  query: "status=Up",
  fields: "name,ip_address,version,last_refreshed",
})

// 2. Query ECC queue
await snow_query_table({
  table: "ecc_queue",
  query: "queue=output^state=ready",
  fields: "agent,topic,name,state,sys_created_on",
})

// 3. Find probes
await snow_query_table({
  table: "discovery_probes",
  query: "active=true",
  fields: "name,short_description,mid_type",
})
```

## Best Practices

1. **Credentials** - Never hardcode in scripts
2. **Error Handling** - Handle network failures
3. **Timeouts** - Set appropriate timeouts
4. **Logging** - Log for troubleshooting
5. **Security** - Limit MID access
6. **Monitoring** - Track MID health
7. **Load Balancing** - Multiple MIDs for HA
8. **ES5 Only** - No modern JavaScript syntax
