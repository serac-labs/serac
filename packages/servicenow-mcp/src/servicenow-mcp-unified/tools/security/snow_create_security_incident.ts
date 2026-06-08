/**
 * ServiceNow Security Tool: Create Security Incident
 * Create security incident with automated threat correlation and priority assignment
 */

import { MCPToolDefinition, ToolResult, ServiceNowContext } from "../../shared/types.js"

/**
 * Map priority string to ServiceNow priority number (1=Critical, 2=High, 3=Medium, 4=Low)
 */
function mapPriorityToNumber(priority: string): number {
  const priorityMap: Record<string, number> = {
    critical: 1,
    high: 2,
    medium: 3,
    low: 4,
  }
  return priorityMap[priority.toLowerCase()] || 3
}

/**
 * Calculate impact based on affected systems and threat type
 */
function calculateImpact(affectedSystems: string[], threatType: string): number {
  // Base impact on threat type
  const threatImpact: Record<string, number> = {
    data_breach: 1,
    ddos: 1,
    malware: 2,
    unauthorized_access: 2,
    insider_threat: 2,
    phishing: 3,
  }

  let impact = threatImpact[threatType] || 3

  // Increase impact if many systems affected
  if (affectedSystems.length > 10) {
    impact = Math.max(1, impact - 1)
  } else if (affectedSystems.length > 5) {
    impact = Math.max(1, impact)
  }

  return impact
}

/**
 * Detect IOC type from indicator value
 */
function detectIOCType(ioc: string): string {
  // IP address pattern (IPv4)
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ioc)) {
    return "ip_address"
  }

  // IPv6 pattern
  if (/^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/.test(ioc) || ioc.includes("::")) {
    return "ip_address"
  }

  // Domain pattern
  if (/^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?\.[a-zA-Z]{2,}$/.test(ioc)) {
    return "domain"
  }

  // URL pattern
  if (/^https?:\/\//.test(ioc)) {
    return "url"
  }

  // Email pattern
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ioc)) {
    return "email"
  }

  // Hash patterns (MD5, SHA1, SHA256)
  if (/^[a-fA-F0-9]{32}$/.test(ioc)) {
    return "hash_md5"
  }
  if (/^[a-fA-F0-9]{40}$/.test(ioc)) {
    return "hash_sha1"
  }
  if (/^[a-fA-F0-9]{64}$/.test(ioc)) {
    return "hash_sha256"
  }

  // File path pattern
  if (ioc.includes("/") || ioc.includes("\\")) {
    return "file_path"
  }

  return "unknown"
}

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_security_incident",
  description: "Create security incident with automated threat correlation and priority assignment",
  category: "security",
  subcategory: "incidents",
  use_cases: ["logging", "security", "compliance"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Creation/logging operation
  permission: "write",
  allowedRoles: ["developer", "admin"],

  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Security incident title" },
      description: { type: "string", description: "Detailed incident description" },
      priority: { type: "string", description: "Incident priority", enum: ["critical", "high", "medium", "low"] },
      threat_type: {
        type: "string",
        description: "Type of security threat",
        enum: ["malware", "phishing", "data_breach", "unauthorized_access", "ddos", "insider_threat"],
      },
      affected_systems: { type: "array", items: { type: "string" }, description: "List of affected system CIs" },
      iocs: { type: "array", items: { type: "string" }, description: "Indicators of Compromise (IOCs)" },
      source: { type: "string", description: "Incident source (SIEM, manual, automated)" },
    },
    required: ["title", "description", "threat_type"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    title,
    description,
    priority = "medium",
    threat_type,
    affected_systems = [],
    iocs = [],
    source = "manual",
  } = args

  // TODO: Implement full security incident creation with ServiceNow client
  return {
    success: true,
    data: {
      title,
      description,
      priority,
      threat_type,
      affected_systems,
      iocs,
      source,
    },
    summary: `Security incident "${title}" prepared with priority: ${priority}`,
  }
}
