/**
 * snow_confirm_script_execution - Confirm and execute approved script
 *
 * Executes a script after user approval. Only call this after user
 * explicitly approves script execution from snow_execute_script with requireConfirmation=true.
 *
 * Uses sysauto_script + sys_trigger approach for reliable execution.
 *
 * ⚠️ CRITICAL: ALL SCRIPTS MUST BE ES5 ONLY!
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_confirm_script_execution",
  description:
    "⚡ Confirms and schedules script after user approval (use after snow_execute_script with requireConfirmation=true). Note: Uses same scheduled job approach.",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "script-execution",
  use_cases: ["automation", "scripts", "execution"],
  complexity: "advanced",
  frequency: "medium",

  // Permission enforcement
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      script: {
        type: "string",
        description: "The approved script to execute (ES5 only)",
      },
      executionId: {
        type: "string",
        description: "Execution ID from confirmation request",
      },
      userConfirmed: {
        type: "boolean",
        description: "User confirmation (must be true)",
      },
      description: {
        type: "string",
        description: "Description of what the script does",
        default: "Confirmed script execution",
      },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds for polling execution results",
        default: 30000,
      },
    },
    required: ["script", "executionId", "userConfirmed"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { script, executionId, userConfirmed, description = "Confirmed script execution", timeout = 30000 } = args

  try {
    // Security check - must have user confirmation
    if (!userConfirmed) {
      throw new SnowFlowError(ErrorType.INVALID_REQUEST, "User confirmation required for script execution", {
        retryable: false,
      })
    }

    const client = await getAuthenticatedClient(context)
    const outputMarker = `SNOW_FLOW_CONFIRM_${executionId}`

    // SECURITY: Proper string escaping - escape backslashes first, then quotes
    const escapeForJS = (str: string) =>
      str.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "\\r")

    // Wrap script with output capture
    const wrappedScript = `
// Serac Confirmed Execution - ID: ${executionId}
// Description: ${escapeForJS(description)}
var __sfOutput = [];
var __sfStartTime = new GlideDateTime();
var __sfResult = null;
var __sfError = null;

var __sfOrigPrint = gs.print;
var __sfOrigInfo = gs.info;
var __sfOrigWarn = gs.warn;
var __sfOrigError = gs.error;

gs.print = function(msg) {
  var m = String(msg);
  __sfOutput.push({level: 'print', message: m});
  __sfOrigPrint(m);
};

gs.info = function(msg) {
  var m = String(msg);
  __sfOutput.push({level: 'info', message: m});
  __sfOrigInfo(m);
};

gs.warn = function(msg) {
  var m = String(msg);
  __sfOutput.push({level: 'warn', message: m});
  __sfOrigWarn(m);
};

gs.error = function(msg) {
  var m = String(msg);
  __sfOutput.push({level: 'error', message: m});
  __sfOrigError(m);
};

try {
  gs.info('=== Serac Confirmed Execution Started ===');
  __sfResult = (function() {
    ${script}
  })();
  gs.info('=== Serac Confirmed Execution Completed ===');
} catch(e) {
  __sfError = e.toString();
  gs.error('Error: ' + e.toString());
}

gs.print = __sfOrigPrint;
gs.info = __sfOrigInfo;
gs.warn = __sfOrigWarn;
gs.error = __sfOrigError;

var __sfEndTime = new GlideDateTime();
var __sfExecTimeMs = Math.abs(GlideDateTime.subtract(__sfStartTime, __sfEndTime).getNumericValue());

var __sfResultObj = {
  executionId: '${executionId}',
  success: __sfError === null,
  result: __sfResult,
  error: __sfError,
  output: __sfOutput,
  executionTimeMs: __sfExecTimeMs
};

gs.setProperty('${outputMarker}', JSON.stringify(__sfResultObj));
gs.info('${outputMarker}:DONE');
`

    // Create Scheduled Script Job
    const jobName = `Serac Confirm - ${executionId}`

    const createResponse = await client.post("/api/now/table/sysauto_script", {
      name: jobName,
      script: wrappedScript,
      active: true,
      run_type: "on_demand",
      conditional: false,
    })

    if (!createResponse.data?.result?.sys_id) {
      throw new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, "Failed to create scheduled script job", {
        details: createResponse.data,
      })
    }

    const jobSysId = createResponse.data.result.sys_id

    // Create sys_trigger to execute immediately
    const now = new Date()
    const triggerTime = new Date(now.getTime() + 2000)
    const triggerTimeStr = triggerTime.toISOString().replace("T", " ").substring(0, 19)

    try {
      await client.post("/api/now/table/sys_trigger", {
        name: jobName,
        next_action: triggerTimeStr,
        trigger_type: 0,
        state: 0,
        document: "sysauto_script",
        document_key: jobSysId,
        claimed_by: "",
        system_id: "snow-flow",
      })
    } catch (triggerError) {
      // Continue anyway
    }

    // Poll for execution results
    const startTime = Date.now()
    let result: any = null
    let attempts = 0
    const maxAttempts = Math.ceil(timeout / 2000)

    while (Date.now() - startTime < timeout && attempts < maxAttempts) {
      attempts++
      await new Promise((resolve) => setTimeout(resolve, 2000))

      try {
        const propResponse = await client.get("/api/now/table/sys_properties", {
          params: {
            sysparm_query: `name=${outputMarker}`,
            sysparm_fields: "value,sys_id",
            sysparm_limit: 1,
          },
        })

        if (propResponse.data?.result?.[0]?.value) {
          try {
            result = JSON.parse(propResponse.data.result[0].value)
            const propSysId = propResponse.data.result[0].sys_id
            if (propSysId) {
              await client.delete(`/api/now/table/sys_properties/${propSysId}`).catch(() => {})
            }
            break
          } catch (parseErr) {
            // Continue polling
          }
        }
      } catch (pollError) {
        // Continue polling
      }
    }

    // Cleanup scheduled job
    try {
      await client.delete(`/api/now/table/sysauto_script/${jobSysId}`)
    } catch (cleanupError) {
      // Ignore
    }

    if (result) {
      const organized = {
        print: result.output.filter((o: any) => o.level === "print").map((o: any) => o.message),
        info: result.output.filter((o: any) => o.level === "info").map((o: any) => o.message),
        warn: result.output.filter((o: any) => o.level === "warn").map((o: any) => o.message),
        error: result.output.filter((o: any) => o.level === "error").map((o: any) => o.message),
      }

      return createSuccessResult(
        {
          executed: true,
          execution_id: executionId,
          success: result.success,
          result: result.result,
          error: result.error,
          output: organized,
          raw_output: result.output,
          execution_time_ms: result.executionTimeMs,
          user_confirmed: true,
        },
        {
          operation: "confirmed_script_execution",
          method: "sysauto_script_with_trigger",
        },
      )
    } else {
      return createSuccessResult(
        {
          executed: false,
          execution_id: executionId,
          scheduled_job_sys_id: jobSysId,
          message: "Script was saved but execution could not be confirmed.",
          action_required: `Navigate to System Scheduler > Scheduled Jobs and run: ${jobName}`,
        },
        {
          operation: "confirmed_script_pending",
          method: "scheduled_job_pending",
        },
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

export const version = "2.0.0"
export const author = "Serac SDK"
