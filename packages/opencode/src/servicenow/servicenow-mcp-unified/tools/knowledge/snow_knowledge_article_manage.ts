/**
 * snow_knowledge_article_manage - Unified Knowledge Article Management
 *
 * Comprehensive knowledge article operations: create, update, get, publish, retire, search.
 * Supports full metadata, workflow states, attachments, and advanced search.
 *
 * Replaces: snow_create_knowledge_article, snow_update_knowledge_article,
 *           snow_get_knowledge_article_details, snow_publish_kb_article,
 *           snow_retire_knowledge_article, snow_search_knowledge
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_knowledge_article_manage",
  description: "Unified knowledge article management (create, update, get, publish, retire, search)",
  // Metadata for tool discovery (not sent to LLM)
  category: "itsm",
  subcategory: "knowledge",
  use_cases: ["knowledge", "articles", "kb"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Management operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Knowledge article action to perform",
        enum: ["create", "update", "get", "publish", "retire", "search"],
      },
      // CREATE parameters
      short_description: {
        type: "string",
        description: "[create/update] Article title",
      },
      text: {
        type: "string",
        description: "[create/update] Article content (HTML supported)",
      },
      kb_knowledge_base: {
        type: "string",
        description: "[create/search] Knowledge base sys_id or name",
      },
      kb_category: {
        type: "string",
        description: "[create/search] Category sys_id or name",
      },
      article_type: {
        type: "string",
        description: "[create] Type: text, html, wiki",
        default: "text",
      },
      workflow_state: {
        type: "string",
        description: "[create/update/search] State: draft, review, published, retired",
        default: "draft",
      },
      valid_to: {
        type: "string",
        description: "[create/update] Expiration date (YYYY-MM-DD)",
      },
      meta_description: {
        type: "string",
        description: "[create/update] SEO meta description",
      },
      keywords: {
        type: "array",
        items: { type: "string" },
        description: "[create/update] Search keywords",
      },
      author: {
        type: "string",
        description: "[create] Author user sys_id or username",
      },
      // GET/UPDATE/PUBLISH/RETIRE parameters
      sys_id: {
        type: "string",
        description: "[get/update/retire] Article sys_id",
      },
      article_sys_id: {
        type: "string",
        description: "[publish] Article sys_id (alias for sys_id)",
      },
      // GET parameters
      include_attachments: {
        type: "boolean",
        description: "[get] Include attachment information",
        default: false,
      },
      // RETIRE parameters
      retirement_reason: {
        type: "string",
        description: "[retire] Reason for retirement",
      },
      replacement_article: {
        type: "string",
        description: "[retire] Replacement article sys_id",
      },
      // SEARCH parameters
      query: {
        type: "string",
        description: "[search] Search query text",
      },
      limit: {
        type: "number",
        description: "[search] Maximum results to return",
        default: 10,
      },
      include_content: {
        type: "boolean",
        description: "[search] Include full article content",
        default: false,
      },
    },
    required: ["action"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { action } = args

  try {
    switch (action) {
      case "create":
        return await executeCreate(args, context)
      case "update":
        return await executeUpdate(args, context)
      case "get":
        return await executeGet(args, context)
      case "publish":
        return await executePublish(args, context)
      case "retire":
        return await executeRetire(args, context)
      case "search":
        return await executeSearch(args, context)
      default:
        return createErrorResult(`Unknown action: ${action}`)
    }
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

// ==================== CREATE ====================
async function executeCreate(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    short_description,
    text,
    kb_knowledge_base,
    kb_category,
    article_type = "text",
    workflow_state = "draft",
    valid_to,
    meta_description,
    keywords,
    author,
  } = args

  if (!short_description) {
    return createErrorResult("short_description is required for create action")
  }

  if (!text) {
    return createErrorResult("text is required for create action")
  }

  const client = await getAuthenticatedClient(context)

  // Build article data
  const articleData: any = {
    short_description,
    text,
    article_type,
    workflow_state,
  }

  if (kb_knowledge_base) articleData.kb_knowledge_base = kb_knowledge_base
  if (kb_category) articleData.kb_category = kb_category
  if (valid_to) articleData.valid_to = valid_to
  if (meta_description) articleData.meta_description = meta_description
  if (keywords) articleData.keywords = keywords.join(",")
  if (author) articleData.author = author

  const response = await client.post("/api/now/table/kb_knowledge", articleData)

  return createSuccessResult(
    {
      action: "create",
      created: true,
      article: response.data.result,
      sys_id: response.data.result.sys_id,
      number: response.data.result.number,
    },
    {
      operation: "create_knowledge_article",
      title: short_description,
      state: workflow_state,
    },
  )
}

// ==================== UPDATE ====================
async function executeUpdate(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { sys_id, short_description, text, workflow_state, valid_to, meta_description, keywords } = args

  if (!sys_id) {
    return createErrorResult("sys_id is required for update action")
  }

  const client = await getAuthenticatedClient(context)

  const updateData: any = {}
  if (short_description) updateData.short_description = short_description
  if (text) updateData.text = text
  if (workflow_state) updateData.workflow_state = workflow_state
  if (valid_to) updateData.valid_to = valid_to
  if (meta_description) updateData.meta_description = meta_description
  if (keywords) updateData.keywords = keywords.join(",")

  if (Object.keys(updateData).length === 0) {
    return createErrorResult("No fields to update provided")
  }

  const response = await client.patch(`/api/now/table/kb_knowledge/${sys_id}`, updateData)

  return createSuccessResult(
    {
      action: "update",
      updated: true,
      article: response.data.result,
      sys_id,
      fields_updated: Object.keys(updateData),
    },
    {
      operation: "update_article",
      fields_updated: Object.keys(updateData),
    },
  )
}

// ==================== GET ====================
async function executeGet(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { sys_id, include_attachments = false } = args

  if (!sys_id) {
    return createErrorResult("sys_id is required for get action")
  }

  const client = await getAuthenticatedClient(context)

  // Get article details
  const response = await client.get(`/api/now/table/kb_knowledge/${sys_id}`)
  const article = response.data.result

  // Get attachments if requested
  let attachments = []
  if (include_attachments) {
    const attachResponse = await client.get("/api/now/table/sys_attachment", {
      params: {
        sysparm_query: `table_name=kb_knowledge^table_sys_id=${sys_id}`,
        sysparm_limit: 50,
      },
    })
    attachments = attachResponse.data.result
  }

  return createSuccessResult(
    {
      action: "get",
      article,
      attachments: include_attachments ? attachments : undefined,
      attachment_count: attachments.length,
    },
    {
      operation: "get_article_details",
      article_id: sys_id,
    },
  )
}

// ==================== PUBLISH ====================
async function executePublish(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { sys_id, article_sys_id } = args
  const articleId = sys_id || article_sys_id

  if (!articleId) {
    return createErrorResult("sys_id or article_sys_id is required for publish action")
  }

  const client = await getAuthenticatedClient(context)

  const response = await client.put(`/api/now/table/kb_knowledge/${articleId}`, {
    workflow_state: "published",
  })

  return createSuccessResult({
    action: "publish",
    published: true,
    article: response.data.result,
    sys_id: articleId,
  })
}

// ==================== RETIRE ====================
async function executeRetire(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { sys_id, retirement_reason, replacement_article } = args

  if (!sys_id) {
    return createErrorResult("sys_id is required for retire action")
  }

  const client = await getAuthenticatedClient(context)

  const updateData: any = {
    workflow_state: "retired",
    retirement_date: new Date().toISOString(),
  }

  if (retirement_reason) updateData.retirement_reason = retirement_reason
  if (replacement_article) updateData.replacement_article = replacement_article

  const response = await client.patch(`/api/now/table/kb_knowledge/${sys_id}`, updateData)

  return createSuccessResult(
    {
      action: "retire",
      retired: true,
      article: response.data.result,
      sys_id,
    },
    {
      operation: "retire_article",
      reason: retirement_reason,
    },
  )
}

// ==================== SEARCH ====================
async function executeSearch(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    query,
    kb_knowledge_base,
    kb_category,
    workflow_state = "published",
    limit = 10,
    include_content = false,
  } = args

  if (!query) {
    return createErrorResult("query is required for search action")
  }

  const client = await getAuthenticatedClient(context)

  // Build query string
  let queryString = `short_descriptionLIKE${query}^ORtextLIKE${query}`

  if (kb_knowledge_base) {
    queryString += `^kb_knowledge_base=${kb_knowledge_base}`
  }
  if (kb_category) {
    queryString += `^kb_category=${kb_category}`
  }
  if (workflow_state) {
    queryString += `^workflow_state=${workflow_state}`
  }

  const response = await client.get("/api/now/table/kb_knowledge", {
    params: {
      sysparm_query: queryString,
      sysparm_limit: limit,
    },
  })

  const articles = response.data.result

  return createSuccessResult(
    {
      action: "search",
      articles,
      count: articles.length,
      query_used: queryString,
    },
    {
      operation: "search_knowledge",
      query,
      results: articles.length,
    },
  )
}

export const version = "2.0.0"
export const author = "Serac v8.2.0 Tool Merging - Phase 1"
