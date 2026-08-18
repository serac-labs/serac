/**
 * snow_cmdb_identify_reconcile rejects a malformed payload before it touches
 * the instance.
 *
 * The context below carries no usable credentials, so getAuthenticatedClient()
 * throws on it. That is the point: every case here must return a ToolResult, and
 * a rejected promise means the executor reached the network with a payload it
 * should have refused. Ordering is the thing being pinned — validation first,
 * client second.
 *
 * The data_source case is the one that matters most. Per the API reference,
 * POST /api/now/identifyreconcile without sysparm_data_source does not fail: it
 * stores the payload in the incomplete-payloads table. A caller who drops the
 * parameter gets HTTP 200 and an unchanged CMDB, so the parameter has to be
 * refused here rather than defaulted.
 *
 * Nothing beyond this point can be tested without an instance — identification
 * is the engine's work, not ours.
 */

import { describe, expect, test } from "@jest/globals"
import { execute } from "../servicenow-mcp-unified/tools/cmdb/snow_cmdb_identify_reconcile"
import { type ServiceNowContext } from "../servicenow-mcp-unified/shared/types"

const unusable: ServiceNowContext = {
  instanceUrl: "https://unreachable.invalid",
  clientId: "",
  clientSecret: "",
  tenantId: "cmdb-identify-reconcile-test",
}

const item = { className: "cmdb_ci_linux_server", values: { name: "host1", serial_number: "SN-1" } }

describe("snow_cmdb_identify_reconcile input validation", () => {
  test("an empty or missing items array is refused", async () => {
    expect(await execute({ data_source: "ServiceNow" }, unusable)).toMatchObject({ success: false })
    expect(await execute({ items: [], data_source: "ServiceNow" }, unusable)).toMatchObject({ success: false })
  })

  test("an item without className is refused, and the message names the index", async () => {
    const noClass = await execute({ items: [item, { values: { name: "x" } }], data_source: "ServiceNow" }, unusable)
    expect(noClass.success).toBe(false)
    expect(noClass.error).toContain("items[1]")

    const badValues = await execute(
      { items: [{ className: "cmdb_ci_server", values: [] }], data_source: "ServiceNow" },
      unusable,
    )
    expect(badValues.success).toBe(false)
    expect(badValues.error).toContain("items[0]")
  })

  test("an item identified without values is not refused locally", async () => {
    // The reference marks className as the only required field on an item: a CI
    // can be identified through sys_object_source_info or lookup alone. Refusing
    // that here would be stricter than the API this tool claims to mirror, so it
    // runs on to the client and rejects on the unusable credentials instead.
    await expect(
      execute(
        {
          items: [
            {
              className: "cmdb_ci_server",
              sys_object_source_info: { source_name: "ServiceNow", source_native_key: "host1" },
            },
          ],
          data_source: "ServiceNow",
        },
        unusable,
      ),
    ).rejects.toThrow()
  })

  test("a missing data_source is refused rather than defaulted", async () => {
    const result = await execute({ items: [item] }, unusable)
    expect(result.success).toBe(false)
    expect(result.error).toContain("data_source")
  })

  test("a relation with neither index pair nor id pair is refused", async () => {
    const noTarget = await execute(
      { items: [item, item], data_source: "ServiceNow", relations: [{ type: "Runs on::Runs" }] },
      unusable,
    )
    expect(noTarget.success).toBe(false)
    expect(noTarget.error).toContain("relations[0]")

    const noType = await execute(
      { items: [item, item], data_source: "ServiceNow", relations: [{ parent: 0, child: 1 }] },
      unusable,
    )
    expect(noType.success).toBe(false)
    expect(noType.error).toContain("relations[0]")
  })

  test("a parent/child index outside the items array is refused, and id pairs are not index-checked", async () => {
    const outside = await execute(
      { items: [item], data_source: "ServiceNow", relations: [{ parent: 0, child: 3, type: "Runs on::Runs" }] },
      unusable,
    )
    expect(outside.success).toBe(false)
    expect(outside.error).toContain("relations[0]")

    // parent_id/child_id name internal_ids, which may belong to a lookup or
    // related entry rather than a top-level item — bounds do not apply. This one
    // is valid, so it runs on to the client and rejects instead of returning.
    await expect(
      execute(
        {
          items: [item],
          data_source: "ServiceNow",
          relations: [{ parent_id: "a", child_id: "b", type: "Runs on::Runs" }],
        },
        unusable,
      ),
    ).rejects.toThrow()
  })
})
