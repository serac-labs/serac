/**
 * snow_test_mid_connectivity - Test MID Server connectivity
 *
 * Test connectivity from MID Servers to external endpoints,
 * validate network paths, and diagnose connection issues.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_test_mid_connectivity",
  description: "Test MID Server connectivity to external endpoints and diagnose network issues",
  category: "integration",
  subcategory: "mid-server",
  use_cases: ["mid-server", "connectivity", "troubleshooting", "network"],
  complexity: "intermediate",
  frequency: "medium",

  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["test_endpoint", "test_port", "ping", "dns_lookup", "traceroute", "full_diagnostic"],
        description: "Type of connectivity test to perform",
        default: "test_endpoint",
      },
      mid_server_name: {
        type: "string",
        description: "Name of the MID Server to test from",
      },
      mid_server_id: {
        type: "string",
        description: "sys_id of the MID Server to test from",
      },
      target_host: {
        type: "string",
        description: "Target hostname or IP address",
      },
      target_port: {
        type: "number",
        description: "Target port number (for port test)",
        default: 443,
      },
      target_url: {
        type: "string",
        description: "Full URL to test (for endpoint test)",
      },
      timeout_seconds: {
        type: "number",
        description: "Timeout for the test in seconds",
        default: 30,
      },
      protocol: {
        type: "string",
        enum: ["tcp", "udp", "http", "https"],
        description: "Protocol to use for port test",
        default: "tcp",
      },
    },
    required: ["action"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  var action = args.action || "test_endpoint"
  var mid_server_name = args.mid_server_name || ""
  var mid_server_id = args.mid_server_id || ""
  var target_host = args.target_host || ""
  var target_port = args.target_port || 443
  var target_url = args.target_url || ""
  var timeout_seconds = args.timeout_seconds || 30
  var protocol = args.protocol || "tcp"

  try {
    var client = await getAuthenticatedClient(context)

    // Resolve MID Server ID if name provided
    var midId = mid_server_id
    if (!midId && mid_server_name) {
      var lookupResponse = await client.get("/api/now/table/ecc_agent", {
        params: {
          sysparm_query: "name=" + mid_server_name + "^status=Up",
          sysparm_limit: 1,
          sysparm_fields: "sys_id,name,ip_address",
        },
      })

      if (lookupResponse.data.result && lookupResponse.data.result.length > 0) {
        midId = lookupResponse.data.result[0].sys_id
      } else {
        return createErrorResult("MID Server not found or not running: " + mid_server_name)
      }
    }

    // If no MID Server specified, list available ones
    if (!midId) {
      var availableResponse = await client.get("/api/now/table/ecc_agent", {
        params: {
          sysparm_query: "status=Up^validated=true",
          sysparm_limit: 10,
          sysparm_fields: "sys_id,name,ip_address,host_name",
        },
      })

      var available = availableResponse.data.result || []

      return createSuccessResult({
        action: "list_available",
        message: "No MID Server specified. Available MID Servers:",
        mid_servers: available.map(function (m: any) {
          return {
            sys_id: m.sys_id,
            name: m.name,
            ip_address: m.ip_address,
            host_name: m.host_name,
          }
        }),
        usage: "Provide mid_server_name or mid_server_id to run connectivity tests",
      })
    }

    // Get MID Server details
    var midDetails = await client.get("/api/now/table/ecc_agent/" + midId, {
      params: {
        sysparm_fields: "name,ip_address,host_name,status",
      },
    })

    var midServer = midDetails.data.result

    if (action === "test_endpoint") {
      if (!target_url) {
        return createErrorResult("target_url is required for test_endpoint action")
      }

      // Queue an HTTP probe via ECC queue
      var probeScript = `
        var probe = new GlideRecord('ecc_queue');
        probe.initialize();
        probe.agent = ${JSON.stringify(midId)};
        probe.topic = 'Probe';
        probe.name = 'HTTPProbe';
        probe.source = 'snow-flow-connectivity-test';
        probe.queue = 'output';

        var payload = {
          url: ${JSON.stringify(target_url)},
          timeout: ${timeout_seconds * 1000}
        };
        probe.payload = JSON.stringify(payload);

        var sysId = probe.insert();

        // Wait briefly for response
        var response = new GlideRecord('ecc_queue');
        response.addQuery('source', probe.sys_id);
        response.addQuery('queue', 'input');
        response.setLimit(1);

        var maxWait = ${timeout_seconds};
        var waited = 0;
        var result = null;

        while (waited < maxWait && !result) {
          gs.sleep(1000);
          waited++;
          response.query();
          if (response.next()) {
            result = {
              success: true,
              response_received: true,
              payload: response.payload.toString()
            };
          }
        }

        if (!result) {
          result = {
            success: true,
            response_received: false,
            message: 'Probe queued, check ECC queue for results',
            ecc_queue_id: sysId
          };
        }

        gs.print(JSON.stringify(result));
      `

      var probeResponse = await client.post("/api/now/table/sys_script_execution", {
        script: probeScript,
        description: "Test endpoint from MID: " + target_url,
      })

      var probeOutput = probeResponse.data.result?.output || ""
      var probeMatch = probeOutput.match(/\{[\s\S]*\}/)
      var probeResult = probeMatch ? JSON.parse(probeMatch[0]) : { success: false, error: "Unknown error" }

      return createSuccessResult({
        action: "test_endpoint",
        mid_server: {
          name: midServer.name,
          ip_address: midServer.ip_address,
        },
        target: target_url,
        result: probeResult,
      })
    } else if (action === "test_port") {
      if (!target_host) {
        return createErrorResult("target_host is required for test_port action")
      }

      // Queue a port test via ECC queue
      var portTestScript = `
        var probe = new GlideRecord('ecc_queue');
        probe.initialize();
        probe.agent = ${JSON.stringify(midId)};
        probe.topic = 'Probe';
        probe.name = 'TCPProbe';
        probe.source = 'snow-flow-port-test';
        probe.queue = 'output';

        var payload = {
          host: ${JSON.stringify(target_host)},
          port: ${target_port},
          protocol: ${JSON.stringify(protocol)},
          timeout: ${timeout_seconds * 1000}
        };
        probe.payload = JSON.stringify(payload);

        var sysId = probe.insert();

        gs.print(JSON.stringify({
          success: true,
          message: 'Port test queued',
          ecc_queue_id: sysId,
          target: ${JSON.stringify(target_host)} + ':' + ${target_port}
        }));
      `

      var portTestResponse = await client.post("/api/now/table/sys_script_execution", {
        script: portTestScript,
        description: "Test port from MID: " + target_host + ":" + target_port,
      })

      var portOutput = portTestResponse.data.result?.output || ""
      var portMatch = portOutput.match(/\{[^}]+\}/)
      var portResult = portMatch ? JSON.parse(portMatch[0]) : { success: false, error: "Unknown error" }

      return createSuccessResult({
        action: "test_port",
        mid_server: {
          name: midServer.name,
          ip_address: midServer.ip_address,
        },
        target: {
          host: target_host,
          port: target_port,
          protocol: protocol,
        },
        result: portResult,
        note: "Check ECC queue for actual test results",
      })
    } else if (action === "ping") {
      if (!target_host) {
        return createErrorResult("target_host is required for ping action")
      }

      var pingScript = `
        var probe = new GlideRecord('ecc_queue');
        probe.initialize();
        probe.agent = ${JSON.stringify(midId)};
        probe.topic = 'Probe';
        probe.name = 'ICMPProbe';
        probe.source = 'snow-flow-ping-test';
        probe.queue = 'output';

        var payload = {
          host: ${JSON.stringify(target_host)},
          count: 4,
          timeout: ${timeout_seconds * 1000}
        };
        probe.payload = JSON.stringify(payload);

        var sysId = probe.insert();

        gs.print(JSON.stringify({
          success: true,
          message: 'Ping test queued',
          ecc_queue_id: sysId,
          target: ${JSON.stringify(target_host)}
        }));
      `

      var pingResponse = await client.post("/api/now/table/sys_script_execution", {
        script: pingScript,
        description: "Ping from MID: " + target_host,
      })

      var pingOutput = pingResponse.data.result?.output || ""
      var pingMatch = pingOutput.match(/\{[^}]+\}/)
      var pingResult = pingMatch ? JSON.parse(pingMatch[0]) : { success: false, error: "Unknown error" }

      return createSuccessResult({
        action: "ping",
        mid_server: {
          name: midServer.name,
          ip_address: midServer.ip_address,
        },
        target: target_host,
        result: pingResult,
        note: "Check ECC queue for ping results",
      })
    } else if (action === "dns_lookup") {
      if (!target_host) {
        return createErrorResult("target_host is required for dns_lookup action")
      }

      var dnsScript = `
        var probe = new GlideRecord('ecc_queue');
        probe.initialize();
        probe.agent = ${JSON.stringify(midId)};
        probe.topic = 'Probe';
        probe.name = 'DNSProbe';
        probe.source = 'snow-flow-dns-test';
        probe.queue = 'output';

        var payload = {
          hostname: ${JSON.stringify(target_host)},
          timeout: ${timeout_seconds * 1000}
        };
        probe.payload = JSON.stringify(payload);

        var sysId = probe.insert();

        gs.print(JSON.stringify({
          success: true,
          message: 'DNS lookup queued',
          ecc_queue_id: sysId,
          hostname: ${JSON.stringify(target_host)}
        }));
      `

      var dnsResponse = await client.post("/api/now/table/sys_script_execution", {
        script: dnsScript,
        description: "DNS lookup from MID: " + target_host,
      })

      var dnsOutput = dnsResponse.data.result?.output || ""
      var dnsMatch = dnsOutput.match(/\{[^}]+\}/)
      var dnsResult = dnsMatch ? JSON.parse(dnsMatch[0]) : { success: false, error: "Unknown error" }

      return createSuccessResult({
        action: "dns_lookup",
        mid_server: {
          name: midServer.name,
          ip_address: midServer.ip_address,
        },
        hostname: target_host,
        result: dnsResult,
        note: "Check ECC queue for DNS resolution results",
      })
    } else if (action === "full_diagnostic") {
      if (!target_host && !target_url) {
        return createErrorResult("target_host or target_url is required for full_diagnostic action")
      }

      var diagTarget = target_host || new URL(target_url).hostname
      var diagPort = target_port || (target_url && target_url.startsWith("https") ? 443 : 80)

      // Run multiple tests
      var diagnosticScript = `
        var results = {
          mid_server: ${JSON.stringify(midServer.name)},
          target: ${JSON.stringify(diagTarget)},
          tests: {}
        };

        // Create probes for each test type
        var probes = ['ICMPProbe', 'TCPProbe', 'DNSProbe'];
        var eccIds = [];

        for (var i = 0; i < probes.length; i++) {
          var probe = new GlideRecord('ecc_queue');
          probe.initialize();
          probe.agent = ${JSON.stringify(midId)};
          probe.topic = 'Probe';
          probe.name = probes[i];
          probe.source = 'snow-flow-diagnostic';
          probe.queue = 'output';

          var payload = {};
          if (probes[i] === 'ICMPProbe') {
            payload = { host: ${JSON.stringify(diagTarget)}, count: 2 };
          } else if (probes[i] === 'TCPProbe') {
            payload = { host: ${JSON.stringify(diagTarget)}, port: ${diagPort} };
          } else if (probes[i] === 'DNSProbe') {
            payload = { hostname: ${JSON.stringify(diagTarget)} };
          }
          probe.payload = JSON.stringify(payload);

          var sysId = probe.insert();
          eccIds.push({ probe: probes[i], ecc_id: sysId });
        }

        results.queued_probes = eccIds;
        results.message = 'Diagnostic probes queued. Check ECC queue for results.';
        results.success = true;

        gs.print(JSON.stringify(results));
      `

      var diagResponse = await client.post("/api/now/table/sys_script_execution", {
        script: diagnosticScript,
        description: "Full diagnostic from MID to: " + diagTarget,
      })

      var diagOutput = diagResponse.data.result?.output || ""
      var diagMatch = diagOutput.match(/\{[\s\S]*\}/)
      var diagResult = diagMatch ? JSON.parse(diagMatch[0]) : { success: false, error: "Unknown error" }

      return createSuccessResult({
        action: "full_diagnostic",
        mid_server: {
          name: midServer.name,
          ip_address: midServer.ip_address,
        },
        target: {
          host: diagTarget,
          port: diagPort,
        },
        result: diagResult,
        instructions: [
          "DNS probe will resolve hostname to IP",
          "ICMP probe will test basic connectivity (ping)",
          "TCP probe will test port connectivity",
          "Check ECC queue for detailed results",
          "Use snow_get_logs to view any errors",
        ],
      })
    }

    return createErrorResult("Unknown action: " + action)
  } catch (error: any) {
    if (error.response?.status === 403) {
      return createErrorResult(
        "Permission denied (403): Your ServiceNow user lacks permissions to test MID connectivity. " +
          'Required roles: "mid_server" or "admin".',
      )
    }
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac Team"
