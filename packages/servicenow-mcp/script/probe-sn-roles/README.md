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

Documented once, in the package README's "The roles manifest" section
(`../../README.md`), which is the copy that ships to npm consumers behind the
`/sn-roles` subpath, and typed in `src/sn-roles.ts`. The copy that used to be
here had already drifted: it showed a `sourceDistribution` of
`{direct: 380, inherited: 60, wildcard: 22}` against a manifest that says
`{direct: 870, wildcard: 189, inherited: 42}`, and repeated the wrong rule for
`minimumBundle: ["admin"]`.

## Re-running across SN releases

When SN ships a new release (Yokohama → Australia → next), re-run and diff
the manifest. Role renames or new plugin-specific roles show up as deltas.
