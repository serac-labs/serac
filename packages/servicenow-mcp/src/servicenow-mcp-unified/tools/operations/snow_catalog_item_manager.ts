/**
 * snow_catalog_item_manager - Manage catalog items
 *
 * Create, update, or manage service catalog items.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_catalog_item_manager",
  description: "Create, update, or manage service catalog items",
  // Metadata for tool discovery (not sent to LLM)
  category: "itsm",
  subcategory: "catalog",
  use_cases: ["catalog-management", "service-catalog", "crud"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Management function - manages catalog items
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Action to perform",
        enum: ["create", "update", "activate", "deactivate", "delete"],
      },
      sys_id: {
        type: "string",
        description: "Catalog item sys_id (required for update/activate/deactivate/delete)",
      },
      name: {
        type: "string",
        description: "Catalog item name (required for create)",
      },
      short_description: {
        type: "string",
        description: "Short description",
      },
      category: {
        type: "string",
        description: "Category sys_id",
      },
      price: {
        type: "string",
        description: "Item price",
      },
    },
    required: ["action"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { action, sys_id, name, short_description, category, price } = args

  try {
    const client = await getAuthenticatedClient(context)

    switch (action) {
      case "create":
        if (!name) {
          return createErrorResult("name is required for create action")
        }

        const createData: any = {
          name,
          short_description: short_description || "",
          active: true,
        }

        if (category) createData.category = category
        if (price) createData.price = price

        const createResponse = await client.post("/api/now/table/sc_cat_item", createData)
        const createdItem = createResponse.data.result

        return createSuccessResult(
          {
            message: `Catalog item "${name}" created successfully`,
            catalog_item: {
              sys_id: createdItem.sys_id,
              name: createdItem.name,
              short_description: createdItem.short_description,
              active: createdItem.active,
            },
          },
          { action, sys_id: createdItem.sys_id },
        )

      case "update":
        if (!sys_id) {
          return createErrorResult("sys_id is required for update action")
        }

        const updateData: any = {}
        if (name) updateData.name = name
        if (short_description) updateData.short_description = short_description
        if (category) updateData.category = category
        if (price) updateData.price = price

        const updateResponse = await client.put(`/api/now/table/sc_cat_item/${sys_id}`, updateData)
        const updatedItem = updateResponse.data.result

        return createSuccessResult(
          {
            message: "Catalog item updated successfully",
            catalog_item: updatedItem,
          },
          { action, sys_id },
        )

      case "activate":
      case "deactivate":
        if (!sys_id) {
          return createErrorResult(`sys_id is required for ${action} action`)
        }

        const activeValue = action === "activate"
        const statusResponse = await client.put(`/api/now/table/sc_cat_item/${sys_id}`, {
          active: activeValue,
        })

        return createSuccessResult(
          {
            message: `Catalog item ${action}d successfully`,
            sys_id,
            active: activeValue,
          },
          { action, sys_id },
        )

      case "delete":
        if (!sys_id) {
          return createErrorResult("sys_id is required for delete action")
        }

        await client.delete(`/api/now/table/sc_cat_item/${sys_id}`)

        return createSuccessResult(
          {
            message: "Catalog item deleted successfully",
            sys_id,
          },
          { action, sys_id },
        )

      default:
        return createErrorResult(`Unknown action: ${action}`)
    }
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
