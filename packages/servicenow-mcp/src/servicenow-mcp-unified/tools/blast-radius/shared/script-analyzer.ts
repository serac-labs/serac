/**
 * Blast Radius - Script Analyzer Engine
 *
 * Regex-based analysis of ServiceNow script bodies to detect:
 * - Field reads and writes
 * - Table queries (GlideRecord, GlideAggregate)
 * - Script include calls
 * - Glide API usage
 */

import { GLIDE_RECORD_BUILTINS } from "./metadata-tables.js"

export interface FieldReference {
  field: string
  patterns: string[]
  line_numbers: number[]
}

export interface TableReference {
  table: string
  variable_name: string
  line_number: number
}

export interface ScriptIncludeReference {
  name: string
  methods_called: string[]
  line_number: number
}

export interface ScriptAnalysisResult {
  fields_read: FieldReference[]
  fields_written: FieldReference[]
  tables_queried: TableReference[]
  script_includes_called: ScriptIncludeReference[]
  glide_apis_used: string[]
}

/**
 * Analyze a ServiceNow script body for dependencies
 */
export function analyzeScript(scriptBody: string, contextTable?: string): ScriptAnalysisResult {
  if (!scriptBody || scriptBody.trim() === "") {
    return {
      fields_read: [],
      fields_written: [],
      tables_queried: [],
      script_includes_called: [],
      glide_apis_used: [],
    }
  }

  const lines = scriptBody.split("\n")

  const fieldsRead = new Map<string, { patterns: Set<string>; lines: Set<number> }>()
  const fieldsWritten = new Map<string, { patterns: Set<string>; lines: Set<number> }>()
  const tablesQueried: TableReference[] = []
  const scriptIncludesCalled = new Map<string, { methods: Set<string>; line: number }>()
  const glideApisUsed = new Set<string>()

  // Track GlideRecord variable names to their table
  const grVariables = new Map<string, string>()

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1

    // Skip comments
    const trimmed = line.trim()
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      continue
    }

    // --- Table query detection ---
    detectTableQueries(line, lineNum, tablesQueried, grVariables)

    // --- Field READ detection ---
    detectFieldReads(line, lineNum, fieldsRead)

    // --- Field WRITE detection ---
    detectFieldWrites(line, lineNum, fieldsWritten)

    // --- Script include detection ---
    detectScriptIncludes(line, lineNum, scriptIncludesCalled)

    // --- Glide API detection ---
    detectGlideApis(line, glideApisUsed)
  }

  return {
    fields_read: mapToFieldReferences(fieldsRead),
    fields_written: mapToFieldReferences(fieldsWritten),
    tables_queried: tablesQueried,
    script_includes_called: Array.from(scriptIncludesCalled.entries()).map(([name, data]) => ({
      name,
      methods_called: Array.from(data.methods),
      line_number: data.line,
    })),
    glide_apis_used: Array.from(glideApisUsed),
  }
}

function addFieldRef(
  map: Map<string, { patterns: Set<string>; lines: Set<number> }>,
  field: string,
  pattern: string,
  lineNum: number,
) {
  if (GLIDE_RECORD_BUILTINS.has(field)) return
  // Skip common non-field patterns
  if (field === "prototype" || field === "constructor" || field === "length" || field === "type") return

  const existing = map.get(field)
  if (existing) {
    existing.patterns.add(pattern)
    existing.lines.add(lineNum)
  } else {
    map.set(field, { patterns: new Set([pattern]), lines: new Set([lineNum]) })
  }
}

function detectTableQueries(
  line: string,
  lineNum: number,
  tables: TableReference[],
  grVariables: Map<string, string>,
) {
  // new GlideRecord('table_name')
  const grMatch = /(?:var\s+|let\s+|const\s+)?(\w+)\s*=\s*new\s+GlideRecord\s*\(\s*['"](\w+)['"]\s*\)/g
  let m: RegExpExecArray | null
  while ((m = grMatch.exec(line)) !== null) {
    const varName = m[1]
    const tableName = m[2]
    grVariables.set(varName, tableName)
    tables.push({ table: tableName, variable_name: varName, line_number: lineNum })
  }

  // new GlideAggregate('table_name')
  const gaMatch = /(?:var\s+|let\s+|const\s+)?(\w+)\s*=\s*new\s+GlideAggregate\s*\(\s*['"](\w+)['"]\s*\)/g
  while ((m = gaMatch.exec(line)) !== null) {
    const varName = m[1]
    const tableName = m[2]
    grVariables.set(varName, tableName)
    tables.push({ table: tableName, variable_name: varName, line_number: lineNum })
  }

  // Standalone new GlideRecord without assignment
  const standaloneGr = /new\s+GlideRecord\s*\(\s*['"](\w+)['"]\s*\)/g
  while ((m = standaloneGr.exec(line)) !== null) {
    // Only add if not already captured by assignment pattern
    if (!tables.some((t) => t.table === m![1] && t.line_number === lineNum)) {
      tables.push({ table: m[1], variable_name: "anonymous", line_number: lineNum })
    }
  }
}

function detectFieldReads(
  line: string,
  lineNum: number,
  fieldsRead: Map<string, { patterns: Set<string>; lines: Set<number> }>,
) {
  let m: RegExpExecArray | null

  // current.field_name (not followed by =)
  const currentRead = /current\.(\w+)(?!\s*=)/g
  while ((m = currentRead.exec(line)) !== null) {
    addFieldRef(fieldsRead, m[1], `current.${m[1]}`, lineNum)
  }

  // previous.field_name
  const prevRead = /previous\.(\w+)/g
  while ((m = prevRead.exec(line)) !== null) {
    addFieldRef(fieldsRead, m[1], `previous.${m[1]}`, lineNum)
  }

  // gr.getValue('field')
  const getValueMatch = /\.getValue\s*\(\s*['"](\w+)['"]\s*\)/g
  while ((m = getValueMatch.exec(line)) !== null) {
    addFieldRef(fieldsRead, m[1], `getValue('${m[1]}')`, lineNum)
  }

  // gr.getDisplayValue('field')
  const getDisplayMatch = /\.getDisplayValue\s*\(\s*['"](\w+)['"]\s*\)/g
  while ((m = getDisplayMatch.exec(line)) !== null) {
    addFieldRef(fieldsRead, m[1], `getDisplayValue('${m[1]}')`, lineNum)
  }

  // gr.field.nil(), gr.field.changes(), gr.field.changesTo(), gr.field.changesFrom()
  const dotMethodMatch = /(\w+)\.(\w+)\.(nil|changes|changesTo|changesFrom|toString|getDisplayValue)\s*\(/g
  while ((m = dotMethodMatch.exec(line)) !== null) {
    addFieldRef(fieldsRead, m[2], `${m[1]}.${m[2]}.${m[3]}()`, lineNum)
  }

  // g_form.getValue('field')
  const gFormGetMatch = /g_form\.getValue\s*\(\s*['"](\w+)['"]\s*\)/g
  while ((m = gFormGetMatch.exec(line)) !== null) {
    addFieldRef(fieldsRead, m[1], `g_form.getValue('${m[1]}')`, lineNum)
  }

  // g_form.getReference('field')
  const gFormRefMatch = /g_form\.getReference\s*\(\s*['"](\w+)['"]/g
  while ((m = gFormRefMatch.exec(line)) !== null) {
    addFieldRef(fieldsRead, m[1], `g_form.getReference('${m[1]}')`, lineNum)
  }

  // .addQuery('field', ...)
  const addQueryMatch = /\.addQuery\s*\(\s*['"](\w+)['"]/g
  while ((m = addQueryMatch.exec(line)) !== null) {
    addFieldRef(fieldsRead, m[1], `addQuery('${m[1]}')`, lineNum)
  }

  // .addOrCondition('field', ...)
  const addOrMatch = /\.addOrCondition\s*\(\s*['"](\w+)['"]/g
  while ((m = addOrMatch.exec(line)) !== null) {
    addFieldRef(fieldsRead, m[1], `addOrCondition('${m[1]}')`, lineNum)
  }

  // .orderBy('field'), .orderByDesc('field')
  const orderMatch = /\.orderBy(?:Desc)?\s*\(\s*['"](\w+)['"]\s*\)/g
  while ((m = orderMatch.exec(line)) !== null) {
    addFieldRef(fieldsRead, m[1], `orderBy('${m[1]}')`, lineNum)
  }

  // .addNotNullQuery('field'), .addNullQuery('field')
  const nullQueryMatch = /\.add(?:Not)?NullQuery\s*\(\s*['"](\w+)['"]\s*\)/g
  while ((m = nullQueryMatch.exec(line)) !== null) {
    addFieldRef(fieldsRead, m[1], `addNullQuery('${m[1]}')`, lineNum)
  }
}

function detectFieldWrites(
  line: string,
  lineNum: number,
  fieldsWritten: Map<string, { patterns: Set<string>; lines: Set<number> }>,
) {
  let m: RegExpExecArray | null

  // current.field = value
  const currentWrite = /current\.(\w+)\s*=/g
  while ((m = currentWrite.exec(line)) !== null) {
    addFieldRef(fieldsWritten, m[1], `current.${m[1]} = ...`, lineNum)
  }

  // gr.setValue('field', value)
  const setValueMatch = /\.setValue\s*\(\s*['"](\w+)['"]/g
  while ((m = setValueMatch.exec(line)) !== null) {
    addFieldRef(fieldsWritten, m[1], `setValue('${m[1]}')`, lineNum)
  }

  // g_form.setValue('field', value)
  const gFormSetMatch = /g_form\.setValue\s*\(\s*['"](\w+)['"]/g
  while ((m = gFormSetMatch.exec(line)) !== null) {
    addFieldRef(fieldsWritten, m[1], `g_form.setValue('${m[1]}')`, lineNum)
  }

  // g_form.clearValue('field')
  const gFormClearMatch = /g_form\.clearValue\s*\(\s*['"](\w+)['"]/g
  while ((m = gFormClearMatch.exec(line)) !== null) {
    addFieldRef(fieldsWritten, m[1], `g_form.clearValue('${m[1]}')`, lineNum)
  }
}

function detectScriptIncludes(
  line: string,
  lineNum: number,
  scriptIncludes: Map<string, { methods: Set<string>; line: number }>,
) {
  let m: RegExpExecArray | null

  // new ClassName( -- but exclude GlideRecord, GlideAggregate, GlideDateTime, etc.
  const glideClasses = new Set([
    "GlideRecord",
    "GlideAggregate",
    "GlideDateTime",
    "GlideAjax",
    "GlideSysAttachment",
    "GlideElement",
    "GlideSchedule",
    "GlideFilter",
    "GlideUser",
    "GlideSession",
    "GlideDuration",
    "GlideEncrypter",
    "GlideHTTPRequest",
    "GlideSecureRandomUtil",
    "GlideScopedEvaluator",
    "GlideTableHierarchy",
    "GlideappCalculationHelper",
    "GlideUpdateManager",
    "GlidePluginManager",
    "GlideSPScriptable",
    "GlideSystem",
    "GlideRecordSecure",
    "XMLDocument",
    "JSON",
    "Array",
    "Object",
    "String",
    "Number",
    "Date",
    "RegExp",
    "Error",
    "Map",
    "Set",
  ])

  const newClassMatch = /new\s+([A-Z]\w+)\s*\(/g
  while ((m = newClassMatch.exec(line)) !== null) {
    const className = m[1]
    if (!glideClasses.has(className)) {
      if (!scriptIncludes.has(className)) {
        scriptIncludes.set(className, { methods: new Set(), line: lineNum })
      }
    }
  }

  // Variable.methodName( -- detect method calls on script include instances
  // This is a heuristic; we check for PascalCase variable usage
  for (const [name, data] of scriptIncludes) {
    const methodPattern = new RegExp(`\\b\\w+\\.([a-zA-Z]\\w*)\\s*\\(`, "g")
    while ((m = methodPattern.exec(line)) !== null) {
      // Only track if the line also references something related to the script include
      if (line.includes(name.toLowerCase()) || line.includes(name)) {
        data.methods.add(m[1])
      }
    }
  }
}

function detectGlideApis(line: string, apis: Set<string>) {
  const apiPatterns = [
    { pattern: /GlideRecord/g, name: "GlideRecord" },
    { pattern: /GlideAggregate/g, name: "GlideAggregate" },
    { pattern: /GlideAjax/g, name: "GlideAjax" },
    { pattern: /GlideDateTime/g, name: "GlideDateTime" },
    { pattern: /GlideSysAttachment/g, name: "GlideSysAttachment" },
    { pattern: /GlideElement/g, name: "GlideElement" },
    { pattern: /GlideSchedule/g, name: "GlideSchedule" },
    { pattern: /gs\.\w+\s*\(/g, name: "GlideSystem" },
    { pattern: /sn_ws\.RESTMessageV2/g, name: "RESTMessageV2" },
    { pattern: /sn_ws\.SOAPMessageV2/g, name: "SOAPMessageV2" },
    { pattern: /sn_fd\./g, name: "FlowDesigner" },
    { pattern: /GlideRecordSecure/g, name: "GlideRecordSecure" },
  ]

  for (const { pattern, name } of apiPatterns) {
    if (pattern.test(line)) {
      apis.add(name)
    }
    // Reset lastIndex since we're reusing regex with /g flag
    pattern.lastIndex = 0
  }
}

function mapToFieldReferences(
  map: Map<string, { patterns: Set<string>; lines: Set<number> }>,
): FieldReference[] {
  return Array.from(map.entries()).map(([field, data]) => ({
    field,
    patterns: Array.from(data.patterns),
    line_numbers: Array.from(data.lines).sort((a, b) => a - b),
  }))
}

/**
 * Check if a script body references a specific field name.
 * Used for post-filtering LIKE query results to confirm actual references.
 */
export function scriptReferencesField(scriptBody: string, fieldName: string): boolean {
  if (!scriptBody) return false

  // Build patterns that indicate actual field usage (not just substring)
  const patterns = [
    new RegExp(`current\\.${fieldName}\\b`),
    new RegExp(`previous\\.${fieldName}\\b`),
    new RegExp(`['"]${fieldName}['"]`),
    new RegExp(`\\.${fieldName}\\s*[=;,)]`),
    new RegExp(`\\.${fieldName}\\.(nil|changes|changesTo|changesFrom|toString|getDisplayValue)`),
  ]

  return patterns.some((p) => p.test(scriptBody))
}
