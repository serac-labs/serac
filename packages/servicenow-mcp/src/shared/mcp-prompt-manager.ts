/**
 * MCP Prompt Manager
 * Comprehensive prompt management for MCP servers
 * Implements MCP prompts protocol for reusable prompt templates and workflows
 */

import { mcpDebug } from "./mcp-debug.js"

/**
 * Prompt argument definition
 */
export interface MCPPromptArgument {
  name: string
  description?: string
  required?: boolean
}

/**
 * Prompt definition
 */
export interface MCPPrompt {
  name: string
  description?: string
  arguments?: MCPPromptArgument[]
}

/**
 * Prompt message content types
 */
export interface MCPPromptTextContent {
  type: "text"
  text: string
}

export interface MCPPromptImageContent {
  type: "image"
  data: string
  mimeType: string
}

export interface MCPPromptResourceContent {
  type: "resource"
  resource: {
    uri: string
    text?: string
    blob?: string
    mimeType?: string
  }
}

export type MCPPromptContent = MCPPromptTextContent | MCPPromptImageContent | MCPPromptResourceContent

/**
 * Prompt message (role + content)
 */
export interface MCPPromptMessage {
  role: "user" | "assistant"
  content: MCPPromptContent
}

/**
 * Result from getting a prompt
 */
export interface MCPPromptResult {
  description?: string
  messages: MCPPromptMessage[]
}

/**
 * Prompt category for organization
 */
export interface PromptCategory {
  name: string
  description: string
  prompts: MCPPrompt[]
}

/**
 * Prompt handler function type
 */
export type PromptHandler = (args: Record<string, string>) => Promise<MCPPromptResult>

/**
 * MCP Prompt Manager
 * Manages prompt templates, registration, and execution
 *
 * Multi-tenant note: instances can be shared across requests. Once a
 * transport has finished bootstrapping, it SHOULD call `freeze()` on its
 * prompt manager — further `registerPrompt`/`unregisterPrompt`/`clearPrompts`
 * calls will then throw instead of silently mutating a shared registry.
 * This prevents a stray future handler or tool from leaking prompts across
 * tenants in HTTP context.
 */
export class MCPPromptManager {
  private prefix: string
  private promptRegistry: Map<string, MCPPrompt> = new Map()
  private promptHandlers: Map<string, PromptHandler> = new Map()
  private categories: PromptCategory[] = []
  private frozen: boolean = false

  constructor(serverName: string = "mcp-server") {
    this.prefix = `[PromptManager:${serverName}]`
    this.initializeDefaultPrompts()
  }

  /**
   * Mark this manager as frozen. Subsequent mutation attempts
   * (registerPrompt, unregisterPrompt, clearPrompts) throw instead of
   * silently mutating shared state.
   */
  freeze(): void {
    this.frozen = true
  }

  /**
   * Whether mutation methods are disabled.
   */
  isFrozen(): boolean {
    return this.frozen
  }

  private assertMutable(op: string): void {
    if (this.frozen) {
      throw new Error(
        `${this.prefix} Cannot ${op}: manager is frozen. Prompt state must not mutate after bootstrap.`,
      )
    }
  }

  /**
   * Initialize default ServiceNow prompts
   */
  private initializeDefaultPrompts(): void {
    // No default prompts — slash commands in the TUI add clutter without value.
    // The AI already has full context via system prompts and tool descriptions.
  }

  /**
   * Register a new prompt with its handler
   */
  registerPrompt(prompt: MCPPrompt, handler: PromptHandler): void {
    this.assertMutable("registerPrompt")
    this.promptRegistry.set(prompt.name, prompt)
    this.promptHandlers.set(prompt.name, handler)
    mcpDebug(`Registered prompt: ${prompt.name}`)
  }

  /**
   * Unregister a prompt
   */
  unregisterPrompt(name: string): boolean {
    this.assertMutable("unregisterPrompt")
    const deleted = this.promptRegistry.delete(name)
    this.promptHandlers.delete(name)
    if (deleted) {
      mcpDebug(`Unregistered prompt: ${name}`)
    }
    return deleted
  }

  /**
   * List all registered prompts
   */
  listPrompts(): MCPPrompt[] {
    return Array.from(this.promptRegistry.values())
  }

  /**
   * Get a specific prompt by name
   */
  getPrompt(name: string): MCPPrompt | undefined {
    return this.promptRegistry.get(name)
  }

  /**
   * Execute a prompt with arguments and return the result
   */
  async executePrompt(name: string, args: Record<string, string> = {}): Promise<MCPPromptResult> {
    const prompt = this.promptRegistry.get(name)
    if (!prompt) {
      throw new Error(`Prompt not found: ${name}`)
    }

    const handler = this.promptHandlers.get(name)
    if (!handler) {
      throw new Error(`No handler registered for prompt: ${name}`)
    }

    // Validate required arguments
    if (prompt.arguments) {
      for (const arg of prompt.arguments) {
        if (arg.required && !args[arg.name]) {
          throw new Error(`Missing required argument: ${arg.name}`)
        }
      }
    }

    mcpDebug(`Executing prompt: ${name}`, { args })
    return await handler(args)
  }

  /**
   * Get prompts by category
   */
  getPromptsByCategory(categoryName: string): MCPPrompt[] {
    const category = this.categories.find((c) => c.name === categoryName)
    return category ? category.prompts : []
  }

  /**
   * Get all categories
   */
  getCategories(): PromptCategory[] {
    return this.categories
  }

  /**
   * Search prompts by name or description
   */
  searchPrompts(query: string): MCPPrompt[] {
    const lowerQuery = query.toLowerCase()
    return this.listPrompts().filter(
      (prompt) =>
        prompt.name.toLowerCase().includes(lowerQuery) ||
        (prompt.description && prompt.description.toLowerCase().includes(lowerQuery)),
    )
  }

  /**
   * Get prompt statistics
   */
  getPromptStats(): {
    total: number
    categories: { [key: string]: number }
  } {
    const categories: { [key: string]: number } = {}

    for (const category of this.categories) {
      categories[category.name] = category.prompts.length
    }

    return {
      total: this.promptRegistry.size,
      categories,
    }
  }

  /**
   * Clear all registered prompts (useful for testing)
   */
  clearPrompts(): void {
    this.assertMutable("clearPrompts")
    this.promptRegistry.clear()
    this.promptHandlers.clear()
    this.categories = []
    mcpDebug("All prompts cleared")
  }
}
