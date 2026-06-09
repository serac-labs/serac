/**
 * snow_inspect_mutations - Self-learning Debugging Tool
 *
 * Read-only tool that queries sys_audit + syslog + syslog_transaction
 * in a time window to show what mutations actually happened on the
 * ServiceNow instance after a tool execution.
 *
 * Useful for verifying what INSERT/UPDATE/DELETE operations a tool
 * performed, detecting failures (via syslog/transactions), and
 * comparing expected vs. actual behavior.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_inspect_mutations",
  description:
    "Inspect what mutations (INSERT/UPDATE/DELETE) occurred on the ServiceNow instance in a time window. " +
    "Queries sys_audit for successful changes, syslog for errors, and optionally syslog_transaction for HTTP " +
    "requests including failures. Essential for debugging tool behavior after execution.",
  category: "automation",
  subcategory: "debugging",
  use_cases: ["automation", "debugging", "audit", "mutations"],
  complexity: "intermediate",
  frequency: "high",

  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    required: ["since"],
    properties: {
      since: {
        type: "string",
        description:
          'Start of time window. ISO 8601 timestamp or relative: "30s", "2m", "1h", "1d". ' +
          "A 2-second buffer is subtracted for timestamp precision.",
      },
      until: {
        type: "string",
        description: "End of time window. Same format as since. Defaults to now.",
      },
      tables: {
        type: "array",
        items: { type: "string" },
        description: 'Filter on specific tables (e.g. ["sys_hub_flow", "sys_hub_action_instance"])',
      },
      exclude_tables: {
        type: "array",
        items: { type: "string" },
        description: "Tables to exclude from results (noise reduction)",
        default: ["syslog", "sys_audit", "sys_audit_relation", "ha_log"],
      },
      user: {
        type: "string",
        description: "Filter by username who made the change",
      },
      record_id: {
        type: "string",
        description: "Filter on a specific record sys_id",
      },
      actions: {
        type: "array",
        items: { type: "string", enum: ["INSERT", "UPDATE", "DELETE"] },
        description: 'Filter by action type (e.g. ["INSERT"], ["UPDATE","DELETE"])',
      },
      include_syslog: {
        type: "boolean",
        description: "Also retrieve errors/warnings from syslog in the time window",
        default: true,
      },
      include_transactions: {
        type: "boolean",
        description:
          "Query syslog_transaction for inbound HTTP requests including failures. " +
          "Available on most instances by default.",
        default: false,
      },
      limit: {
        type: "number",
        description: "Max audit records to return",
        default: 500,
        minimum: 1,
        maximum: 5000,
      },
      group_by: {
        type: "string",
        enum: ["table_and_record", "table", "chronological"],
        description: "How to group results",
        default: "table_and_record",
      },
      snapshot_record: {
        type: "object",
        description: "Fetch current state of a specific record alongside audit trail",
        properties: {
          table: { type: "string", description: "Table name" },
          sys_id: { type: "string", description: "Record sys_id" },
          fields: {
            type: "array",
            items: { type: "string" },
            description: "Specific fields to retrieve (defaults to all)",
          },
        },
        required: ["table", "sys_id"],
      },
    },
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    since,
    until,
    tables,
    exclude_tables = ["syslog", "sys_audit", "sys_audit_relation", "ha_log"],
    user,
    record_id,
    actions,
    include_syslog = true,
    include_transactions = false,
    limit = 500,
    group_by = "table_and_record",
    snapshot_record,
  } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Step 1: Parse time window
    const sinceTime = parseRelativeTime(since, -2000) // 2s buffer
    const untilTime = until ? parseRelativeTime(until, 0) : new Date().toISOString()

    // Step 2: Build sys_audit query
    const auditQueryParts: string[] = []
    auditQueryParts.push(`sys_created_on>=${sinceTime}`)
    auditQueryParts.push(`sys_created_on<=${untilTime}`)

    if (tables && tables.length > 0) {
      auditQueryParts.push(`tablenameIN${tables.join(",")}`)
    } else if (exclude_tables && exclude_tables.length > 0) {
      auditQueryParts.push(`tablenameNOT IN${exclude_tables.join(",")}`)
    }

    if (user) {
      auditQueryParts.push(`userLIKE${user}`)
    }

    if (record_id) {
      auditQueryParts.push(`documentkey=${record_id}`)
    }

    if (actions && actions.length > 0) {
      auditQueryParts.push(`typeIN${actions.join(",")}`)
    }

    const auditQuery = auditQueryParts.join("^") + "^ORDERBYsys_created_on"

    // Step 3: Query sys_audit
    const auditResponse = await client.get("/api/now/table/sys_audit", {
      params: {
        sysparm_query: auditQuery,
        sysparm_limit: Math.min(limit, 5000),
        sysparm_fields: "tablename,documentkey,fieldname,oldvalue,newvalue,type,sys_created_on,user,record_checkpoint",
      },
    })

    const auditRecords = auditResponse.data.result || []

    // Step 4: Query syslog (errors/warnings)
    const syslogEntries: any[] = []
    if (include_syslog) {
      try {
        const syslogQuery = `sys_created_on>=${sinceTime}^sys_created_on<=${untilTime}^levelINerror,warning^ORDERBYDESCsys_created_on`
        const syslogResponse = await client.get("/api/now/table/syslog", {
          params: {
            sysparm_query: syslogQuery,
            sysparm_limit: 100,
            sysparm_fields: "sys_created_on,level,source,message,sys_id",
          },
        })
        const results = syslogResponse.data.result || []
        for (const log of results) {
          syslogEntries.push({
            timestamp: log.sys_created_on,
            level: log.level,
            source: log.source,
            message: log.message,
            sys_id: log.sys_id,
          })
        }
      } catch (_e: any) {
        // syslog query failed — non-critical, continue
      }
    }

    // Step 5: Query syslog_transaction (HTTP requests)
    const transactions: any[] = []
    let transactionWarning = ""
    if (include_transactions) {
      try {
        const txQuery = `sys_created_on>=${sinceTime}^sys_created_on<=${untilTime}^ORDERBYDESCsys_created_on`
        const txResponse = await client.get("/api/now/table/syslog_transaction", {
          params: {
            sysparm_query: txQuery,
            sysparm_limit: 200,
            sysparm_fields: "sys_id,url,http_method,status_code,response_time,client_ip,user,sys_created_on",
          },
        })
        const results = txResponse.data.result || []
        for (const tx of results) {
          transactions.push({
            url: tx.url,
            method: tx.http_method,
            status_code: tx.status_code,
            response_time_ms: tx.response_time,
            client_ip: tx.client_ip,
            user: tx.user,
            timestamp: tx.sys_created_on,
          })
        }
        if (results.length === 0) {
          transactionWarning =
            "syslog_transaction returned 0 records. This is normal if no HTTP requests were made in the time window."
        }
      } catch (_e: any) {
        transactionWarning =
          "Could not query syslog_transaction — table may not be accessible or you lack read permissions."
      }
    }

    // Step 6: Snapshot record (if requested)
    let snapshot: any = null
    if (snapshot_record) {
      try {
        const fieldsParam = snapshot_record.fields ? snapshot_record.fields.join(",") : ""
        const snapshotResponse = await client.get(`/api/now/table/${snapshot_record.table}/${snapshot_record.sys_id}`, {
          params: fieldsParam ? { sysparm_fields: fieldsParam } : {},
        })
        snapshot = {
          table: snapshot_record.table,
          sys_id: snapshot_record.sys_id,
          current_state: snapshotResponse.data.result || {},
        }
      } catch (_e: any) {
        snapshot = {
          table: snapshot_record.table,
          sys_id: snapshot_record.sys_id,
          error: "Could not retrieve record — it may have been deleted or you lack permissions",
        }
      }
    }

    // Step 7: Group results
    const mutations = groupAuditRecords(auditRecords, group_by)

    // Step 8: Calculate statistics
    const tablesAffected = new Set<string>()
    const recordsAffected = new Set<string>()
    const byAction: Record<string, number> = {}
    const truncatedValues: string[] = []

    for (const record of auditRecords) {
      tablesAffected.add(record.tablename)
      recordsAffected.add(`${record.tablename}:${record.documentkey}`)
      byAction[record.type] = (byAction[record.type] || 0) + 1

      // Detect truncated values (sys_audit limits to 255 chars)
      if (record.oldvalue && record.oldvalue.length >= 255) {
        truncatedValues.push(`${record.tablename}.${record.fieldname} (old_value)`)
      }
      if (record.newvalue && record.newvalue.length >= 255) {
        truncatedValues.push(`${record.tablename}.${record.fieldname} (new_value)`)
      }
    }

    const statistics = {
      total_mutations: auditRecords.length,
      tables_affected: Array.from(tablesAffected),
      records_affected: recordsAffected.size,
      by_action: byAction,
      time_window: { since: sinceTime, until: untilTime },
      limit_applied: limit,
      results_may_be_truncated: auditRecords.length >= limit,
    }

    // Step 9: Build summary
    const summaryLines: string[] = []
    summaryLines.push(`=== Mutation Inspection Results ===`)
    summaryLines.push(`Time window: ${sinceTime} → ${untilTime}`)
    summaryLines.push("")

    if (auditRecords.length === 0) {
      summaryLines.push("No mutations found in sys_audit for this time window.")
      summaryLines.push("")
      summaryLines.push("Note: sys_audit only captures SUCCESSFUL record changes.")
      summaryLines.push("If you expected changes, check:")
      summaryLines.push("  - Is auditing enabled for the target table(s)?")
      summaryLines.push("  - Did the operation actually succeed?")
      summaryLines.push("  - Try include_syslog=true and include_transactions=true for failure details")
    } else {
      summaryLines.push(
        `Found ${auditRecords.length} audit entries across ${tablesAffected.size} table(s), ${recordsAffected.size} record(s)`,
      )

      // Action breakdown
      const actionParts: string[] = []
      for (const [action, count] of Object.entries(byAction)) {
        actionParts.push(`${action}: ${count}`)
      }
      summaryLines.push(`Actions: ${actionParts.join(", ")}`)

      if (auditRecords.length >= limit) {
        summaryLines.push(
          `⚠️ Result limit (${limit}) reached — there may be more mutations. Increase limit or narrow filters.`,
        )
      }

      // Preview first changes per table
      summaryLines.push("")
      summaryLines.push("Changes by table:")
      for (const tableName of tablesAffected) {
        const tableRecords = auditRecords.filter((r: any) => r.tablename === tableName)
        const uniqueRecords = new Set(tableRecords.map((r: any) => r.documentkey))
        summaryLines.push(`  ${tableName}: ${tableRecords.length} changes across ${uniqueRecords.size} record(s)`)

        // Show first 3 field changes
        const preview = tableRecords.slice(0, 3)
        for (const p of preview) {
          const oldVal = p.oldvalue ? truncateValue(p.oldvalue, 50) : "(empty)"
          const newVal = p.newvalue ? truncateValue(p.newvalue, 50) : "(empty)"
          summaryLines.push(`    ${p.type} ${p.fieldname}: ${oldVal} → ${newVal}`)
        }
        if (tableRecords.length > 3) {
          summaryLines.push(`    ... and ${tableRecords.length - 3} more changes`)
        }
      }
    }

    if (truncatedValues.length > 0) {
      summaryLines.push("")
      summaryLines.push(`⚠️ ${truncatedValues.length} field value(s) may be truncated (sys_audit 255 char limit):`)
      for (const tv of truncatedValues.slice(0, 5)) {
        summaryLines.push(`  - ${tv}`)
      }
      if (truncatedValues.length > 5) {
        summaryLines.push(`  ... and ${truncatedValues.length - 5} more`)
      }
    }

    if (syslogEntries.length > 0) {
      summaryLines.push("")
      summaryLines.push(`Syslog: ${syslogEntries.length} error/warning entries in time window`)
      const previewCount = Math.min(syslogEntries.length, 5)
      for (let i = 0; i < previewCount; i++) {
        const log = syslogEntries[i]
        const icon = log.level === "error" ? "❌" : "⚠️"
        const msg = truncateValue(log.message || "(no message)", 80)
        summaryLines.push(`  ${icon} [${log.source || "unknown"}] ${msg}`)
      }
      if (syslogEntries.length > 5) {
        summaryLines.push(`  ... and ${syslogEntries.length - 5} more`)
      }
    }

    if (include_transactions) {
      summaryLines.push("")
      if (transactions.length > 0) {
        const failures = transactions.filter((t: any) => t.status_code && parseInt(t.status_code) >= 400)
        summaryLines.push(`Transactions: ${transactions.length} HTTP requests (${failures.length} failures)`)
        if (failures.length > 0) {
          summaryLines.push("  Failed requests:")
          for (const f of failures.slice(0, 5)) {
            summaryLines.push(`    ${f.method || "?"} ${truncateValue(f.url || "", 60)} → ${f.status_code}`)
          }
        }
      } else if (transactionWarning) {
        summaryLines.push(`Transactions: ${transactionWarning}`)
      }
    }

    // Build result data
    const resultData: any = {
      mutations,
      statistics,
    }

    if (syslogEntries.length > 0) {
      resultData.syslog_entries = syslogEntries
    }

    if (include_transactions) {
      resultData.transactions = transactions
      if (transactionWarning) {
        resultData.transaction_warning = transactionWarning
      }
    }

    if (snapshot) {
      resultData.snapshot = snapshot
    }

    return createSuccessResult(resultData, {}, summaryLines.join("\n"))
  } catch (error: any) {
    // Handle 403 specifically for sys_audit
    if (error.response && error.response.status === 403) {
      return createErrorResult(
        "Access denied to sys_audit table. Required roles: admin, or a role with read access to sys_audit. " +
          "Contact your ServiceNow administrator to grant the necessary permissions.",
      )
    }
    return createErrorResult(error.message || "Failed to inspect mutations")
  }
}

/**
 * Parse relative time string into ISO 8601 timestamp.
 * Supports: "30s", "2m", "1h", "1d" and absolute ISO strings.
 * bufferMs: milliseconds to subtract as buffer (for timestamp precision).
 */
function parseRelativeTime(relative: string, bufferMs: number): string {
  const now = new Date()
  const match = relative.match(/^(\d+)([smhd])$/)

  if (!match) {
    // Assume absolute timestamp — apply buffer if negative
    if (bufferMs < 0) {
      const date = new Date(relative)
      if (!isNaN(date.getTime())) {
        return new Date(date.getTime() + bufferMs).toISOString()
      }
    }
    return relative
  }

  const value = parseInt(match[1])
  const unit = match[2]

  let milliseconds = 0
  switch (unit) {
    case "s":
      milliseconds = value * 1000
      break
    case "m":
      milliseconds = value * 60 * 1000
      break
    case "h":
      milliseconds = value * 60 * 60 * 1000
      break
    case "d":
      milliseconds = value * 24 * 60 * 60 * 1000
      break
  }

  const since = new Date(now.getTime() - milliseconds + bufferMs)
  return since.toISOString()
}

/**
 * Group audit records based on the requested grouping mode.
 */
function groupAuditRecords(records: any[], groupBy: string): any {
  if (groupBy === "chronological") {
    return records.map((r: any) => ({
      table: r.tablename,
      record_id: r.documentkey,
      field: r.fieldname,
      action: r.type,
      old_value: r.oldvalue,
      new_value: r.newvalue,
      timestamp: r.sys_created_on,
      user: r.user,
      checkpoint: r.record_checkpoint,
    }))
  }

  if (groupBy === "table") {
    const grouped: Record<string, any[]> = {}
    for (const r of records) {
      if (!grouped[r.tablename]) {
        grouped[r.tablename] = []
      }
      grouped[r.tablename].push({
        record_id: r.documentkey,
        field: r.fieldname,
        action: r.type,
        old_value: r.oldvalue,
        new_value: r.newvalue,
        timestamp: r.sys_created_on,
        user: r.user,
        checkpoint: r.record_checkpoint,
      })
    }
    return grouped
  }

  // Default: table_and_record
  const grouped: Record<string, Record<string, any>> = {}
  for (const r of records) {
    if (!grouped[r.tablename]) {
      grouped[r.tablename] = {}
    }
    if (!grouped[r.tablename][r.documentkey]) {
      grouped[r.tablename][r.documentkey] = {
        action_summary: "",
        changes: [],
      }
    }

    grouped[r.tablename][r.documentkey].changes.push({
      field: r.fieldname,
      action: r.type,
      old_value: r.oldvalue,
      new_value: r.newvalue,
      timestamp: r.sys_created_on,
      user: r.user,
      checkpoint: r.record_checkpoint,
    })
  }

  // Build action summaries
  for (const table of Object.keys(grouped)) {
    for (const recordId of Object.keys(grouped[table])) {
      const entry = grouped[table][recordId]
      const actionCounts: Record<string, number> = {}
      for (const change of entry.changes) {
        actionCounts[change.action] = (actionCounts[change.action] || 0) + 1
      }
      const parts: string[] = []
      for (const [action, count] of Object.entries(actionCounts)) {
        parts.push(`${action} (${count} field${count > 1 ? "s" : ""})`)
      }
      entry.action_summary = parts.join(", ")
    }
  }

  return grouped
}

/**
 * Truncate a string value for display, adding "..." if truncated.
 */
function truncateValue(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return value.substring(0, maxLength) + "..."
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
