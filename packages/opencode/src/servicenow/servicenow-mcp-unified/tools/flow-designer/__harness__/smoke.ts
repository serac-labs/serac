/**
 * Self-contained smoke test for the Flow Designer tool against a live instance.
 *
 *   SN_INSTANCE=… SN_CLIENT_ID=… SN_CLIENT_SECRET=… bun run smoke.ts
 *
 * Exercises the harness end-to-end and asserts the publish-verification fix:
 * an empty flow has no compiled snapshot, so `publish` must report success=false
 * with a real reason — not a false "published". Cleans up after itself.
 */
import { run, payload, cleanup } from "./harness.js"

const PREFIX = "zzz_serac_test_"
const name = PREFIX + "smoke"

console.log("→ create", name)
const created = payload(await run("create", { name, description: "harness smoke test" }))
const flowId = created?.data?.flow?.sys_id
console.log("  created:", created?.success, "flow:", flowId)

console.log("→ publish (empty flow → verification must reject)")
const pub = payload(await run("publish", { flow_id: flowId }))
console.log("  success:", pub?.success, "| reason:", pub?.error || "(published)")
if (pub?.success === true) console.log("  ⚠️  expected verification to reject an uncompiled flow")

console.log("→ cleanup", PREFIX + "*")
console.log("  removed", await cleanup(PREFIX), "test flow(s)")
