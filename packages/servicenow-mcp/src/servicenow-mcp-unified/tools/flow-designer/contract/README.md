# snFlowDesigner GraphQL contract

The authoritative, introspected schema of ServiceNow's internal Flow Designer
GraphQL API (`POST /api/now/graphql`) that `snow_manage_flow.ts` drives. This is
reference + drift-detection material, not runtime code.

## Files

| File | Purpose |
|---|---|
| `snfd-graphql-contract.json` | Machine-readable: every type with its `inputFields`/`fields`/`enumValues`. Use for drift checks. |
| `snfd-graphql-contract.md` | Human-readable: each type and its fields, grouped write-path first. |

## What it covers

The entire authoring API is **two mutations**:

- `flow(flowPatch: global_snFlowDesigner_FlowPatch)` — patches the whole flow.
  Every nested collection (`triggerInstances`, `actions`, `flowLogics`,
  `subflows`, `stages`, `flowVariables`, `inputs`, `outputs`, …) is a CRUD
  wrapper `{ insert, update, delete }`.
- `safeEdit(safeEditInput: global_snFlowDesigner_SafeEditInput)` — the edit-lock
  lifecycle (`upsert` / `delete` / `read`). Releasing the lock (`delete`)
  triggers server-side compilation.

52 types total (write-side `*Input` types + the value/output types they
reference + the `*Definition` types).

## How it was produced / how to regenerate

Introspected from a **personal PDI** (a corporate instance cannot enable this).

1. Set sys_property **`glide.graphql.introspection_enabled` = true**.
   ⚠️ Do **NOT** also enable `glide.graphql.glide_record_schema.introspection_enabled` —
   that hangs a type for every ServiceNow table onto the schema and makes
   `__type`/`__schema` introspection time out.
2. The full `__schema` dump is too large — walk targeted `__type(name: "...")`
   queries starting from `MutationType → global → snFlowDesigner`, then BFS into
   every referenced `global_snFlowDesigner_*` type until the graph closes.
3. Set the property back to `false` when done.

Introspection requires the `graphql_schema_admin` role on the requesting user.

## Intended use

- **Drift detection** — `drift-check.ts` re-introspects the live schema and diffs
  it against this fixture, so a ServiceNow upgrade that changes `snFlowDesigner`
  is caught before it silently breaks flow authoring/publishing:
  ```bash
  SN_INSTANCE=… SN_CLIENT_ID=… SN_CLIENT_SECRET=… bun run drift-check.ts
  ```
  Needs introspection enabled (see above); exits non-zero on drift. It's a
  maintenance tool (introspection is slow), not a CI gate.
- **Field reference**: the source of truth for which fields each
  `flow(flowPatch)` element accepts when extending `snow_manage_flow.ts`.
