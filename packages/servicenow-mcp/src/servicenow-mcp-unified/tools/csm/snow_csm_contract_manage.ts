/**
 * snow_csm_contract_manage - Unified contract / entitlement / offering management
 *
 * Wraps ast_contract (asset contract) + service_entitlement + service_offering.
 * CSM (com.sn_customerservice) does not ship native contract tables; ast_contract
 * is the closest functional equivalent that production CSM customers actually
 * use to model what an account is entitled to. service_entitlement.contract is
 * a real reference field pointing at ast_contract, so the join is native.
 *
 * Companion to snow_csm_communication_manage — that tool logs the customer
 * interactions; this tool manages the contract surface those interactions
 * are governed by. Also pairs with snow_create_customer_account (creates the
 * account that owns the contract) and snow_create_entitlement (creates one
 * entitlement record at a time).
 */
import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

const CONTRACT_TABLE = "ast_contract"
const ENTITLEMENT_TABLE = "service_entitlement"
const OFFERING_TABLE = "service_offering"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_csm_contract_manage",
  description: `Wraps ast_contract (asset contract) + service_entitlement + service_offering. CSM (com.sn_customerservice) does not have native contract tables; ast_contract is the closest functional equivalent and service_entitlement.contract is a native reference to it.

Actions:
- list_contracts — query ast_contract, optional filters: account, vendor, customer, state, active_only
- get_contract — fetch one ast_contract row by sys_id or number, with related entitlement and offering counts
- create_contract — create an ast_contract; vendor + vendor_contract + contract_model are required by the schema
- list_entitlements — query service_entitlement, optional filters: contract, account, asset, active_only
- link_entitlement_to_contract — set service_entitlement.contract on an existing entitlement (the schema's native join)
- list_offerings — query service_offering, optional filters: company, vendor, contract, name

Companion tools: snow_csm_communication_manage (logs the customer interactions governed by the contract), snow_create_customer_account (creates the account), snow_create_entitlement (single-entitlement create).

Plugin requirement: ast_contract is platform-stock so it always exists, but service_entitlement and service_offering ship with com.sn_customerservice / Service Portfolio Management. When the underlying tables do not exist the tool returns a clear plugin-missing error.`,
  category: "itsm",
  subcategory: "csm",
  use_cases: ["customer-service", "contracts", "entitlements", "offerings", "csm"],
  complexity: "intermediate",
  frequency: "medium",
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Management action to perform",
        enum: [
          "list_contracts",
          "get_contract",
          "create_contract",
          "list_entitlements",
          "link_entitlement_to_contract",
          "list_offerings",
        ],
      },
      // Identification
      sys_id: {
        type: "string",
        description:
          "[get_contract] ast_contract sys_id. [link_entitlement_to_contract] target ast_contract sys_id (the contract the entitlement should be linked to).",
      },
      number: {
        type: "string",
        description: "[get_contract] ast_contract.number (alternative to sys_id)",
      },
      // Common filters
      account: {
        type: "string",
        description: "[list_contracts/list_entitlements] customer_account sys_id filter",
      },
      vendor: {
        type: "string",
        description: "[list_contracts/list_offerings/create_contract] core_company sys_id of the vendor",
      },
      customer: {
        type: "string",
        description: "[list_contracts/create_contract] core_company sys_id of the customer (ast_contract.customer)",
      },
      contract: {
        type: "string",
        description: "[list_entitlements/list_offerings] ast_contract sys_id filter",
      },
      asset: {
        type: "string",
        description: "[list_entitlements] alm_asset sys_id filter on service_entitlement.asset",
      },
      company: {
        type: "string",
        description: "[list_offerings] core_company sys_id filter on service_offering.company",
      },
      name: {
        type: "string",
        description:
          "[list_offerings/create_contract] for list_offerings: LIKE filter on service_offering.name. For create_contract: short_description (Name).",
      },
      state: {
        type: "string",
        description: "[list_contracts/create_contract] ast_contract.state — choices: draft, active, expired, cancelled",
      },
      active_only: {
        type: "boolean",
        description: "[list_contracts/list_entitlements] only return rows where active=true",
        default: false,
      },
      // CREATE_CONTRACT fields
      vendor_contract: {
        type: "string",
        description:
          "[create_contract] ast_contract.vendor_contract — vendor's contract number / external identifier. Mandatory on the dictionary.",
      },
      contract_model: {
        type: "string",
        description:
          "[create_contract] ast_contract.contract_model — cmdb_model sys_id of the contract model. Mandatory on the dictionary.",
      },
      starts: {
        type: "string",
        description: "[create_contract] ast_contract.starts (YYYY-MM-DD)",
      },
      ends: {
        type: "string",
        description: "[create_contract] ast_contract.ends (YYYY-MM-DD)",
      },
      short_description: {
        type: "string",
        description: "[create_contract] ast_contract.short_description (Name on the form)",
      },
      description: {
        type: "string",
        description: "[create_contract] ast_contract.description (free-text)",
      },
      cost_center: {
        type: "string",
        description: "[create_contract] cmn_cost_center sys_id",
      },
      po_number: {
        type: "string",
        description: "[create_contract] ast_contract.po_number",
      },
      // LINK_ENTITLEMENT_TO_CONTRACT
      entitlement: {
        type: "string",
        description:
          "[link_entitlement_to_contract] service_entitlement sys_id to update. Its .contract field will be set to the value of `sys_id`.",
      },
      // Listing
      limit: {
        type: "number",
        description: "[list_*] Maximum records to return",
        default: 50,
      },
      fields: {
        type: "string",
        description: "[list_*/get_contract] Comma-separated sysparm_fields override",
      },
    },
    required: ["action"],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const action = args.action as string

  try {
    switch (action) {
      case "list_contracts":
        return await executeListContracts(args, context)
      case "get_contract":
        return await executeGetContract(args, context)
      case "create_contract":
        return await executeCreateContract(args, context)
      case "list_entitlements":
        return await executeListEntitlements(args, context)
      case "link_entitlement_to_contract":
        return await executeLinkEntitlementToContract(args, context)
      case "list_offerings":
        return await executeListOfferings(args, context)
      default:
        return createErrorResult(
          `Unknown action: ${action}. Valid actions: list_contracts, get_contract, create_contract, list_entitlements, link_entitlement_to_contract, list_offerings`,
        )
    }
  } catch (error: unknown) {
    const err = error as Error & { response?: { status?: number; data?: { error?: { message?: string } } } }
    const apiMsg = err.response?.data?.error?.message || ""
    if (err.response?.status === 404 || /Invalid table|No such table/i.test(err.message || apiMsg)) {
      return createErrorResult(
        new SnowFlowError(
          ErrorType.PLUGIN_MISSING,
          `Required table not found. Verify ast_contract, service_entitlement and service_offering exist. service_entitlement / service_offering ship with com.sn_customerservice or Service Portfolio Management.`,
          { originalError: err },
        ),
      )
    }
    return createErrorResult(
      err instanceof SnowFlowError
        ? err
        : new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, `CSM contract ${action} failed: ${err.message}`, {
            originalError: err,
          }),
    )
  }
}

// ==================== list_contracts ====================

async function executeListContracts(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const account = args.account as string | undefined
  const vendor = args.vendor as string | undefined
  const customer = args.customer as string | undefined
  const state = args.state as string | undefined
  const active_only = args.active_only === true
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  const client = await getAuthenticatedClient(context)

  const queryParts: string[] = []
  if (account) queryParts.push(`account=${account}`)
  if (vendor) queryParts.push(`vendor=${vendor}`)
  if (customer) queryParts.push(`customer=${customer}`)
  if (state) queryParts.push(`state=${state}`)
  if (active_only) queryParts.push("active=true")

  const response = await client.get(`/api/now/table/${CONTRACT_TABLE}`, {
    params: {
      sysparm_query: queryParts.join("^"),
      sysparm_limit: limit,
      sysparm_orderby: "sys_updated_on",
      sysparm_display_value: "false",
      ...(fields
        ? { sysparm_fields: fields }
        : {
            sysparm_fields:
              "sys_id,number,short_description,account,customer,vendor,vendor_contract,state,starts,ends,active,sys_updated_on",
          }),
    },
  })

  const results = (response.data.result || []) as Array<Record<string, unknown>>
  return createSuccessResult({
    action: "list_contracts",
    table: CONTRACT_TABLE,
    count: results.length,
    contracts: results.map((r) => ({
      sys_id: r.sys_id,
      number: r.number,
      short_description: r.short_description,
      account: r.account,
      customer: r.customer,
      vendor: r.vendor,
      vendor_contract: r.vendor_contract,
      state: r.state,
      starts: r.starts,
      ends: r.ends,
      active: r.active,
      updated_at: r.sys_updated_on,
      url: `${context.instanceUrl}/nav_to.do?uri=${CONTRACT_TABLE}.do?sys_id=${r.sys_id}`,
    })),
  })
}

// ==================== get_contract ====================

async function executeGetContract(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const number = args.number as string | undefined
  if (!sys_id && !number) {
    return createErrorResult("sys_id or number is required for get_contract")
  }

  const client = await getAuthenticatedClient(context)
  const contract = await findContract(client, sys_id, number)
  if (!contract) return createErrorResult(`Contract not found: ${sys_id || number}`)

  const contractSysId = contract.sys_id as string

  // Count linked entitlements (service_entitlement.contract → ast_contract).
  const entResp = await client.get(`/api/now/table/${ENTITLEMENT_TABLE}`, {
    params: { sysparm_query: `contract=${contractSysId}`, sysparm_fields: "sys_id", sysparm_limit: 200 },
  })
  const entitlementCount = ((entResp.data.result || []) as unknown[]).length

  // Count linked offerings (service_offering.contract → ast_contract).
  const offResp = await client.get(`/api/now/table/${OFFERING_TABLE}`, {
    params: { sysparm_query: `contract=${contractSysId}`, sysparm_fields: "sys_id", sysparm_limit: 200 },
  })
  const offeringCount = ((offResp.data.result || []) as unknown[]).length

  return createSuccessResult({
    action: "get_contract",
    table: CONTRACT_TABLE,
    sys_id: contractSysId,
    contract,
    related: {
      entitlement_count: entitlementCount,
      offering_count: offeringCount,
    },
    url: `${context.instanceUrl}/nav_to.do?uri=${CONTRACT_TABLE}.do?sys_id=${contractSysId}`,
  })
}

// ==================== create_contract ====================

async function executeCreateContract(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  // ast_contract dictionary makes vendor_contract and contract_model mandatory.
  // vendor itself is not strictly mandatory but every realistic create needs it.
  const vendor = args.vendor as string | undefined
  const vendor_contract = args.vendor_contract as string | undefined
  const contract_model = args.contract_model as string | undefined
  const starts = args.starts as string | undefined
  const ends = args.ends as string | undefined

  if (!vendor) return createErrorResult("vendor (core_company sys_id) is required for create_contract")
  if (!vendor_contract) return createErrorResult("vendor_contract (string) is required for create_contract")
  if (!contract_model) return createErrorResult("contract_model (cmdb_model sys_id) is required for create_contract")
  if (!starts) return createErrorResult("starts (YYYY-MM-DD) is required for create_contract")
  if (!ends) return createErrorResult("ends (YYYY-MM-DD) is required for create_contract")

  const client = await getAuthenticatedClient(context)

  const payload: Record<string, unknown> = {
    vendor,
    vendor_contract,
    contract_model,
    starts,
    ends,
    active: true,
  }
  const account = args.account as string | undefined
  const customer = args.customer as string | undefined
  const short_description = args.short_description as string | undefined
  const description = args.description as string | undefined
  const cost_center = args.cost_center as string | undefined
  const po_number = args.po_number as string | undefined
  const state = args.state as string | undefined
  if (account) payload.account = account
  if (customer) payload.customer = customer
  if (short_description) payload.short_description = short_description
  if (description) payload.description = description
  if (cost_center) payload.cost_center = cost_center
  if (po_number) payload.po_number = po_number
  if (state) payload.state = state

  const response = await client.post(`/api/now/table/${CONTRACT_TABLE}`, payload)
  const created = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "create_contract",
    table: CONTRACT_TABLE,
    created: true,
    sys_id: created.sys_id,
    number: created.number,
    contract: created,
    url: `${context.instanceUrl}/nav_to.do?uri=${CONTRACT_TABLE}.do?sys_id=${created.sys_id}`,
  })
}

// ==================== list_entitlements ====================

async function executeListEntitlements(
  args: Record<string, unknown>,
  context: ServiceNowContext,
): Promise<ToolResult> {
  const contract = args.contract as string | undefined
  const account = args.account as string | undefined
  const asset = args.asset as string | undefined
  const active_only = args.active_only === true
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  const client = await getAuthenticatedClient(context)

  const queryParts: string[] = []
  if (contract) queryParts.push(`contract=${contract}`)
  if (account) queryParts.push(`account=${account}`)
  if (asset) queryParts.push(`asset=${asset}`)
  if (active_only) queryParts.push("active=true")

  const response = await client.get(`/api/now/table/${ENTITLEMENT_TABLE}`, {
    params: {
      sysparm_query: queryParts.join("^"),
      sysparm_limit: limit,
      sysparm_display_value: "false",
      ...(fields
        ? { sysparm_fields: fields }
        : {
            sysparm_fields:
              "sys_id,entitlement_name,account,contract,asset,product,start_date,end_date,total_units,remaining_units,unit,per_unit,active",
          }),
    },
  })

  const results = (response.data.result || []) as Array<Record<string, unknown>>
  return createSuccessResult({
    action: "list_entitlements",
    table: ENTITLEMENT_TABLE,
    count: results.length,
    entitlements: results.map((r) => ({
      sys_id: r.sys_id,
      entitlement_name: r.entitlement_name,
      account: r.account,
      contract: r.contract,
      asset: r.asset,
      product: r.product,
      start_date: r.start_date,
      end_date: r.end_date,
      total_units: r.total_units,
      remaining_units: r.remaining_units,
      unit: r.unit,
      per_unit: r.per_unit,
      active: r.active,
      url: `${context.instanceUrl}/nav_to.do?uri=${ENTITLEMENT_TABLE}.do?sys_id=${r.sys_id}`,
    })),
  })
}

// ==================== link_entitlement_to_contract ====================

async function executeLinkEntitlementToContract(
  args: Record<string, unknown>,
  context: ServiceNowContext,
): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const entitlement = args.entitlement as string | undefined

  if (!sys_id) return createErrorResult("sys_id (target ast_contract) is required for link_entitlement_to_contract")
  if (!entitlement)
    return createErrorResult("entitlement (service_entitlement sys_id) is required for link_entitlement_to_contract")

  const client = await getAuthenticatedClient(context)

  // Verify the contract exists before mutating the entitlement.
  const contract = await findContract(client, sys_id, undefined)
  if (!contract) return createErrorResult(`Contract not found: ${sys_id}`)

  // service_entitlement.contract is the dictionary-confirmed reference field.
  const response = await client.patch(`/api/now/table/${ENTITLEMENT_TABLE}/${entitlement}`, {
    contract: sys_id,
  })

  return createSuccessResult({
    action: "link_entitlement_to_contract",
    linked: true,
    contract_sys_id: sys_id,
    entitlement_sys_id: entitlement,
    entitlement: response.data.result,
    url: `${context.instanceUrl}/nav_to.do?uri=${ENTITLEMENT_TABLE}.do?sys_id=${entitlement}`,
  })
}

// ==================== list_offerings ====================

async function executeListOfferings(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const company = args.company as string | undefined
  const vendor = args.vendor as string | undefined
  const contract = args.contract as string | undefined
  const name = args.name as string | undefined
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  const client = await getAuthenticatedClient(context)

  const queryParts: string[] = []
  if (company) queryParts.push(`company=${company}`)
  if (vendor) queryParts.push(`vendor=${vendor}`)
  if (contract) queryParts.push(`contract=${contract}`)
  if (name) queryParts.push(`nameLIKE${name}`)

  const response = await client.get(`/api/now/table/${OFFERING_TABLE}`, {
    params: {
      sysparm_query: queryParts.join("^"),
      sysparm_limit: limit,
      sysparm_display_value: "false",
      ...(fields
        ? { sysparm_fields: fields }
        : {
            sysparm_fields:
              "sys_id,number,name,short_description,company,vendor,contract,state,price,price_unit,billing,sys_updated_on",
          }),
    },
  })

  const results = (response.data.result || []) as Array<Record<string, unknown>>
  return createSuccessResult({
    action: "list_offerings",
    table: OFFERING_TABLE,
    count: results.length,
    offerings: results.map((r) => ({
      sys_id: r.sys_id,
      number: r.number,
      name: r.name,
      short_description: r.short_description,
      company: r.company,
      vendor: r.vendor,
      contract: r.contract,
      state: r.state,
      price: r.price,
      price_unit: r.price_unit,
      billing: r.billing,
      updated_at: r.sys_updated_on,
      url: `${context.instanceUrl}/nav_to.do?uri=${OFFERING_TABLE}.do?sys_id=${r.sys_id}`,
    })),
  })
}

// ==================== helpers ====================

async function findContract(
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  sysId: string | undefined,
  number: string | undefined,
): Promise<Record<string, unknown> | null> {
  if (sysId) {
    const direct = await client.get(`/api/now/table/${CONTRACT_TABLE}/${sysId}`)
    if (direct.data.result && direct.data.result.sys_id) return direct.data.result
  }
  if (number) {
    const search = await client.get(`/api/now/table/${CONTRACT_TABLE}`, {
      params: { sysparm_query: `number=${number}`, sysparm_limit: 1 },
    })
    const results = (search.data.result || []) as Array<Record<string, unknown>>
    if (results.length > 0) return results[0]
  }
  return null
}

export const version = "1.1.0"
export const author = "groeimetai"
