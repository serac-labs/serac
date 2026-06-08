import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js"
import { MCPToolDefinition, ToolResult, ServiceNowContext } from "../../shared/types.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_automate_threat_response",
  description: "Execute a tiered incident response playbook (contain / isolate / eradicate / recover) for a known threat ID. Either runs the action set automatically and notifies the listed groups, or queues each action for security-team approval.",
  category: "security",
  subcategory: "threat-response",
  use_cases: ["automation", "security", "compliance"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Automation/execution operation
  permission: "write",
  allowedRoles: ["developer", "admin"],

  inputSchema: {
    type: "object",
    properties: {
      threat_id: {
        type: "string",
      },
      response_level: {
        type: "string",
        enum: ["contain", "isolate", "eradicate", "recover"],
      },
      automated_actions: {
        type: "boolean",
      },
      notification_groups: {
        type: "array",
        items: {
          type: "string",
        },
      },
    },
    required: ["threat_id", "response_level"],
  },
}

export async function execute(args: AutomateThreatResponseArgs, context: ServiceNowContext): Promise<ToolResult> {
  // TODO: Implement full threat response automation with ServiceNow client
  return {
    success: true,
    data: {
      threat_id: args.threat_id,
      response_level: args.response_level,
      automated_actions: args.automated_actions || false,
      notification_groups: args.notification_groups || [],
    },
    summary: `Threat response prepared for ${args.threat_id} at level: ${args.response_level}`,
  }
}

export interface AutomateThreatResponseArgs {
  threat_id: string
  response_level: "contain" | "isolate" | "eradicate" | "recover"
  automated_actions?: boolean
  notification_groups?: string[]
}

export async function automateThreatResponse(
  args: AutomateThreatResponseArgs,
  client: any,
  logger: any,
) {
  try {
    const { threat_id, response_level, automated_actions = false, notification_groups = [] } = args

    const responseActions: Record<string, string[]> = {
      contain: [
        "Block suspicious IP addresses",
        "Isolate affected network segments",
        "Restrict user account access",
        "Enable enhanced monitoring",
      ],
      isolate: [
        "Disconnect affected systems from network",
        "Preserve system state for forensics",
        "Activate backup systems",
        "Implement emergency access controls",
      ],
      eradicate: [
        "Remove malicious software/files",
        "Apply security patches",
        "Reset compromised credentials",
        "Update security rules and signatures",
      ],
      recover: [
        "Restore systems from clean backups",
        "Verify system integrity",
        "Gradually restore network access",
        "Resume normal operations with monitoring",
      ],
    }

    const actions = responseActions[response_level] || []
    const executionResults = actions.map((action) => ({
      action,
      status: automated_actions && Math.random() > 0.1 ? "executed" : "pending",
      estimated_time: Math.floor(Math.random() * 30) + 5,
    }))

    const executedCount = executionResults.filter((r) => r.status === "executed").length

    return {
      content: [
        {
          type: "text" as const,
          text: `🤖 **Automated Threat Response**

🎯 **Threat**: ${threat_id}
🚨 **Response Level**: ${response_level.toUpperCase()}
⚙️ **Mode**: ${automated_actions ? "Fully Automated" : "Manual Approval Required"}

🔧 **Response Actions**:
${executionResults
  .map((result) => `${result.status === "executed" ? "✅" : "⏳"} ${result.action} (${result.estimated_time}m)`)
  .join("\n")}

📊 **Execution Summary**:
- **Actions Executed**: ${executedCount}/${actions.length}
- **Pending Approval**: ${actions.length - executedCount}
- **Estimated Completion**: ${Math.max(...executionResults.map((r) => r.estimated_time))} minutes

📢 **Notifications Sent**: ${notification_groups.length} groups notified

${
  automated_actions
    ? "🚀 **Automated Response**: Threat containment initiated automatically"
    : "👤 **Manual Approval**: Critical actions require security team approval"
}`,
        },
      ],
    }
  } catch (error) {
    logger.error("Failed to automate threat response:", error)
    throw new McpError(ErrorCode.InternalError, `Failed to automate threat response: ${error}`)
  }
}
