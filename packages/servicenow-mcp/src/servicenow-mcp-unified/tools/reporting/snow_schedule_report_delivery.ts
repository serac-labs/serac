/**
 * snow_schedule_report_delivery - Schedule report delivery via email
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_schedule_report_delivery",
  description: "Schedule automated report delivery via email",
  // Metadata for tool discovery (not sent to LLM)
  category: "reporting",
  subcategory: "scheduling",
  use_cases: ["scheduling", "automation", "delivery"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Write operation based on name pattern
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      report_name: { type: "string", description: "Source report name or sys_id" },
      schedule: {
        type: "string",
        description: "Schedule frequency",
        enum: ["daily", "weekly", "monthly", "quarterly"],
      },
      recipients: { type: "array", description: "Email recipients", items: { type: "string" } },
      format: {
        type: "string",
        description: "Report format",
        enum: ["PDF", "Excel", "CSV"],
      },
      conditions: { type: "string", description: "Additional conditions" },
      subject: { type: "string", description: "Email subject" },
      message: { type: "string", description: "Email message" },
    },
    required: ["report_name", "schedule", "recipients"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { report_name, schedule, recipients, format = "PDF", conditions, subject, message } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Find the source report
    const reportResponse = await client.get(
      `/api/now/table/sys_report?sysparm_query=name=${report_name}^ORsys_id=${report_name}&sysparm_limit=1`,
    )

    if (!reportResponse.data.result || reportResponse.data.result.length === 0) {
      return createErrorResult(`Report not found: ${report_name}`)
    }

    const sourceReport = reportResponse.data.result[0]

    // Create scheduled report
    const scheduledReportData: any = {
      name: `Scheduled: ${sourceReport.name || sourceReport.title}`,
      report: sourceReport.sys_id,
      schedule_type: schedule,
      email_list: recipients.join(";"),
      export_format: format.toLowerCase(),
      condition: conditions || "",
      subject: subject || `Scheduled Report: ${sourceReport.name || sourceReport.title}`,
      body: message || "Please find the attached scheduled report.",
      active: true,
    }

    const response = await client.post("/api/now/table/sysauto_report", scheduledReportData)

    return createSuccessResult({
      created: true,
      scheduled_report: response.data.result,
      source_report: sourceReport.name || sourceReport.title,
      schedule,
      recipients: recipients.length,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
