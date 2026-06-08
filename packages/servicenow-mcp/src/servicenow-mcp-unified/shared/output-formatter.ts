/**
 * Output Formatter - Human-readable tool output
 *
 * Provides utilities to format tool results in a clear, scannable way.
 * The summary is displayed at the TOP of tool output in the TUI,
 * making it easy to understand what happened without reading JSON.
 *
 * Design principles:
 * - Most important info first (action result, key identifier)
 * - Key-value pairs for quick scanning
 * - Lists for multiple items
 * - URLs are clickable
 * - Errors are clearly marked
 */

import { ToolResult } from "./types.js"

/**
 * Format symbols
 */
const SYMBOLS = {
  success: "✓",
  error: "✗",
  warning: "⚠",
  info: "ℹ",
  bullet: "•",
  arrow: "→",
  indent: "  ",
}

/**
 * Summary line item
 */
interface SummaryLine {
  label?: string
  value: string | number | boolean | null | undefined
  indent?: number
  type?: "header" | "field" | "list" | "url" | "code" | "divider"
}

/**
 * Summary builder for constructing formatted output
 */
export class SummaryBuilder {
  private lines: string[] = []

  /**
   * Add success header line
   */
  success(message: string): this {
    this.lines.push(`${SYMBOLS.success} ${message}`)
    return this
  }

  /**
   * Add error header line
   */
  error(message: string): this {
    this.lines.push(`${SYMBOLS.error} ${message}`)
    return this
  }

  /**
   * Add warning line
   */
  warning(message: string): this {
    this.lines.push(`${SYMBOLS.warning} ${message}`)
    return this
  }

  /**
   * Add info line
   */
  info(message: string): this {
    this.lines.push(`${SYMBOLS.info} ${message}`)
    return this
  }

  /**
   * Add a key-value field
   */
  field(label: string, value: string | number | boolean | null | undefined, indent: number = 1): this {
    if (value === null || value === undefined || value === "") return this
    var indentStr = SYMBOLS.indent.repeat(indent)
    this.lines.push(`${indentStr}${label}: ${value}`)
    return this
  }

  /**
   * Add multiple fields at once
   */
  fields(fields: Record<string, string | number | boolean | null | undefined>, indent: number = 1): this {
    for (var key in fields) {
      if (fields.hasOwnProperty(key)) {
        this.field(key, fields[key], indent)
      }
    }
    return this
  }

  /**
   * Add a bullet list item
   */
  bullet(text: string, indent: number = 1): this {
    var indentStr = SYMBOLS.indent.repeat(indent)
    this.lines.push(`${indentStr}${SYMBOLS.bullet} ${text}`)
    return this
  }

  /**
   * Add multiple bullet items
   */
  bullets(items: string[], indent: number = 1): this {
    for (var i = 0; i < items.length; i++) {
      this.bullet(items[i], indent)
    }
    return this
  }

  /**
   * Add a URL (formatted for clickability)
   */
  url(label: string, url: string, indent: number = 1): this {
    var indentStr = SYMBOLS.indent.repeat(indent)
    this.lines.push(`${indentStr}${label}: ${url}`)
    return this
  }

  /**
   * Add an arrow line (for flow/navigation)
   */
  arrow(from: string, to: string, indent: number = 1): this {
    var indentStr = SYMBOLS.indent.repeat(indent)
    this.lines.push(`${indentStr}${from} ${SYMBOLS.arrow} ${to}`)
    return this
  }

  /**
   * Add a blank line
   */
  blank(): this {
    this.lines.push("")
    return this
  }

  /**
   * Add a divider line
   */
  divider(char: string = "─", length: number = 40): this {
    this.lines.push(char.repeat(length))
    return this
  }

  /**
   * Add a section header
   */
  section(title: string): this {
    this.blank()
    this.lines.push(title)
    return this
  }

  /**
   * Add raw text line
   */
  line(text: string): this {
    this.lines.push(text)
    return this
  }

  /**
   * Add indented text
   */
  indented(text: string, indent: number = 1): this {
    var indentStr = SYMBOLS.indent.repeat(indent)
    this.lines.push(`${indentStr}${text}`)
    return this
  }

  /**
   * Add a table row (simple key-value with alignment)
   */
  tableRow(items: string[], widths?: number[]): this {
    var row = items
      .map(function (item, i) {
        if (widths && widths[i]) {
          return item.toString().padEnd(widths[i])
        }
        return item.toString()
      })
      .join("  ")
    this.lines.push(SYMBOLS.indent + row)
    return this
  }

  /**
   * Add count summary (e.g., "Found 5 workflows")
   */
  count(count: number, singular: string, plural?: string): this {
    var word = count === 1 ? singular : plural || singular + "s"
    this.lines.push(`${SYMBOLS.indent}Found ${count} ${word}`)
    return this
  }

  /**
   * Build the final summary string
   */
  build(): string {
    return this.lines.join("\n")
  }

  /**
   * Check if summary has any content
   */
  isEmpty(): boolean {
    return this.lines.length === 0
  }
}

/**
 * Create a new summary builder
 */
export function summary(): SummaryBuilder {
  return new SummaryBuilder()
}

/**
 * Format a list of records for display
 */
export function formatRecordList(
  records: any[],
  options: {
    nameField?: string
    idField?: string
    extraFields?: string[]
    maxItems?: number
  } = {},
): string {
  var nameField = options.nameField || "name"
  var idField = options.idField || "sys_id"
  var extraFields = options.extraFields || []
  var maxItems = options.maxItems || 10

  var builder = summary()

  var displayRecords = records.slice(0, maxItems)
  for (var i = 0; i < displayRecords.length; i++) {
    var record = displayRecords[i]
    var name = record[nameField] || record[idField] || "Unknown"
    var id = record[idField] || ""

    var line = name
    if (id && id !== name) {
      line += ` (${id.substring(0, 8)}...)`
    }

    // Add extra fields inline
    var extras: string[] = []
    for (var j = 0; j < extraFields.length; j++) {
      var field = extraFields[j]
      if (record[field]) {
        extras.push(`${field}: ${record[field]}`)
      }
    }
    if (extras.length > 0) {
      line += " - " + extras.join(", ")
    }

    builder.bullet(line)
  }

  if (records.length > maxItems) {
    builder.indented(`... and ${records.length - maxItems} more`)
  }

  return builder.build()
}

/**
 * Format a single record for display
 */
export function formatRecord(
  record: any,
  options: {
    title?: string
    fields?: string[]
    fieldLabels?: Record<string, string>
  } = {},
): string {
  var builder = summary()

  if (options.title) {
    builder.success(options.title)
  }

  var fields = options.fields || Object.keys(record)
  var labels = options.fieldLabels || {}

  for (var i = 0; i < fields.length; i++) {
    var field = fields[i]
    var value = record[field]
    if (value !== null && value !== undefined && value !== "") {
      var label = labels[field] || formatFieldName(field)
      builder.field(label, value)
    }
  }

  return builder.build()
}

/**
 * Format a field name to be human-readable
 */
export function formatFieldName(field: string): string {
  // Convert snake_case or camelCase to Title Case
  return field
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, function (l) {
      return l.toUpperCase()
    })
}

/**
 * Format sys_id for display (truncated with ellipsis)
 */
export function formatSysId(sysId: string, length: number = 8): string {
  if (!sysId) return ""
  if (sysId.length <= length) return sysId
  return sysId.substring(0, length) + "..."
}

/**
 * Format a timestamp for display
 */
export function formatTimestamp(timestamp: string | Date): string {
  if (!timestamp) return ""
  var date = typeof timestamp === "string" ? new Date(timestamp) : timestamp
  return date.toLocaleString()
}

/**
 * Format a duration in milliseconds to human-readable
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return ms + "ms"
  if (ms < 60000) return (ms / 1000).toFixed(1) + "s"
  if (ms < 3600000) return Math.floor(ms / 60000) + "m " + Math.floor((ms % 60000) / 1000) + "s"
  return Math.floor(ms / 3600000) + "h " + Math.floor((ms % 3600000) / 60000) + "m"
}

/**
 * Format boolean for display
 */
export function formatBoolean(value: boolean | string): string {
  if (value === true || value === "true") return "Yes"
  if (value === false || value === "false") return "No"
  return String(value)
}

/**
 * Create a ToolResult with formatted summary
 */
export function createFormattedResult(data: any, summaryBuilder: SummaryBuilder, metadata: any = {}): ToolResult {
  return {
    success: true,
    data: data,
    summary: summaryBuilder.build(),
    metadata: metadata,
  }
}

/**
 * Create an error ToolResult with formatted summary
 */
export function createFormattedError(error: string, details?: string, metadata: any = {}): ToolResult {
  var builder = summary().error(error)
  if (details) {
    builder.indented(details)
  }
  return {
    success: false,
    error: error,
    summary: builder.build(),
    metadata: metadata,
  }
}

/**
 * Quick formatted success result
 */
export function quickSuccess(action: string, name: string, fields?: Record<string, any>): ToolResult {
  var builder = summary().success(`${action} "${name}"`)
  if (fields) {
    builder.fields(fields)
  }
  return {
    success: true,
    data: { action, name, ...fields },
    summary: builder.build(),
  }
}

/**
 * Quick formatted list result
 */
export function quickList(
  itemType: string,
  items: any[],
  options?: {
    nameField?: string
    extraFields?: string[]
  },
): ToolResult {
  var builder = summary().success(`Found ${items.length} ${items.length === 1 ? itemType : itemType + "s"}`)

  if (items.length > 0) {
    var nameField = options?.nameField || "name"
    var extraFields = options?.extraFields || []
    var maxItems = 10

    for (var i = 0; i < Math.min(items.length, maxItems); i++) {
      var item = items[i]
      var line = item[nameField] || item.sys_id || "Unknown"

      // Add extra fields
      var extras: string[] = []
      for (var j = 0; j < extraFields.length; j++) {
        var field = extraFields[j]
        if (item[field]) {
          extras.push(String(item[field]))
        }
      }
      if (extras.length > 0) {
        line += " (" + extras.join(", ") + ")"
      }

      builder.bullet(line)
    }

    if (items.length > maxItems) {
      builder.indented("... and " + (items.length - maxItems) + " more")
    }
  }

  return {
    success: true,
    data: { count: items.length, items: items },
    summary: builder.build(),
  }
}

/**
 * Extract value from ServiceNow API response field
 *
 * When using sysparm_display_value='all', ServiceNow returns fields as objects:
 * { value: "actual_value", display_value: "display_value" }
 *
 * This helper safely extracts the value regardless of format.
 */
export function getFieldValue(field: any): string {
  if (field === null || field === undefined) return ""
  if (typeof field === "string") return field
  if (typeof field === "number") return String(field)
  if (typeof field === "boolean") return String(field)
  if (typeof field === "object") {
    // ServiceNow display_value format: prefer display_value for human-readable output
    if ("display_value" in field && field.display_value !== null && field.display_value !== undefined) {
      return String(field.display_value)
    }
    if ("value" in field && field.value !== null && field.value !== undefined) {
      return String(field.value)
    }
    // Handle arrays (take first element)
    if (Array.isArray(field) && field.length > 0) {
      return getFieldValue(field[0])
    }
    // Try common property names
    if ("name" in field) return String(field.name)
    if ("label" in field) return String(field.label)
    if ("sys_id" in field) return String(field.sys_id)
    // Last resort: JSON stringify (but truncate to avoid huge output)
    try {
      var json = JSON.stringify(field)
      return json.length > 100 ? json.substring(0, 97) + "..." : json
    } catch (e) {
      return "[complex object]"
    }
  }
  return String(field)
}

/**
 * Extract display value from ServiceNow API response field
 * Falls back to value if display_value not available
 */
export function getDisplayValue(field: any): string {
  // Use the same robust logic as getFieldValue
  return getFieldValue(field)
}

export { SYMBOLS }
