import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { onMount } from "solid-js"
import { useSync } from "../../context/sync"
import { useDialog } from "../../ui/dialog"
import { useSDK } from "../../context/sdk"
import { useToast } from "../../ui/toast"
import { runProviderAuth } from "../../component/dialog-provider"

const id = "internal:servicenow-auth"
const PROVIDER = "servicenow"

/**
 * Drives the ServiceNow AuthHook flow directly, mirroring `serac auth login`
 * but from inside the TUI. The credential is collected + stored under the
 * `servicenow` provider via the same server endpoints the provider list uses.
 *
 * We land straight on the ServiceNow provider instead of opening the generic
 * provider picker (`/connect`) because an AuthHook-only provider (no `loader`,
 * no models.dev entry) does not surface in that list until a credential already
 * exists — so on a fresh install ServiceNow would be unreachable there.
 */
function ServiceNowAuth() {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()

  onMount(() => {
    if (!sync.data.provider_auth[PROVIDER]) {
      toast.show({
        variant: "error",
        message: "ServiceNow auth is unavailable. Is the ServiceNow plugin loaded?",
      })
      dialog.clear()
      return
    }
    void runProviderAuth({ sync, dialog, sdk, toast }, PROVIDER)
  })

  return null
}

function show(api: TuiPluginApi) {
  api.ui.dialog.replace(() => <ServiceNowAuth />)
}

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: "servicenow.auth",
        title: "ServiceNow Auth",
        slashName: "auth",
        slashAliases: ["login", "servicenow"],
        category: "ServiceNow",
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
