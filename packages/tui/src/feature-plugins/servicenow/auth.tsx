import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, createSignal, onMount, Show } from "solid-js"
import { useSync } from "../../context/sync"
import { useDialog } from "../../ui/dialog"
import { useSDK } from "../../context/sdk"
import { useToast } from "../../ui/toast"
import { useTheme } from "../../context/theme"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { runProviderAuth } from "../../component/dialog-provider"
import { TextAttributes } from "@opentui/core"
import path from "path"
import fs from "fs"
import { Global } from "@opencode-ai/core/global"

const id = "internal:servicenow-auth"

// The Serac Dashboard is the PRIMARY auth: the user logs into
// dashboard.serac.build (device auth), gets a JWT, and the platform brokers
// ServiceNow + ALL integrations through the enterprise-proxy MCP server. The
// direct ServiceNow OAuth/Basic path stays as a secondary option for users
// connecting their own instance without the platform.
const SERAC_PROVIDER = "serac"
const SERVICENOW_PROVIDER = "servicenow"

// The two ServiceNow auth methods, in the order the ServiceNowAuthPlugin
// registers them (see packages/opencode/src/plugin/servicenow/auth.ts):
//   [0] OAuth (instance OAuth app), [1] Basic (username/password).
const SERVICENOW_METHOD_OAUTH = 0
const SERVICENOW_METHOD_BASIC = 1

const PORTAL_URL_FALLBACK = "https://dashboard.serac.build"

// ---------------------------------------------------------------------------
// Stored-auth helpers
//
// The TUI and the server run on the same machine, so we read the auth.json the
// server writes directly — the HTTP surface only exposes `auth.set`, not a way
// to read stored credentials. This mirrors how the opencode-side serac /
// servicenow plugins read their own creds from disk (Global.Path.data).
// ---------------------------------------------------------------------------

type StoredAuthEntry = { type?: string; key?: string; metadata?: Record<string, string> }

function readAuthFile(): Record<string, StoredAuthEntry> {
  try {
    const raw = fs.readFileSync(path.join(Global.Path.data, "auth.json"), "utf8")
    return JSON.parse(raw) as Record<string, StoredAuthEntry>
  } catch {
    return {}
  }
}

// The Serac dashboard JWT (an "api" record: key = JWT, metadata.portalUrl) the
// SeracDashboardAuthPlugin stores after device auth.
function readStoredSeracAuth(): { token: string; portalUrl: string } | undefined {
  const entry = readAuthFile()[SERAC_PROVIDER]
  if (!entry || entry.type !== "api" || !entry.key) return undefined
  return { token: entry.key, portalUrl: entry.metadata?.["portalUrl"] || PORTAL_URL_FALLBACK }
}

function hasStoredServiceNow(): boolean {
  const entry = readAuthFile()[SERVICENOW_PROVIDER]
  return !!(entry && entry.type === "api" && entry.metadata?.["instance"])
}

// ---------------------------------------------------------------------------
// Instance-picker endpoints (enterprise portal)
// ---------------------------------------------------------------------------

type SnInstance = {
  id: number
  instanceName: string
  instanceUrl: string
  environmentType: string
  isDefault: boolean
  enabled: boolean
}

// GET /api/servicenow/instances — the user's ServiceNow instances, keyed by the
// enterprise JWT.
async function fetchSnInstances(portalUrl: string, token: string): Promise<SnInstance[]> {
  try {
    const response = await fetch(`${portalUrl}/api/servicenow/instances`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    })
    if (!response.ok) return []
    const data = (await response.json()) as { success?: boolean; instances?: SnInstance[] }
    if (!data.success || !Array.isArray(data.instances)) return []
    return data.instances.filter((i) => i.enabled)
  } catch {
    return []
  }
}

// GET /api/servicenow/instances/:id/for-cli — that instance's direct creds.
async function fetchSnInstanceById(
  portalUrl: string,
  token: string,
  instanceId: number,
): Promise<{ instanceUrl: string; clientId: string; clientSecret: string } | undefined> {
  try {
    const response = await fetch(`${portalUrl}/api/servicenow/instances/${instanceId}/for-cli`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    })
    if (!response.ok) return undefined
    const data = (await response.json()) as {
      success?: boolean
      instance?: { instanceUrl?: string; clientId?: string; clientSecret?: string }
    }
    const inst = data.instance
    if (!data.success || !inst?.instanceUrl || !inst.clientId || !inst.clientSecret) return undefined
    return { instanceUrl: inst.instanceUrl, clientId: inst.clientId, clientSecret: inst.clientSecret }
  } catch {
    return undefined
  }
}

/**
 * "Select ServiceNow Instance" sub-flow. Requires a stored Serac dashboard JWT.
 * Fetches the user's instances, lets them pick one, fetches that instance's
 * direct creds and stores them under the "servicenow" provider in the SAME
 * "api" record shape the ServiceNowAuthPlugin's OAuth method produces
 * (metadata.instance + clientId + clientSecret), so the direct servicenow MCP
 * the servicenow config hook injects — and the footer — light up.
 */
function SeracInstancePicker() {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const { theme } = useTheme()

  type Step = "loading" | "not-connected" | "select" | "connecting"
  const [step, setStep] = createSignal<Step>("loading")
  const [instances, setInstances] = createSignal<SnInstance[]>([])

  let portalUrl = PORTAL_URL_FALLBACK
  let token = ""

  async function connect(instance: SnInstance) {
    setStep("connecting")
    const creds = await fetchSnInstanceById(portalUrl, token, instance.id)
    if (!creds) {
      toast.show({
        variant: "error",
        message: `Failed to fetch credentials for ${instance.instanceName}.`,
        duration: 5000,
      })
      setStep("select")
      return
    }
    // Store under "servicenow" matching the OAuth method's record shape so the
    // servicenow config hook reads instance/clientId/clientSecret back out.
    await sdk.client.auth.set({
      providerID: SERVICENOW_PROVIDER,
      auth: {
        type: "api",
        // No live access token yet — the servicenow-mcp server runs the OAuth
        // client-credentials/refresh against these. Key holds the client secret
        // so the record is never keyless.
        key: creds.clientSecret,
        metadata: {
          instance: creds.instanceUrl,
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
          authType: "oauth",
        },
      },
    })
    // Reload so the config hook re-reads auth.json and injects the direct
    // servicenow MCP, exactly like the provider-list auth flow does.
    await sdk.client.instance.dispose()
    await sync.bootstrap()
    toast.show({
      variant: "success",
      message: `Connected to ${instance.instanceName} (${instance.instanceUrl}).`,
      duration: 5000,
    })
    dialog.clear()
  }

  onMount(async () => {
    const auth = readStoredSeracAuth()
    if (!auth) {
      setStep("not-connected")
      return
    }
    portalUrl = auth.portalUrl
    token = auth.token
    const result = await fetchSnInstances(portalUrl, token)
    if (result.length === 0) {
      toast.show({
        variant: "error",
        message: "No ServiceNow instances found on your Serac dashboard.",
        duration: 5000,
      })
      dialog.replace(() => <SeracAuth />)
      return
    }
    setInstances(result)
    setStep("select")
  })

  const options = createMemo<DialogSelectOption<number>[]>(() =>
    instances().map((inst) => ({
      title: inst.instanceName,
      value: inst.id,
      description: inst.instanceUrl,
      footer: inst.environmentType + (inst.isDefault ? " (default)" : ""),
      category: "ServiceNow Instances",
      onSelect: () => void connect(inst),
    })),
  )

  return (
    <>
      <Show when={step() === "select"}>
        <DialogSelect title="Select ServiceNow Instance" options={options()} />
      </Show>
      <Show when={step() === "loading"}>
        <box paddingLeft={2} paddingRight={2} gap={1}>
          <text fg={theme.primary} attributes={TextAttributes.BOLD}>
            Loading ServiceNow instances…
          </text>
          <text fg={theme.textMuted}>Fetching instances from your Serac dashboard</text>
        </box>
      </Show>
      <Show when={step() === "connecting"}>
        <box paddingLeft={2} paddingRight={2} gap={1}>
          <text fg={theme.primary} attributes={TextAttributes.BOLD}>
            Connecting to ServiceNow…
          </text>
          <text fg={theme.textMuted}>Storing credentials and starting the MCP server</text>
        </box>
      </Show>
      <Show when={step() === "not-connected"}>
        <box paddingLeft={2} paddingRight={2} gap={1}>
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              Select ServiceNow Instance
            </text>
            <text fg={theme.textMuted} onMouseUp={() => dialog.replace(() => <SeracAuth />)}>
              esc
            </text>
          </box>
          <text fg={theme.warning} attributes={TextAttributes.BOLD}>
            Sign in to your Serac dashboard first
          </text>
          <text fg={theme.textMuted}>
            This loads the ServiceNow instances from your dashboard account. Choose "Serac dashboard" to log in.
          </text>
        </box>
      </Show>
    </>
  )
}

/**
 * Drives the Serac auth flow from inside the TUI, mirroring `serac auth login`.
 * Presents a single menu of every auth path — the dashboard login (primary),
 * the dashboard-driven instance picker, and the two direct ServiceNow methods —
 * each tagged with its Connected/Configured status, mirroring the old fork's
 * `/auth` dialog.
 *
 * We land straight on these providers instead of the generic picker (`/connect`)
 * because an AuthHook-only provider (no `loader`, no models.dev entry) does not
 * surface there until a credential already exists — so on a fresh install they
 * would be unreachable.
 */
function SeracAuth() {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()

  const ctx = { sync, dialog, sdk, toast }
  const hasSeracProvider = createMemo(() => !!sync.data.provider_auth[SERAC_PROVIDER])
  const hasServiceNowProvider = createMemo(() => !!sync.data.provider_auth[SERVICENOW_PROVIDER])

  onMount(() => {
    if (!hasSeracProvider() && !hasServiceNowProvider()) {
      toast.show({
        variant: "error",
        message: "Serac auth is unavailable. Are the Serac plugins loaded?",
      })
      dialog.clear()
    }
  })

  // Connected/Configured status read from the stored auth (auth.json), so the
  // menu reflects what is actually wired up, not just which plugins registered.
  const seracConnected = readStoredSeracAuth() !== undefined
  const serviceNowConfigured = hasStoredServiceNow()

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const out: DialogSelectOption<string>[] = []
    if (hasSeracProvider()) {
      out.push({
        title: "Serac dashboard",
        value: SERAC_PROVIDER,
        description: seracConnected ? "Connected" : undefined,
        category: "Serac dashboard",
        footer: "Log in — loads your ServiceNow, Jira & other credentials",
        onSelect: () => void runProviderAuth(ctx, SERAC_PROVIDER),
      })
      out.push({
        title: "Select ServiceNow Instance",
        value: "select-sn-instance",
        description: serviceNowConfigured ? "Connected" : undefined,
        category: "Serac dashboard",
        footer: "Switch instance from your dashboard",
        onSelect: () => dialog.replace(() => <SeracInstancePicker />),
      })
    }
    if (hasServiceNowProvider()) {
      out.push({
        title: "ServiceNow OAuth",
        value: "servicenow-oauth",
        description: serviceNowConfigured ? "Connected" : undefined,
        category: "ServiceNow (manual)",
        footer: "OAuth2 + PKCE",
        onSelect: () => void runProviderAuth(ctx, SERVICENOW_PROVIDER, SERVICENOW_METHOD_OAUTH),
      })
      out.push({
        title: "ServiceNow Basic Auth",
        value: "servicenow-basic",
        description: serviceNowConfigured ? "Configured" : undefined,
        category: "ServiceNow (manual)",
        footer: "Username / Password",
        onSelect: () => void runProviderAuth(ctx, SERVICENOW_PROVIDER, SERVICENOW_METHOD_BASIC),
      })
    }
    return out
  })

  return <DialogSelect title="Serac Authentication" options={options()} />
}

function show(api: TuiPluginApi) {
  api.ui.dialog.replace(() => <SeracAuth />)
}

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: "servicenow.auth",
        title: "Serac Auth",
        slashName: "auth",
        slashAliases: ["login", "servicenow", "serac"],
        category: "Serac",
        namespace: "palette",
        run() {
          show(api)
        },
      },
    ],
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
