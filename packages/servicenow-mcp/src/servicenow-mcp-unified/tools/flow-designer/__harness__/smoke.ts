/**
 * Self-contained smoke test for the Flow Designer tool against a live instance.
 *
 *   SN_INSTANCE=… SN_CLIENT_ID=… SN_CLIENT_SECRET=… bun run smoke.ts
 *
 * Builds a real flow (record trigger + IF condition + Log action) and publishes
 * it, asserting the tool actually produced a compiled, active flow — i.e. the
 * full build → publish → snapshot path works end-to-end. Cleans up after itself.
 */
import { run, payload, cleanup } from "./harness.js"

const PREFIX = "zzz_serac_test_"
const name = PREFIX + "smoke"
const ok = (label: string, p: any) => console.log((p?.success ? "  ✓ " : "  ✗ ") + label + (p?.error ? " — " + p.error : ""))

console.log("→ build + publish", name)
const created = payload(await run("create", { name, description: "harness smoke", trigger_type: "record_create", table: "incident" }))
const flowId = created?.data?.flow?.sys_id
ok("create (record trigger)", created)
ok("add_flow_logic IF", payload(await run("add_flow_logic", { flow_id: flowId, logic_type: "IF", condition_name: "High priority", condition: "priority<=2" })))
ok("add_action Log", payload(await run("add_action", { flow_id: flowId, action_type: "log", action_inputs: { message: "high prio" } })))

const pub = payload(await run("publish", { flow_id: flowId }))
ok("publish", pub)
const good = pub?.success === true && !!pub?.data?.snapshot
console.log(good ? `PASS — published, snapshot ${pub.data.snapshot}, status ${pub.data.status}` : "FAIL — flow did not publish with a compiled snapshot")

console.log("→ cleanup", PREFIX + "*:", await cleanup(PREFIX), "removed")
process.exit(good ? 0 : 1)
