# Flow Designer live test harness

Drives the real `snow_manage_flow` tool against a live ServiceNow instance, so
flow-authoring changes can be verified end-to-end — build a flow, publish it,
and confirm the server actually compiled a snapshot — instead of trusting the
API's HTTP status. This is the iterative dev loop for extending the Flow Designer
tooling against the introspected [`../contract/`](../contract) schema.

> ⚠️ This creates and publishes **real flow records**. Point it at a throwaway
> PDI, never a shared/production instance. All test flows use the `zzz_serac_test_`
> name prefix so `cleanup()` can remove them.

## Setup

The harness authenticates via OAuth `client_credentials`; the resolved user needs
Flow Designer admin rights. Provide credentials via env (never commit them):

```bash
export SN_INSTANCE=https://dev123456.service-now.com
export SN_CLIENT_ID=…
export SN_CLIENT_SECRET=…
```

## Run

```bash
bun run smoke.ts          # self-contained: create → publish → cleanup
```

## Use programmatically

```ts
import { run, payload, cleanup } from "./harness.js"

const created = payload(await run("create", { name: "zzz_serac_test_demo" }))
const flowId = created.data.flow.sys_id
await run("add_action", { flow_id: flowId, /* … */ })
const pub = payload(await run("publish", { flow_id: flowId }))
console.log(pub.success, pub.error)   // false + reason when no snapshot compiled
await cleanup("zzz_serac_test_")
```

`run(action, args)` calls the tool's `execute`; `payload(result)` unwraps the
JSON body; `cleanup(prefix)` deletes every flow whose name starts with `prefix`.
