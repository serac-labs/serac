/**
 * snow_order_catalog_item - Order catalog item
 *
 * Orders a catalog item programmatically, creating a request (RITM) with
 * specified variable values.
 *
 * Operation order (avoids race condition with flows):
 *   1. Fetch variable definitions (item_option_new)
 *   2. Create sc_request
 *   3. Pre-create sc_item_option records in parallel (no RITM needed yet)
 *   4. Short delay to ensure DB commit
 *   5. Create sc_req_item (RITM) — flow triggers here with variables ready
 *   6. Create sc_item_option_mtom links in parallel
 *   7. Two PATCHs to trigger Business Rules that associate the flow context
 *
 * Based on contribution by @frodoyoraul (PR #83).
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

// Delay between sc_item_option creation and RITM insert to ensure DB commit
const VARIABLE_COMMIT_DELAY_MS = 1000

export const toolDefinition: MCPToolDefinition = {
  name: "snow_order_catalog_item",
  description: "Orders a catalog item programmatically, creating a request (RITM) with specified variable values.",
  category: "itsm",
  subcategory: "service-catalog",
  use_cases: ["ordering", "automation", "ritm"],
  complexity: "intermediate",
  frequency: "high",

  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      cat_item: { type: "string", description: "Catalog item sys_id" },
      requested_for: { type: "string", description: "User sys_id or username" },
      variables: { type: "object", description: "Variable name-value pairs" },
      quantity: { type: "number", description: "Quantity to order", default: 1 },
      delivery_address: { type: "string", description: "Delivery address" },
      special_instructions: { type: "string", description: "Special instructions" },
    },
    required: ["cat_item", "requested_for"],
  },
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { cat_item, requested_for, variables, quantity = 1, delivery_address, special_instructions } = args

  try {
    const client = await getAuthenticatedClient(context)

    // 1. Fetch variable definitions before creating the RITM
    const varDefsResponse = await client.get("/api/now/table/item_option_new", {
      params: {
        sysparm_query: "cat_item=" + cat_item,
        sysparm_fields: "sys_id,name",
        sysparm_limit: 100,
      },
    })
    const varDefs = varDefsResponse.data.result || []
    const varMap = new Map<string, string>()
    varDefs.forEach((def: any) => {
      if (def.name) varMap.set(def.name, def.sys_id)
    })

    // 2. Create sc_request
    const requestData: any = {
      requested_for,
      opened_by: requested_for,
    }
    if (special_instructions) requestData.special_instructions = special_instructions

    const requestResponse = await client.post("/api/now/table/sc_request", requestData)
    const requestId = requestResponse.data.result.sys_id

    // 3. Pre-create sc_item_option records in parallel (no RITM needed yet)
    const varEntries = variables ? Object.entries(variables).filter(([name]) => varMap.has(name)) : []
    const skippedVars = variables ? Object.keys(variables).filter((name) => !varMap.has(name)) : []

    const optionSysIds: Array<{ optionSysId: string }> = await Promise.all(
      varEntries.map(async ([varName, varValue]) => {
        const defSysId = varMap.get(varName)!
        const optResp = await client.post("/api/now/table/sc_item_option", {
          item_option_new: defSysId,
          value: varValue,
        })
        return { optionSysId: optResp.data.result.sys_id }
      }),
    )

    // 4. Wait for sc_item_option records to be committed in DB
    if (optionSysIds.length > 0) {
      await sleep(VARIABLE_COMMIT_DELAY_MS)
    }

    // 5. Create sc_req_item (RITM) — flow triggers here with variables already ready
    const ritmData: any = {
      request: requestId,
      cat_item,
      requested_for,
      quantity,
    }
    if (delivery_address) ritmData.delivery_address = delivery_address

    const ritmResponse = await client.post("/api/now/table/sc_req_item", ritmData)
    const ritmId = ritmResponse.data.result.sys_id
    const ritmNumber = ritmResponse.data.result.number

    // 6. Create sc_item_option_mtom links in parallel
    await Promise.all(
      optionSysIds.map(({ optionSysId }) =>
        client.post("/api/now/table/sc_item_option_mtom", {
          request_item: ritmId,
          sc_item_option: optionSysId,
        }),
      ),
    )

    // 7. Two PATCHs to trigger Business Rules that associate the flow context.
    //    sys_mod_count is auto-incremented by ServiceNow (the value we send is
    //    ignored), but the PATCH itself is a real update that fires BR triggers.
    //    Two updates are needed: the first associates the flow, the second
    //    ensures the flow context is fully propagated.
    if (optionSysIds.length > 0) {
      await client.patch("/api/now/table/sc_req_item/" + ritmId, { sys_mod_count: "1" })
      await client.patch("/api/now/table/sc_req_item/" + ritmId, { sys_mod_count: "1" })
    }

    return createSuccessResult(
      {
        ordered: true,
        request_id: requestId,
        ritm_id: ritmId,
        ritm_number: ritmNumber,
        quantity,
        variables_processed: varEntries.length,
        variables_skipped: skippedVars.length > 0 ? skippedVars : undefined,
      },
      {
        operation: "order_catalog_item",
        item: cat_item,
        requested_for,
      },
    )
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "2.0.0"
export const author = "Serac"
