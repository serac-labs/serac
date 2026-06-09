/**
 * Tool Registry with Auto-Discovery and Static Fallback
 *
 * Automatically discovers and registers tools from the tools/ directory.
 * Falls back to static imports when running in bundled mode.
 * Supports dynamic loading, validation, and hot-reload during development.
 */

import * as fs from "fs/promises"
import * as path from "path"
import { fileURLToPath } from "url"
import { dirname } from "path"
import {
  type MCPToolDefinition,
  type RegisteredTool,
  type ToolDiscoveryResult,
  type ToolExecutor,
  type ToolRegistryConfig,
  type ToolValidationResult,
  type ToolMetadata,
} from "./types.js"
import { mcpDebug } from "../../shared/mcp-debug.js"

// Static tool imports for bundled mode
// These are imported at build time and included in the bundle
import * as operationsTools from "../tools/operations/index.js"
import * as deploymentTools from "../tools/deployment/index.js"
import * as cmdbTools from "../tools/cmdb/index.js"
import * as knowledgeTools from "../tools/knowledge/index.js"
import * as catalogTools from "../tools/catalog/index.js"
import * as changeTools from "../tools/change/index.js"
import * as eventsTools from "../tools/events/index.js"
import * as userAdminTools from "../tools/user-admin/index.js"
import * as accessControlTools from "../tools/access-control/index.js"
import * as dataManagementTools from "../tools/data-management/index.js"
import * as importExportTools from "../tools/import-export/index.js"
import * as workflowTools from "../tools/workflow/index.js"
import * as scheduledJobsTools from "../tools/scheduled-jobs/index.js"
import * as emailTools from "../tools/email/index.js"
import * as formsTools from "../tools/forms/index.js"
import * as listsTools from "../tools/lists/index.js"
import * as businessRulesTools from "../tools/business-rules/index.js"
import * as slaTools from "../tools/sla/index.js"
import * as approvalsTools from "../tools/approvals/index.js"
import * as attachmentsTools from "../tools/attachments/index.js"
import * as uiPoliciesTools from "../tools/ui-policies/index.js"
import * as metricsTools from "../tools/metrics/index.js"
import * as dashboardsTools from "../tools/dashboards/index.js"
import * as menusTools from "../tools/menus/index.js"
import * as applicationsTools from "../tools/applications/index.js"
import * as queuesTools from "../tools/queues/index.js"
import * as journalsTools from "../tools/journals/index.js"
import * as dataPoliciesTools from "../tools/data-policies/index.js"
import * as workspaceTools from "../tools/workspace/index.js"
import * as templatesTools from "../tools/templates/index.js"
import * as schedulesTools from "../tools/schedules/index.js"
import * as variablesTools from "../tools/variables/index.js"
import * as validatorsTools from "../tools/validators/index.js"
import * as connectorsTools from "../tools/connectors/index.js"
import * as adaptersTools from "../tools/adapters/index.js"
import * as handlersTools from "../tools/handlers/index.js"
import * as filtersTools from "../tools/filters/index.js"
import * as formattersTools from "../tools/formatters/index.js"
import * as encodersTools from "../tools/encoders/index.js"
import * as utilitiesTools from "../tools/utilities/index.js"
import * as helpersTools from "../tools/helpers/index.js"
import * as extensionsTools from "../tools/extensions/index.js"
import * as convertersTools from "../tools/converters/index.js"
import * as advancedTools from "../tools/advanced/index.js"
import * as assetTools from "../tools/asset/index.js"
import * as securityTools from "../tools/security/index.js"
import * as reportingTools from "../tools/reporting/index.js"
import * as hrCsmTools from "../tools/hr-csm/index.js"
import * as notificationsTools from "../tools/notifications/index.js"
import * as mobileTools from "../tools/mobile/index.js"
import * as atfTools from "../tools/atf/index.js"
import * as automationTools from "../tools/automation/index.js"
import * as updateSetsTools from "../tools/update-sets/index.js"
import * as localSyncTools from "../tools/local-sync/index.js"
import * as uiBuilderTools from "../tools/ui-builder/index.js"
import * as integrationTools from "../tools/integration/index.js"
import * as platformTools from "../tools/platform/index.js"
import * as devopsTools from "../tools/devops/index.js"
import * as virtualAgentTools from "../tools/virtual-agent/index.js"
import * as flowDesignerTools from "../tools/flow-designer/index.js"
import * as pluginsTools from "../tools/plugins/index.js"
import * as agileTools from "../tools/agile/index.js"
import * as blastRadiusTools from "../tools/blast-radius/index.js"
import * as addonsTools from "../tools/addons/index.js"
import * as aggregatorsTools from "../tools/aggregators/index.js"
import * as calculatorsTools from "../tools/calculators/index.js"
import * as decodersTools from "../tools/decoders/index.js"
import * as developmentTools from "../tools/development/index.js"
import * as generatorsTools from "../tools/generators/index.js"
import * as mappersTools from "../tools/mappers/index.js"
import * as parsersTools from "../tools/parsers/index.js"
import * as performanceAnalyticsTools from "../tools/performance-analytics/index.js"
import * as processorsTools from "../tools/processors/index.js"
import * as procurementTools from "../tools/procurement/index.js"
import * as projectTools from "../tools/project/index.js"
import * as servicePortalTools from "../tools/service-portal/index.js"
import * as systemPropertiesTools from "../tools/system-properties/index.js"
import * as transformersTools from "../tools/transformers/index.js"
import * as csmTools from "../tools/csm/index.js"
import * as hrTools from "../tools/hr/index.js"

// ES Module compatible __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Map of domain name to imported tools module
const STATIC_TOOL_MODULES: Record<string, any> = {
  operations: operationsTools,
  deployment: deploymentTools,
  cmdb: cmdbTools,
  knowledge: knowledgeTools,
  catalog: catalogTools,
  change: changeTools,
  events: eventsTools,
  "user-admin": userAdminTools,
  "access-control": accessControlTools,
  "data-management": dataManagementTools,
  "import-export": importExportTools,
  workflow: workflowTools,
  "scheduled-jobs": scheduledJobsTools,
  email: emailTools,
  forms: formsTools,
  lists: listsTools,
  "business-rules": businessRulesTools,
  sla: slaTools,
  approvals: approvalsTools,
  attachments: attachmentsTools,
  "ui-policies": uiPoliciesTools,
  metrics: metricsTools,
  dashboards: dashboardsTools,
  menus: menusTools,
  applications: applicationsTools,
  queues: queuesTools,
  journals: journalsTools,
  "data-policies": dataPoliciesTools,
  workspace: workspaceTools,
  templates: templatesTools,
  schedules: schedulesTools,
  variables: variablesTools,
  validators: validatorsTools,
  connectors: connectorsTools,
  adapters: adaptersTools,
  handlers: handlersTools,
  filters: filtersTools,
  formatters: formattersTools,
  encoders: encodersTools,
  utilities: utilitiesTools,
  helpers: helpersTools,
  extensions: extensionsTools,
  converters: convertersTools,
  advanced: advancedTools,
  asset: assetTools,
  security: securityTools,
  reporting: reportingTools,
  "hr-csm": hrCsmTools,
  notifications: notificationsTools,
  mobile: mobileTools,
  atf: atfTools,
  automation: automationTools,
  "update-sets": updateSetsTools,
  "local-sync": localSyncTools,
  "ui-builder": uiBuilderTools,
  integration: integrationTools,
  platform: platformTools,
  devops: devopsTools,
  "virtual-agent": virtualAgentTools,
  "flow-designer": flowDesignerTools,
  plugins: pluginsTools,
  agile: agileTools,
  "blast-radius": blastRadiusTools,
  addons: addonsTools,
  aggregators: aggregatorsTools,
  calculators: calculatorsTools,
  decoders: decodersTools,
  development: developmentTools,
  generators: generatorsTools,
  mappers: mappersTools,
  parsers: parsersTools,
  "performance-analytics": performanceAnalyticsTools,
  processors: processorsTools,
  procurement: procurementTools,
  project: projectTools,
  "service-portal": servicePortalTools,
  "system-properties": systemPropertiesTools,
  transformers: transformersTools,
  csm: csmTools,
  hr: hrTools,
}

export class ToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map()
  private config: ToolRegistryConfig
  private discoveryInProgress = false
  private useStaticMode = false

  constructor(config: Partial<ToolRegistryConfig> = {}) {
    this.config = {
      toolsDirectory: path.join(__dirname, "../tools"),
      autoDiscovery: true,
      enableCaching: true,
      cacheMaxAge: 60000, // 1 minute
      validateOnRegister: true,
      ...config,
    }
  }

  /**
   * Initialize tool registry with static imports
   *
   * Static imports are used because:
   * 1. They're bundled at build time and always available
   * 2. File-based discovery fails in npm packages (only index.js is shipped)
   * 3. Static mode correctly handles the *_def and *_exec export patterns
   */
  async initialize(): Promise<ToolDiscoveryResult> {
    mcpDebug("[ToolRegistry] Initializing with static imports...")

    const startTime = Date.now()

    // Always use static imports - they're reliable in both dev and npm package
    this.useStaticMode = true
    const result = await this.loadStaticTools()

    result.duration = Date.now() - startTime

    mcpDebug("[ToolRegistry] Initialization complete:")
    mcpDebug(`  - Mode: static (bundled)`)
    mcpDebug(`  - Domains: ${result.domains.length}`)
    mcpDebug(`  - Tools found: ${result.toolsFound}`)
    mcpDebug(`  - Tools registered: ${result.toolsRegistered}`)
    mcpDebug(`  - Tools failed: ${result.toolsFailed}`)
    mcpDebug(`  - Duration: ${result.duration}ms`)

    return result
  }

  /**
   * Load tools from static imports (for bundled mode)
   */
  private async loadStaticTools(): Promise<ToolDiscoveryResult> {
    const result: ToolDiscoveryResult = {
      toolsFound: 0,
      toolsRegistered: 0,
      toolsFailed: 0,
      domains: [],
      errors: [],
      duration: 0,
    }

    for (const [domain, toolModule] of Object.entries(STATIC_TOOL_MODULES)) {
      result.domains.push(domain)

      // Find all tool definitions and executors in the module
      // Pattern: toolDefinition ends with _def, execute function ends with _exec
      const exports = Object.keys(toolModule)
      const defExports = exports.filter((key) => key.endsWith("_def"))

      for (const defKey of defExports) {
        const baseName = defKey.replace(/_def$/, "")
        const execKey = baseName + "_exec"

        const definition = toolModule[defKey]
        const executor = toolModule[execKey]

        if (definition && executor) {
          result.toolsFound++

          try {
            // Register the tool
            const registeredTool: RegisteredTool = {
              definition,
              executor,
              domain,
              filePath: `static:${domain}/${baseName}`,
              metadata: {
                addedAt: new Date(),
                version: "1.0.0",
              },
            }

            this.tools.set(definition.name, registeredTool)
            result.toolsRegistered++
          } catch (error: any) {
            result.toolsFailed++
            result.errors.push({
              filePath: `static:${domain}/${baseName}`,
              error: error.message,
            })
          }
        }
      }
    }

    mcpDebug(
      `[ToolRegistry] Loaded ${result.toolsRegistered} tools from ${result.domains.length} domains (static mode)`,
    )
    return result
  }

  /**
   * Discover all domain directories
   */
  private async discoverDomains(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.config.toolsDirectory, { withFileTypes: true })
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => !name.startsWith(".") && !name.startsWith("_"))
    } catch (error: any) {
      mcpDebug("[ToolRegistry] Failed to discover domains:", error.message)
      return []
    }
  }

  /**
   * Discover tools in a specific domain
   */
  private async discoverDomainTools(domain: string, domainPath: string): Promise<ToolDiscoveryResult> {
    const result: ToolDiscoveryResult = {
      toolsFound: 0,
      toolsRegistered: 0,
      toolsFailed: 0,
      domains: [domain],
      errors: [],
      duration: 0,
    }

    try {
      // Read all .js files in domain directory (except index.js)
      // In compiled output, we want .js files, not .ts or .d.ts
      const entries = await fs.readdir(domainPath, { withFileTypes: true })
      const toolFiles = entries
        .filter(
          (entry) =>
            entry.isFile() &&
            entry.name.endsWith(".js") &&
            entry.name !== "index.js" &&
            !entry.name.endsWith(".d.ts") && // Exclude TypeScript declaration files
            !entry.name.endsWith(".js.map"), // Exclude source maps
        )
        .map((entry) => entry.name)

      result.toolsFound = toolFiles.length

      // Load each tool file
      for (const toolFile of toolFiles) {
        const toolPath = path.join(domainPath, toolFile)
        try {
          await this.loadAndRegisterTool(domain, toolPath)
          result.toolsRegistered++
        } catch (error: any) {
          result.toolsFailed++
          result.errors.push({
            filePath: toolPath,
            error: error.message,
          })
          mcpDebug(`[ToolRegistry] Failed to load ${toolPath}:`, error.message)
        }
      }
    } catch (error: any) {
      mcpDebug(`[ToolRegistry] Failed to discover tools in ${domain}:`, error.message)
    }

    return result
  }

  /**
   * Load and register a tool from a file
   */
  private async loadAndRegisterTool(domain: string, filePath: string): Promise<void> {
    try {
      // Dynamic import of tool module
      const toolModule = await import(filePath)

      // Validate tool module exports
      if (!toolModule.toolDefinition) {
        throw new Error('Tool module must export "toolDefinition"')
      }
      if (!toolModule.execute) {
        throw new Error('Tool module must export "execute" function')
      }

      const definition: MCPToolDefinition = toolModule.toolDefinition
      const executor: ToolExecutor = toolModule.execute

      // Validate tool definition
      if (this.config.validateOnRegister) {
        const validation = this.validateToolDefinition(definition)
        if (!validation.valid) {
          throw new Error(`Validation failed: ${validation.errors.join(", ")}`)
        }
      }

      // Register tool
      const registeredTool: RegisteredTool = {
        definition,
        executor,
        domain,
        filePath,
        metadata: {
          addedAt: new Date(),
          version: toolModule.version || "1.0.0",
          author: toolModule.author,
        },
      }

      this.tools.set(definition.name, registeredTool)
      mcpDebug(`[ToolRegistry] Registered: ${definition.name} (${domain})`)
    } catch (error: any) {
      throw new Error(`Failed to load tool from ${filePath}: ${error.message}`)
    }
  }

  /**
   * Validate tool definition structure
   */
  private validateToolDefinition(definition: MCPToolDefinition): ToolValidationResult {
    const errors: string[] = []
    const warnings: string[] = []

    // Required fields
    if (!definition.name) {
      errors.push("Tool name is required")
    } else if (!/^[a-z_][a-z0-9_]*$/.test(definition.name)) {
      errors.push("Tool name must match pattern: ^[a-z_][a-z0-9_]*$ (snake_case)")
    }

    if (!definition.description) {
      errors.push("Tool description is required")
    } else if (definition.description.length < 10) {
      warnings.push("Tool description should be more descriptive (at least 10 characters)")
    }

    if (!definition.inputSchema) {
      errors.push("Tool inputSchema is required")
    } else {
      if (definition.inputSchema.type !== "object") {
        errors.push('Tool inputSchema.type must be "object"')
      }
      if (!definition.inputSchema.properties) {
        warnings.push("Tool should define input properties")
      }
    }

    // Check for duplicate names
    if (this.tools.has(definition.name)) {
      errors.push(`Tool name "${definition.name}" is already registered`)
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    }
  }

  /**
   * Get all registered tool definitions (for MCP server)
   */
  getToolDefinitions(): MCPToolDefinition[] {
    return Array.from(this.tools.values()).map((tool) => tool.definition)
  }

  /**
   * Get tool definitions filtered by domains
   * Used by SNOW_TOOL_DOMAINS env var to reduce token usage for external MCP clients
   *
   * @param domains - Array of domain names to include (e.g., ['operations', 'deployment', 'cmdb'])
   * @returns Tool definitions only from the specified domains
   */
  getToolDefinitionsByDomains(domains: string[]): MCPToolDefinition[] {
    const domainSet = new Set(domains.map((d) => d.toLowerCase().trim()))
    return Array.from(this.tools.values())
      .filter((tool) => domainSet.has(tool.domain.toLowerCase()))
      .map((tool) => tool.definition)
  }

  /**
   * Get available domain names for documentation/help
   */
  getAvailableDomains(): string[] {
    return Object.keys(STATIC_TOOL_MODULES).sort()
  }

  /**
   * Get registered tool by name
   */
  getTool(name: string): RegisteredTool | undefined {
    return this.tools.get(name)
  }

  /**
   * Execute a tool by name
   */
  async executeTool(name: string, args: Record<string, any>, context: any): Promise<any> {
    const tool = this.tools.get(name)
    if (!tool) {
      throw new Error(`Tool not found: ${name}`)
    }

    try {
      mcpDebug(`[ToolRegistry] Executing: ${name}`)
      const result = await tool.executor(args, context)
      mcpDebug(`[ToolRegistry] Success: ${name}`)
      return result
    } catch (error: any) {
      mcpDebug(`[ToolRegistry] Failed: ${name}`, error.message)
      throw error
    }
  }

  /**
   * Get tools by domain
   */
  getToolsByDomain(domain: string): RegisteredTool[] {
    return Array.from(this.tools.values()).filter((tool) => tool.domain === domain)
  }

  /**
   * Get all domains
   */
  getDomains(): string[] {
    const domains = new Set<string>()
    this.tools.forEach((tool) => domains.add(tool.domain))
    return Array.from(domains).sort()
  }

  /**
   * Get registry statistics
   */
  getStatistics() {
    const domains = this.getDomains()
    const stats = {
      totalTools: this.tools.size,
      totalDomains: domains.length,
      toolsByDomain: {} as Record<string, number>,
    }

    domains.forEach((domain) => {
      stats.toolsByDomain[domain] = this.getToolsByDomain(domain).length
    })

    return stats
  }

  /**
   * Export tool definitions to JSON file
   */
  private async exportToolDefinitions(): Promise<void> {
    const configPath = path.join(__dirname, "../config/tool-definitions.json")
    const metadata: ToolMetadata[] = []

    this.tools.forEach((tool, name) => {
      metadata.push({
        name,
        domain: tool.domain,
        description: tool.definition.description,
        version: tool.metadata.version,
        author: tool.metadata.author,
        tags: [tool.domain],
      })
    })

    try {
      await fs.mkdir(path.dirname(configPath), { recursive: true })
      await fs.writeFile(configPath, JSON.stringify(metadata, null, 2), "utf-8")
      mcpDebug(`[ToolRegistry] Exported ${metadata.length} tool definitions to ${configPath}`)
    } catch (error: any) {
      mcpDebug("[ToolRegistry] Failed to export tool definitions:", error.message)
    }
  }

  /**
   * Reload tools from disk (for development hot-reload)
   */
  async reload(): Promise<ToolDiscoveryResult> {
    mcpDebug("[ToolRegistry] Reloading tools...")
    this.tools.clear()
    return await this.initialize()
  }

  /**
   * Clear all registered tools
   */
  clear(): void {
    this.tools.clear()
    mcpDebug("[ToolRegistry] Cleared all registered tools")
  }
}

// Export singleton instance
export const toolRegistry = new ToolRegistry()
