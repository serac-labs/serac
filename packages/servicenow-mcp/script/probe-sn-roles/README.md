# sn-role-probe

Resolves the minimum ServiceNow role required to invoke each MCP tool by
reading the live instance's ACL definitions directly. Output:
`packages/servicenow-mcp/sn-roles.manifest.json`.

It is a standalone artifact, not an input to `generate-tools-json.ts` — the two
manifests are fetched separately and joined client-side. Both are read from
`main` over raw.githubusercontent.com by the Serac Portal's tool-permissions
proxy and by `docs.serac.build`, so the checked-in copy IS the published
artifact. Moving or renaming it breaks production; see the consumer list in
`../../README.md`.

## Why ACL-based, not empirical?

The harness queries `sys_security_acl` + `sys_security_acl_role` for each
`(table, operation)` primitive that the tools use. This is SN's own source of
truth — the same data SN's auth engine consults at request time. It's faster
than probing as a low-role user (one GET per primitive vs. N probe attempts),
deterministic, and doesn't require provisioning a test user or creating any
artifacts on the instance.

What it doesn't capture: ACL condition scripts and advanced ACL scripts. The
manifest flags those (`scriptAcls > 0`) so consumers can show "additional
runtime checks may apply" next to the role list.

## Requirements

- A SN instance with an OAuth REST API entity that has `client_credentials`
  grant enabled, bound to a user with `admin` role.
- A local env file at `~/.config/serac/sn-probe.env`:

  ```sh
  SN_INSTANCE_URL='https://dev123456.service-now.com'
  SN_OAUTH_CLIENT_ID='...'
  SN_OAUTH_CLIENT_SECRET='...'
  ```

  Lock it down: `chmod 600 ~/.config/serac/sn-probe.env`.

## Run

```sh
bun run --cwd packages/servicenow-mcp probe:sn-roles
```

Output:

- Live progress to stdout (per-batch resolution count).
- Manifest written to `packages/servicenow-mcp/sn-roles.manifest.json`. Commit it: the Serac Portal's
  tool-permissions API and `docs.serac.build` both fetch that file from `main` at runtime, so an
  uncommitted regeneration changes nothing for anyone.
- No state files needed — full run takes 1–3 minutes.

## Resolution algorithm

For each `(table, operation)`:

1. **Direct**: ACLs where `name == <table>` and matching `operation`, active.
2. **Inherited**: walk `sys_db_object.super_class` up the table hierarchy.
3. **Wildcard**: ACLs where `name == "*"` and matching operation.
4. **None**: fall back to `["admin"]` (SN's implicit deny rule for tables with
   no ACL coverage at any level).

Multiple ACLs matching the same `(table, operation)` are OR-combined: any role
in any matching ACL grants access, subject to that ACL's condition/script.

## Output shape

```json
{
  "version": 1,
  "validatedOn": "glide-australia-02-11-2026__patch1-...",
  "testedAt": "2026-05-14T...",
  "stats": {
    "tools": 428,
    "untestable": 128,
    "primitivesTotal": 462,
    "primitivesResolved": 462,
    "sourceDistribution": { "direct": 380, "inherited": 60, "wildcard": 22 },
    "topRoles": [ { "role": "admin", "tools": 462 }, ... ]
  },
  "tools": {
    "snow_change_manage": {
      "snRoles": {
        "anyOf": ["admin"],
        "minimumBundle": ["itil", "snc_internal"]
      },
      "primitives": [
        { "table": "change_request", "operation": "create", "roles": ["itil", "sn_change_write"], "source": "direct", "scriptAcls": 0 },
        { "table": "sysapproval_approver", "operation": "create", "roles": ["snc_internal"], "source": "direct", "scriptAcls": 1 }
      ]
    },
    "snow_check_health": {
      "snRoles": {
        "anyOf": ["admin", "public", "snc_internal"],
        "minimumBundle": []
      },
      "primitives": [...]
    },
    "snow_date_filter": {
      "snRoles": null,
      "untestable": true,
      "reason": "no /api/now/table/<table> calls detected in static analysis"
    }
  }
}
```

Two rollup fields per tool:

- **`anyOf`** — single roles that ALONE suffice for the entire tool (intersection
  of primitive role sets, plus `admin` since admin bypasses ACLs). When this is
  just `["admin"]`, no non-admin role works on its own.
- **`minimumBundle`** — smallest set of roles the user needs **together** to
  unlock every primitive. Computed via greedy set-cover.
  - `[]` (empty) = entire tool is publicly accessible (no auth required)
  - `["foo"]` = single role suffices
  - `["foo", "bar"]` = user needs BOTH roles
  - `["admin"]` = some primitive is admin-only, no non-admin bundle works

`admin` is always an implicit alternative regardless of `minimumBundle` value —
it bypasses ACLs entirely in SN's auth engine.

## Re-running across SN releases

When SN ships a new release (Yokohama → Australia → next), re-run and diff
the manifest. Role renames or new plugin-specific roles show up as deltas.
