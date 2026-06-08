/**
 * Drift check for the snFlowDesigner GraphQL contract.
 *
 * Re-introspects the live Flow Designer GraphQL schema and diffs it against the
 * saved fixture (snfd-graphql-contract.json), so a ServiceNow upgrade that
 * changes the API surface is caught before it silently breaks flow authoring or
 * publishing. Exits non-zero when drift is found.
 *
 *   SN_INSTANCE=https://devXXXXXX.service-now.com \
 *   SN_CLIENT_ID=… SN_CLIENT_SECRET=… \
 *   bun run drift-check.ts
 *
 * Requires GraphQL introspection enabled on the target:
 *   - sys_property `glide.graphql.introspection_enabled` = true
 *   - ⚠️ do NOT also enable `glide.graphql.glide_record_schema.introspection_enabled`
 *     — it hangs a type per table onto the schema and makes introspection time out.
 *   - the OAuth user needs the `graphql_schema_admin` role.
 * Use a throwaway PDI, and flip the property back to false when done.
 *
 * It only re-introspects the types already in the fixture (plus flags any new
 * referenced `global_snFlowDesigner_*` types), which is enough to detect drift.
 * Introspection on a busy PDI is slow (~tens of seconds per type), so a full run
 * takes a while — this is a maintenance tool, not a CI gate.
 */
import { readFileSync } from "fs"

const INSTANCE = process.env.SN_INSTANCE?.replace(/\/$/, "")
const CLIENT_ID = process.env.SN_CLIENT_ID
const CLIENT_SECRET = process.env.SN_CLIENT_SECRET
if (!INSTANCE || !CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set SN_INSTANCE, SN_CLIENT_ID and SN_CLIENT_SECRET")
  process.exit(2)
}

const fixture: Record<string, any> = JSON.parse(
  readFileSync(new URL("./snfd-graphql-contract.json", import.meta.url), "utf8"),
)

async function token(): Promise<string> {
  const res = await fetch(`${INSTANCE}/oauth_token.do`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: CLIENT_ID!, client_secret: CLIENT_SECRET! }),
  })
  const j = (await res.json()) as { access_token?: string }
  if (!j.access_token) throw new Error("token failed: " + JSON.stringify(j).slice(0, 120))
  return j.access_token
}

const TREF = "type { kind name ofType { kind name ofType { kind name } } }"
function named(t: any): string {
  while (t && !t.name) t = t.ofType
  return t ? t.name : "?"
}
function fieldMap(typeDef: any): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of typeDef?.inputFields || []) out[f.name] = named(f.type)
  for (const f of typeDef?.fields || []) out[f.name] = named(f.type)
  return out
}

async function introspect(tok: string, name: string, tries = 3): Promise<any | null> {
  const query = `{ __type(name:"${name}"){ name kind inputFields { name ${TREF} } fields { name ${TREF} } enumValues { name } } }`
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${INSTANCE}/api/now/graphql`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(120000),
      })
      const j = (await res.json()) as { data?: any; errors?: any }
      const errs = JSON.stringify(j.errors || "")
      if (errs.toLowerCase().includes("introspection is disabled")) {
        console.error("Introspection is disabled on this instance — enable glide.graphql.introspection_enabled (see header).")
        process.exit(2)
      }
      if (j?.data?.__type) return j.data.__type
    } catch {
      /* retry */
    }
  }
  return null
}

const tok = await token()
const names = Object.keys(fixture).filter((k) => !fixture[k]?._err)
console.log(`Drift check: ${names.length} types from fixture vs live ${INSTANCE}\n`)

const drift: string[] = []
const referenced = new Set<string>()
let checked = 0
for (const name of names) {
  const live = await introspect(tok, name)
  checked++
  if (!live) {
    drift.push(`REMOVED/UNREADABLE: ${name}`)
    continue
  }
  const was = fieldMap(fixture[name])
  const now = fieldMap(live)
  for (const f of Object.keys(now)) {
    if (now[f]?.startsWith?.("global_snFlowDesigner_")) referenced.add(now[f])
    if (!(f in was)) drift.push(`+ ${shortName(name)}.${f}: ${now[f]} (added)`)
    else if (was[f] !== now[f]) drift.push(`~ ${shortName(name)}.${f}: ${was[f]} -> ${now[f]} (type changed)`)
  }
  for (const f of Object.keys(was)) if (!(f in now)) drift.push(`- ${shortName(name)}.${f}: ${was[f]} (removed)`)
  if (checked % 10 === 0) console.log(`  …${checked}/${names.length}`)
}
for (const r of referenced) if (!fixture[r]) drift.push(`NEW TYPE referenced but not in fixture: ${shortName(r)}`)

function shortName(n: string): string {
  return n.replace("global_snFlowDesigner_", "~")
}

console.log("")
if (drift.length === 0) {
  console.log(`✓ No drift — the live snFlowDesigner schema matches the fixture (${names.length} types).`)
  process.exit(0)
}
console.log(`⚠️  ${drift.length} drift item(s):\n`)
for (const d of drift) console.log("  " + d)
console.log("\nReview these against snow_manage_flow.ts and update the fixture if the change is expected.")
process.exit(1)
