import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { onMount } from "solid-js"
import { useSync } from "../../context/sync"
import { useDialog } from "../../ui/dialog"
import { useSDK } from "../../context/sdk"
import { useToast } from "../../ui/toast"
import { DialogSelect } from "../../ui/dialog-select"
import { runProviderAuth } from "../../component/dialog-provider"

const id = "internal:servicenow-auth"

// The Serac Dashboard is the PRIMARY auth: the user logs into
// dashboard.serac.build (device auth), gets a JWT, and the platform brokers
// ServiceNow + ALL integrations through the enterprise-proxy MCP server. The
// direct ServiceNow OAuth/Basic path stays as a secondary option for users
// connecting their own instance without the platform.
const SERAC_PROVIDER = "serac"
const SERVICENOW_PROVIDER = "servicenow"

/**
 * Drives the Serac auth flow from inside the TUI, mirroring `serac auth login`.
 * Presents the dashboard login first (primary), then the direct ServiceNow
 * connection as a fallback. The chosen credential is collected + stored under
 * its provider via the same server endpoints the provider list uses.
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

  onMount(() => {
    const ctx = { sync, dialog, sdk, toast }
    const hasSerac = !!sync.data.provider_auth[SERAC_PROVIDER]
    const hasServiceNow = !!sync.data.provider_auth[SERVICENOW_PROVIDER]

    if (!hasSerac && !hasServiceNow) {
      toast.show({
        variant: "error",
        message: "Serac auth is unavailable. Are the Serac plugins loaded?",
      })
      dialog.clear()
      return
    }

    // Only one provider available — go straight to it.
    if (!hasSerac) {
      void runProviderAuth(ctx, SERVICENOW_PROVIDER)
      return
    }
    if (!hasServiceNow) {
      void runProviderAuth(ctx, SERAC_PROVIDER)
      return
    }

    // Both available: dashboard login is the primary, listed first.
    dialog.replace(
      () => (
        <DialogSelect
          title="Sign in to Serac"
          options={[
            { title: "Serac Dashboard (recommended)", value: SERAC_PROVIDER },
            { title: "Connect ServiceNow directly", value: SERVICENOW_PROVIDER },
          ]}
          onSelect={(option) => void runProviderAuth(ctx, option.value)}
        />
      ),
      () => dialog.clear(),
    )
  })

  return null
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
