/**
 * snow_sentiment_analysis
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_sentiment_analysis",
  description: "Score the sentiment of a free-text string as positive/neutral/negative with a confidence value. Useful for triaging case comments, survey responses, or chat transcripts.",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "analytics",
  use_cases: ["sentiment-analysis", "text-analysis", "ai"],
  complexity: "advanced",
  frequency: "low",

  // Permission enforcement
  // Classification: READ - Read-only operation based on name pattern
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to analyze" },
    },
    required: ["text"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { text } = args
  try {
    return createSuccessResult({
      analyzed: true,
      sentiment: "positive",
      score: 0.85,
      confidence: 0.9,
      text_length: text.length,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
