import { createSignal, createMemo, onMount, Show } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useToast } from "@tui/ui/toast"
import { useTheme } from "@tui/context/theme"
import { TextAttributes, TextareaRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import * as path from "path"
import * as fs from "fs/promises"
import {
  generateEnterpriseInstructions,
  generateStakeholderDocumentation,
} from "../../../../servicenow/cli/enterprise-docs-generator.js"
import { isRemoteEnvironment } from "@/auth/servicenow-oauth"
import { Clipboard } from "@tui/util/clipboard"
import { tryOpenBrowser } from "@tui/util/browser"

/**
 * Fetch active integrations from enterprise portal
 * Returns list of service types that the user has credentials for
 */
async function fetchActiveIntegrations(portalUrl: string, token: string): Promise<string[]> {
  try {
    const response = await fetch(`${portalUrl}/api/user-credentials`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    })

    if (!response.ok) {
      console.error("[Enterprise] Failed to fetch user credentials:", response.status)
      return []
    }

    const data = await response.json()

    if (!data.success || !Array.isArray(data.credentials)) {
      console.error("[Enterprise] Invalid credentials response")
      return []
    }

    // Extract unique service types from credentials
    const serviceTypes = new Set<string>()
    for (const credential of data.credentials) {
      if (credential.serviceType && typeof credential.serviceType === "string") {
        // Normalize service type (e.g., 'azuredevops' -> 'azure-devops')
        let serviceType = credential.serviceType.toLowerCase()
        if (serviceType === "azuredevops") {
          serviceType = "azure-devops"
        }
        serviceTypes.add(serviceType)
      }
    }

    const activeServices = Array.from(serviceTypes)
    console.error(`[Enterprise] Found active integrations: ${activeServices.join(", ")}`)
    return activeServices
  } catch (error) {
    console.error("[Enterprise] Error fetching active integrations:", error)
    return []
  }
}

/**
 * Update CLAUDE.md and AGENTS.md with enterprise workflow instructions
 * Called after successful enterprise authentication
 */
async function updateDocumentationWithEnterprise(enabledServices?: string[], role?: string): Promise<void> {
  if (!enabledServices || enabledServices.length === 0) {
    return
  }

  const cwd = process.cwd()
  const agentsMdPath = path.join(cwd, "AGENTS.md")

  const enterpriseMarker = "<!-- SNOW-FLOW-ENTERPRISE-START -->"
  const enterpriseEndMarker = "<!-- SNOW-FLOW-ENTERPRISE-END -->"

  // Generate appropriate documentation based on role
  let enterpriseContent: string
  if (role === "stakeholder") {
    enterpriseContent = generateStakeholderDocumentation()
  } else {
    enterpriseContent = generateEnterpriseInstructions(enabledServices)
  }

  const markedContent = `\n${enterpriseMarker}\n${enterpriseContent}\n${enterpriseEndMarker}\n`

  // Update AGENTS.md with enterprise content (create if doesn't exist)
  try {
    let content = ""
    let fileExists = true
    try {
      content = await fs.readFile(agentsMdPath, "utf-8")
    } catch {
      // File doesn't exist, create it with enterprise content
      fileExists = false
      console.error("[Enterprise] AGENTS.md not found, creating new file")
    }

    // If file doesn't exist, create with header
    if (!fileExists) {
      content = `# AGENTS.md - AI Agent Instructions

This file contains instructions for AI agents working in this codebase.
`
    }

    // Check if enterprise section already exists
    const startIdx = content.indexOf(enterpriseMarker)
    const endIdx = content.indexOf(enterpriseEndMarker)

    if (startIdx !== -1 && endIdx !== -1) {
      // Replace existing enterprise section
      content = content.substring(0, startIdx) + markedContent + content.substring(endIdx + enterpriseEndMarker.length)
    } else if (startIdx !== -1) {
      // Marker exists but no end marker, append
      content = content.substring(0, startIdx) + markedContent
    } else {
      // No existing section, append to end
      content = content + markedContent
    }

    await fs.writeFile(agentsMdPath, content, "utf-8")
    console.error(`[Enterprise] ${fileExists ? "Updated" : "Created"} AGENTS.md with enterprise instructions`)
  } catch (err) {
    console.error("[Enterprise] Failed to update AGENTS.md:", err)
  }
}

/**
 * Shared ServiceNow instance type used across auth dialogs
 */
type SnInstance = {
  id: number
  instanceName: string
  instanceUrl: string
  environmentType: string
  isDefault: boolean
  enabled: boolean
}

/**
 * Fetch all enabled ServiceNow instances from the enterprise portal
 */
async function fetchSnInstances(url: string, bearerToken: string): Promise<SnInstance[]> {
  try {
    const response = await fetch(`${url}/api/servicenow/instances`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        Accept: "application/json",
      },
    })
    if (!response.ok) return []
    const data = await response.json()
    if (!data.success || !Array.isArray(data.instances)) return []
    return data.instances.filter((i: any) => i.enabled)
  } catch {
    return []
  }
}

/**
 * Fetch credentials for a specific ServiceNow instance from the enterprise portal
 */
async function fetchSnInstanceById(
  url: string,
  bearerToken: string,
  instanceId: number,
): Promise<{ instanceUrl: string; clientId: string; clientSecret: string } | null> {
  try {
    const response = await fetch(`${url}/api/servicenow/instances/${instanceId}/for-cli`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        Accept: "application/json",
      },
    })
    if (!response.ok) return null
    const data = await response.json()
    if (!data.success || !data.instance) return null
    const inst = data.instance
    if (!inst.instanceUrl || !inst.clientId || !inst.clientSecret) return null
    return {
      instanceUrl: inst.instanceUrl,
      clientId: inst.clientId,
      clientSecret: inst.clientSecret,
    }
  } catch {
    return null
  }
}

/**
 * Save ServiceNow credentials and start MCP server for a given instance
 */
async function connectSnInstance(creds: { instanceUrl: string; clientId: string; clientSecret: string }): Promise<void> {
  const { Auth } = await import("@/auth")
  const { MCP } = await import("@/mcp")
  const { Config } = await import("@/config/config")

  await Auth.set("servicenow", {
    type: "servicenow-oauth",
    instance: creds.instanceUrl,
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
  })

  const savedAuth = await Auth.get("servicenow")
  const accessToken = savedAuth?.type === "servicenow-oauth" ? savedAuth.accessToken : undefined
  const refreshToken = savedAuth?.type === "servicenow-oauth" ? savedAuth.refreshToken : undefined

  await MCP.add("servicenow-unified", {
    type: "local",
    command: Config.getMcpServerCommand("servicenow-unified"),
    environment: {
      SERVICENOW_INSTANCE_URL: creds.instanceUrl,
      SERVICENOW_CLIENT_ID: creds.clientId,
      SERVICENOW_CLIENT_SECRET: creds.clientSecret,
      SNOW_LAZY_TOOLS: "true",
      ...(accessToken && { SERVICENOW_ACCESS_TOKEN: accessToken }),
      ...(refreshToken && { SERVICENOW_REFRESH_TOKEN: refreshToken }),
    },
    enabled: true,
  })
}

type AuthMethod = "servicenow-oauth" | "servicenow-basic" | "enterprise-portal" | "select-sn-instance"

interface AuthCredentials {
  servicenow?: {
    instance: string
    clientId: string
    clientSecret: string
    accessToken?: string
    expiresAt?: number
  }
  servicenowBasic?: {
    instance: string
    username: string
    password: string
  }
  enterprise?: {
    subdomain?: string
    licenseKey?: string
    token?: string
    role?: string
  }
}

/**
 * Main auth dialog - shows available authentication methods
 */
export function DialogAuth() {
  const dialog = useDialog()
  const toast = useToast()
  const [credentials, setCredentials] = createSignal<AuthCredentials>({})

  // Load existing credentials on mount
  onMount(async () => {
    try {
      const { Auth } = await import("@/auth")
      const snAuth = await Auth.get("servicenow")
      if (snAuth?.type === "servicenow-oauth") {
        setCredentials((prev) => ({
          ...prev,
          servicenow: {
            instance: snAuth.instance,
            clientId: snAuth.clientId,
            clientSecret: snAuth.clientSecret,
            accessToken: snAuth.accessToken,
            expiresAt: snAuth.expiresAt,
          },
        }))
      } else if (snAuth?.type === "servicenow-basic") {
        setCredentials((prev) => ({
          ...prev,
          servicenowBasic: {
            instance: snAuth.instance,
            username: snAuth.username,
            password: snAuth.password,
          },
        }))
      }

      const entAuth = await Auth.get("enterprise")
      if (entAuth?.type === "enterprise") {
        setCredentials((prev) => ({
          ...prev,
          enterprise: {
            licenseKey: entAuth.licenseKey,
            token: entAuth.token,
            role: entAuth.role,
          },
        }))
      }
    } catch {
      // Auth module not available
    }
  })

  const isServiceNowConfigured = createMemo(() => {
    const creds = credentials()
    return !!(
      (creds.servicenow?.accessToken && creds.servicenow.expiresAt && creds.servicenow.expiresAt > Date.now()) ||
      (creds.servicenowBasic?.username && creds.servicenowBasic?.password)
    )
  })

  const isEnterpriseConfigured = createMemo(() => {
    const creds = credentials()
    return !!(creds.enterprise?.token || creds.enterprise?.licenseKey)
  })

  const allOptions: DialogSelectOption<AuthMethod>[] = [
    {
      title: "Serac dashboard",
      value: "enterprise-portal",
      description: isEnterpriseConfigured() ? "Connected" : undefined,
      category: "Serac dashboard",
      footer: "Log in — loads your ServiceNow, Jira & other credentials",
      onSelect: () => {
        dialog.replace(() => <DialogAuthEnterprise />)
      },
    },
    {
      title: "Select ServiceNow Instance",
      value: "select-sn-instance",
      description: isServiceNowConfigured() ? "Connected" : undefined,
      category: "Serac dashboard",
      footer: "Switch instance from your dashboard",
      onSelect: () => {
        dialog.replace(() => <DialogAuthSelectInstance />)
      },
    },
    {
      title: "ServiceNow OAuth",
      value: "servicenow-oauth",
      description: isServiceNowConfigured() ? "Connected" : undefined,
      category: "ServiceNow (manual)",
      footer: "OAuth2 + PKCE",
      onSelect: () => {
        dialog.replace(() => <DialogAuthServiceNowOAuth />)
      },
    },
    {
      title: "ServiceNow Basic Auth",
      value: "servicenow-basic",
      description: credentials().servicenowBasic ? "Configured" : undefined,
      category: "ServiceNow (manual)",
      footer: "Username / Password",
      onSelect: () => {
        dialog.replace(() => <DialogAuthServiceNowBasic />)
      },
    },
  ]

  return <DialogSelect title="Serac Authentication" options={allOptions} />
}

/**
 * ServiceNow OAuth dialog - multi-step input for OAuth credentials
 */
function DialogAuthServiceNowOAuth() {
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()

  const [step, setStep] = createSignal<"instance" | "clientId" | "secret" | "authenticating" | "callback-paste">(
    "instance",
  )
  const [instance, setInstance] = createSignal("")
  const [clientId, setClientId] = createSignal("")
  const [clientSecret, setClientSecret] = createSignal("")
  const [headlessAuthUrl, setHeadlessAuthUrl] = createSignal("")
  const [callbackUrl, setCallbackUrl] = createSignal("")

  // Stored for headless token exchange
  let headlessOAuthRef: { oauth: any; redirectUri: string; normalizedInstance: string } | null = null

  let instanceInput: TextareaRenderable
  let clientIdInput: TextareaRenderable
  let secretInput: TextareaRenderable
  let callbackUrlInput: TextareaRenderable

  // Load existing credentials
  onMount(async () => {
    try {
      const { Auth } = await import("@/auth")
      const snAuth = await Auth.get("servicenow")
      if (snAuth?.type === "servicenow-oauth") {
        setInstance(snAuth.instance)
        setClientId(snAuth.clientId)
        setClientSecret(snAuth.clientSecret)
      }
    } catch {
      // Auth module not available
    }
    setTimeout(() => instanceInput?.focus(), 10)
  })

  useKeyboard((evt) => {
    if (evt.name === "escape") {
      const currentStep = step()
      if (currentStep === "instance") {
        dialog.replace(() => <DialogAuth />)
      } else if (currentStep === "clientId") {
        setStep("instance")
        setTimeout(() => instanceInput?.focus(), 10)
      } else if (currentStep === "secret") {
        setStep("clientId")
        setTimeout(() => clientIdInput?.focus(), 10)
      } else if (currentStep === "callback-paste") {
        setStep("secret")
        setTimeout(() => secretInput?.focus(), 10)
      }
    }
    // Keyboard shortcuts for headless auth step
    if (step() === "callback-paste" && headlessAuthUrl()) {
      if (evt.name === "o") {
        tryOpenBrowser(headlessAuthUrl()).then((opened) => {
          toast.show({
            variant: opened ? "success" : "error",
            message: opened ? "Browser opened!" : "Could not open browser",
            duration: 3000,
          })
        })
      }
      if (evt.name === "c") {
        Clipboard.copy(headlessAuthUrl()).then(
          () => toast.show({ variant: "success", message: "URL copied to clipboard!", duration: 3000 }),
          () => toast.show({ variant: "error", message: "Failed to copy", duration: 3000 }),
        )
      }
    }
  })

  const startMcpServerAfterAuth = async () => {
    try {
      const { MCP } = await import("@/mcp")
      const { Config } = await import("@/config/config")
      const { Auth } = await import("@/auth")
      const snAuth = await Auth.get("servicenow")
      if (snAuth?.type === "servicenow-oauth") {
        await MCP.add("servicenow-unified", {
          type: "local",
          command: Config.getMcpServerCommand("servicenow-unified"),
          environment: {
            SERVICENOW_INSTANCE_URL: snAuth.instance,
            SERVICENOW_CLIENT_ID: snAuth.clientId,
            SERVICENOW_CLIENT_SECRET: snAuth.clientSecret ?? "",
            ...(snAuth.accessToken && { SERVICENOW_ACCESS_TOKEN: snAuth.accessToken }),
            ...(snAuth.refreshToken && { SERVICENOW_REFRESH_TOKEN: snAuth.refreshToken }),
          },
          enabled: true,
        })
        toast.show({
          variant: "info",
          message: "ServiceNow connected! MCP server is now active.",
          duration: 5000,
        })
      } else {
        toast.show({
          variant: "info",
          message: "ServiceNow connected! MCP server will be available on next restart.",
          duration: 5000,
        })
      }
    } catch (mcpError) {
      toast.show({
        variant: "info",
        message: "ServiceNow connected! MCP server will be available on next restart.",
        duration: 5000,
      })
    }
  }

  const handleAuthenticate = async () => {
    if (!instance() || !clientId() || !clientSecret()) {
      toast.show({
        variant: "error",
        message: "Please fill in all fields",
      })
      return
    }

    // In headless/remote environments, use the callback URL paste flow
    if (isRemoteEnvironment()) {
      try {
        const { ServiceNowOAuth } = await import("@/auth/servicenow-oauth")
        const oauth = new ServiceNowOAuth()
        const prepared = oauth.prepareHeadlessAuth({
          instance: instance(),
          clientId: clientId(),
          clientSecret: clientSecret(),
        })

        if (prepared.error) {
          toast.show({ variant: "error", message: prepared.error, duration: 5000 })
          return
        }

        headlessOAuthRef = {
          oauth,
          redirectUri: prepared.redirectUri,
          normalizedInstance: prepared.normalizedInstance,
        }
        setHeadlessAuthUrl(prepared.authUrl)
        tryOpenBrowser(prepared.authUrl).then((opened) => {
          if (opened) {
            toast.show({
              variant: "info",
              message: "Browser opened! Authorize and paste the callback URL below.",
              duration: 5000,
            })
          }
        })
        Clipboard.copy(prepared.authUrl).catch(() => {})
        setStep("callback-paste")
        setTimeout(() => callbackUrlInput?.focus(), 10)
      } catch (e) {
        toast.show({
          variant: "error",
          message: e instanceof Error ? e.message : "Failed to prepare auth",
          duration: 5000,
        })
      }
      return
    }

    setStep("authenticating")
    try {
      const { ServiceNowOAuth } = await import("@/auth/servicenow-oauth")
      const oauth = new ServiceNowOAuth()
      const result = await oauth.authenticate({
        instance: instance(),
        clientId: clientId(),
        clientSecret: clientSecret(),
      })

      if (result.success) {
        await startMcpServerAfterAuth()
        dialog.clear()
      } else {
        toast.show({
          variant: "error",
          message: result.error ?? "Authentication failed",
          duration: 5000,
        })
        setStep("secret")
        setTimeout(() => secretInput?.focus(), 10)
      }
    } catch (e) {
      toast.show({
        variant: "error",
        message: e instanceof Error ? e.message : "Authentication failed",
        duration: 5000,
      })
      setStep("secret")
      setTimeout(() => secretInput?.focus(), 10)
    }
  }

  const handleCallbackPaste = async () => {
    const url = callbackUrl().trim()
    if (!url) {
      toast.show({ variant: "error", message: "Please paste the callback URL" })
      return
    }

    if (!url.includes("/callback")) {
      toast.show({ variant: "error", message: "URL must contain '/callback'" })
      return
    }

    if (!headlessOAuthRef) {
      toast.show({ variant: "error", message: "OAuth session expired. Please try again." })
      setStep("secret")
      setTimeout(() => secretInput?.focus(), 10)
      return
    }

    setStep("authenticating")
    try {
      const result = await headlessOAuthRef.oauth.exchangeCallbackUrl(
        url,
        headlessOAuthRef.normalizedInstance,
        clientId(),
        clientSecret(),
        headlessOAuthRef.redirectUri,
      )

      if (result.success) {
        await startMcpServerAfterAuth()
        dialog.clear()
      } else {
        toast.show({
          variant: "error",
          message: result.error ?? "Token exchange failed",
          duration: 5000,
        })
        setStep("callback-paste")
        setTimeout(() => callbackUrlInput?.focus(), 10)
      }
    } catch (e) {
      toast.show({
        variant: "error",
        message: e instanceof Error ? e.message : "Token exchange failed",
        duration: 5000,
      })
      setStep("callback-paste")
      setTimeout(() => callbackUrlInput?.focus(), 10)
    }
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          ServiceNow OAuth
        </text>
        <text fg={theme.textMuted}>esc</text>
      </box>

      <Show when={step() === "instance"}>
        <box gap={1}>
          <text fg={theme.textMuted}>
            Enter your ServiceNow instance URL (e.g., dev12345 or dev12345.service-now.com)
          </text>
          <textarea
            ref={(val: TextareaRenderable) => (instanceInput = val)}
            height={3}
            initialValue={instance()}
            placeholder="dev12345.service-now.com"
            textColor={theme.text}
            focusedTextColor={theme.text}
            cursorColor={theme.text}
            keyBindings={[{ name: "return", action: "submit" }]}
            onSubmit={() => {
              setInstance(instanceInput.plainText)
              setStep("clientId")
              setTimeout(() => clientIdInput?.focus(), 10)
            }}
          />
          <text fg={theme.textMuted}>Press Enter to continue</text>
        </box>
      </Show>

      <Show when={step() === "clientId"}>
        <box gap={1}>
          <text fg={theme.textMuted}>OAuth Client ID from ServiceNow: System OAuth {">"} Application Registry</text>
          <textarea
            ref={(val: TextareaRenderable) => (clientIdInput = val)}
            height={3}
            initialValue={clientId()}
            placeholder="Enter OAuth Client ID"
            textColor={theme.text}
            focusedTextColor={theme.text}
            cursorColor={theme.text}
            keyBindings={[{ name: "return", action: "submit" }]}
            onSubmit={() => {
              setClientId(clientIdInput.plainText)
              setStep("secret")
              setTimeout(() => secretInput?.focus(), 10)
            }}
          />
          <text fg={theme.textMuted}>Instance: {instance()}</text>
          <text fg={theme.textMuted}>Press Enter to continue</text>
        </box>
      </Show>

      <Show when={step() === "secret"}>
        <box gap={1}>
          <text fg={theme.textMuted}>The client secret from your OAuth application</text>
          <textarea
            ref={(val: TextareaRenderable) => (secretInput = val)}
            height={3}
            initialValue={clientSecret()}
            placeholder="Enter OAuth Client Secret"
            textColor={theme.text}
            focusedTextColor={theme.text}
            cursorColor={theme.text}
            keyBindings={[{ name: "return", action: "submit" }]}
            onSubmit={() => {
              setClientSecret(secretInput.plainText)
              handleAuthenticate()
            }}
          />
          <text fg={theme.textMuted}>Instance: {instance()}</text>
          <text fg={theme.textMuted}>Client ID: {clientId()}</text>
          <text fg={theme.textMuted}>Press Enter to authenticate</text>
        </box>
      </Show>

      <Show when={step() === "callback-paste"}>
        <box gap={1}>
          <Show when={headlessAuthUrl()}>
            <text fg={theme.primary} attributes={TextAttributes.BOLD}>
              Remote Environment Detected
            </text>
            <text fg={theme.text}>Open this URL in your browser to authenticate:</text>
            <text fg={theme.primary}>{headlessAuthUrl()}</text>
            <box flexDirection="row" gap={2} paddingTop={1}>
              <box
                paddingLeft={2}
                paddingRight={2}
                backgroundColor={theme.primary}
                onMouseUp={() => {
                  tryOpenBrowser(headlessAuthUrl()).then((opened) => {
                    toast.show({
                      variant: opened ? "success" : "error",
                      message: opened ? "Browser opened!" : "Could not open browser",
                      duration: 3000,
                    })
                  })
                }}
              >
                <text fg={theme.selectedListItemText} attributes={TextAttributes.BOLD}>
                  [ Open in Browser ]
                </text>
              </box>
              <box
                paddingLeft={2}
                paddingRight={2}
                backgroundColor={theme.backgroundElement}
                onMouseUp={() => {
                  Clipboard.copy(headlessAuthUrl()).then(
                    () => toast.show({ variant: "success", message: "URL copied!", duration: 3000 }),
                    () => toast.show({ variant: "error", message: "Failed to copy", duration: 3000 }),
                  )
                }}
              >
                <text fg={theme.text} attributes={TextAttributes.BOLD}>
                  [ Copy URL ]
                </text>
              </box>
            </box>
            <box paddingTop={1}>
              <text fg={theme.textMuted}>After clicking "Allow" in ServiceNow:</text>
              <text fg={theme.textMuted}> 1. Your browser will redirect to a localhost URL</text>
              <text fg={theme.textMuted}> 2. The page may show an error (this is expected)</text>
              <text fg={theme.textMuted}> 3. Copy the FULL URL from your browser address bar</text>
            </box>
            <box flexDirection="row" gap={1}>
              <text fg={theme.text}>o</text>
              <text fg={theme.textMuted}>open</text>
              <text fg={theme.text}> c</text>
              <text fg={theme.textMuted}>copy</text>
              <text fg={theme.text}> esc</text>
              <text fg={theme.textMuted}>back</text>
            </box>
          </Show>
          <text fg={theme.text}>Paste the callback URL from your browser address bar:</text>
          <textarea
            ref={(val: TextareaRenderable) => (callbackUrlInput = val)}
            height={3}
            initialValue={callbackUrl()}
            placeholder="http://localhost:3005/callback?code=...&state=..."
            textColor={theme.text}
            focusedTextColor={theme.text}
            cursorColor={theme.text}
            keyBindings={[{ name: "return", action: "submit" }]}
            onSubmit={() => {
              setCallbackUrl(callbackUrlInput.plainText)
              handleCallbackPaste()
            }}
          />
          <text fg={theme.textMuted}>Instance: {instance()}</text>
          <text fg={theme.textMuted}>Press Enter to exchange tokens</text>
        </box>
      </Show>

      <Show when={step() === "authenticating"}>
        <box gap={1}>
          <text fg={theme.primary} attributes={TextAttributes.BOLD}>
            Authenticating...
          </text>
          <text fg={theme.textMuted}>Please complete the OAuth flow in your browser</text>
        </box>
      </Show>
    </box>
  )
}

/**
 * ServiceNow Basic Auth dialog
 */
function DialogAuthServiceNowBasic() {
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()

  const [step, setStep] = createSignal<"instance" | "username" | "password">("instance")
  const [instance, setInstance] = createSignal("")
  const [username, setUsername] = createSignal("")
  const [password, setPassword] = createSignal("")

  let instanceInput: TextareaRenderable
  let usernameInput: TextareaRenderable
  let passwordInput: TextareaRenderable

  // Load existing credentials
  onMount(async () => {
    try {
      const { Auth } = await import("@/auth")
      const snAuth = await Auth.get("servicenow")
      if (snAuth?.type === "servicenow-basic") {
        setInstance(snAuth.instance)
        setUsername(snAuth.username)
      }
    } catch {
      // Auth module not available
    }
    setTimeout(() => instanceInput?.focus(), 10)
  })

  useKeyboard((evt) => {
    if (evt.name === "escape") {
      const currentStep = step()
      if (currentStep === "instance") {
        dialog.replace(() => <DialogAuth />)
      } else if (currentStep === "username") {
        setStep("instance")
        setTimeout(() => instanceInput?.focus(), 10)
      } else if (currentStep === "password") {
        setStep("username")
        setTimeout(() => usernameInput?.focus(), 10)
      }
    }
  })

  const handleSave = async () => {
    if (!instance() || !username() || !password()) {
      toast.show({
        variant: "error",
        message: "Please fill in all fields",
      })
      return
    }

    try {
      const { Auth } = await import("@/auth")

      // Normalize instance URL
      let normalizedInstance = instance().replace(/\/+$/, "")
      if (!normalizedInstance.startsWith("http://") && !normalizedInstance.startsWith("https://")) {
        normalizedInstance = `https://${normalizedInstance}`
      }
      try {
        const host = new URL(normalizedInstance).hostname
        if (!host.endsWith(".service-now.com") && host !== "localhost") {
          normalizedInstance = `https://${instance().replace(/\/+$/, "")}.service-now.com`
        }
      } catch {
        normalizedInstance = `https://${instance().replace(/\/+$/, "")}.service-now.com`
      }

      await Auth.set("servicenow", {
        type: "servicenow-basic",
        instance: normalizedInstance,
        username: username(),
        password: password(),
      })

      // Add ServiceNow MCP server directly (no restart needed)
      try {
        const { MCP } = await import("@/mcp")
        const { Config } = await import("@/config/config")
        await MCP.add("servicenow-unified", {
          type: "local",
          command: Config.getMcpServerCommand("servicenow-unified"),
          environment: {
            SERVICENOW_INSTANCE_URL: normalizedInstance,
            SERVICENOW_USERNAME: username(),
            SERVICENOW_PASSWORD: password(),
          },
          enabled: true,
        })
        toast.show({
          variant: "info",
          message: "ServiceNow connected! MCP server is now active.",
          duration: 3000,
        })
      } catch (mcpError) {
        toast.show({
          variant: "info",
          message: "ServiceNow credentials saved! MCP server will be available on next restart.",
          duration: 3000,
        })
      }
      dialog.clear()
    } catch (e) {
      toast.show({
        variant: "error",
        message: e instanceof Error ? e.message : "Failed to save credentials",
        duration: 5000,
      })
    }
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          ServiceNow Basic Auth
        </text>
        <text fg={theme.textMuted}>esc</text>
      </box>

      <Show when={step() === "instance"}>
        <box gap={1}>
          <text fg={theme.textMuted}>Enter your ServiceNow instance URL</text>
          <textarea
            ref={(val: TextareaRenderable) => (instanceInput = val)}
            height={3}
            initialValue={instance()}
            placeholder="dev12345.service-now.com"
            textColor={theme.text}
            focusedTextColor={theme.text}
            cursorColor={theme.text}
            keyBindings={[{ name: "return", action: "submit" }]}
            onSubmit={() => {
              setInstance(instanceInput.plainText)
              setStep("username")
              setTimeout(() => usernameInput?.focus(), 10)
            }}
          />
          <text fg={theme.textMuted}>Press Enter to continue</text>
        </box>
      </Show>

      <Show when={step() === "username"}>
        <box gap={1}>
          <text fg={theme.textMuted}>ServiceNow username</text>
          <textarea
            ref={(val: TextareaRenderable) => (usernameInput = val)}
            height={3}
            initialValue={username()}
            placeholder="admin"
            textColor={theme.text}
            focusedTextColor={theme.text}
            cursorColor={theme.text}
            keyBindings={[{ name: "return", action: "submit" }]}
            onSubmit={() => {
              setUsername(usernameInput.plainText)
              setStep("password")
              setTimeout(() => passwordInput?.focus(), 10)
            }}
          />
          <text fg={theme.textMuted}>Instance: {instance()}</text>
          <text fg={theme.textMuted}>Press Enter to continue</text>
        </box>
      </Show>

      <Show when={step() === "password"}>
        <box gap={1}>
          <text fg={theme.textMuted}>ServiceNow password</text>
          <textarea
            ref={(val: TextareaRenderable) => (passwordInput = val)}
            height={3}
            initialValue={password()}
            placeholder="Enter password"
            textColor={theme.text}
            focusedTextColor={theme.text}
            cursorColor={theme.text}
            keyBindings={[{ name: "return", action: "submit" }]}
            onSubmit={() => {
              setPassword(passwordInput.plainText)
              handleSave()
            }}
          />
          <text fg={theme.textMuted}>Instance: {instance()}</text>
          <text fg={theme.textMuted}>Username: {username()}</text>
          <text fg={theme.textMuted}>Press Enter to save</text>
        </box>
      </Show>
    </box>
  )
}

/**
 * Enterprise Portal dialog with browser-based device authorization flow
 */
function DialogAuthEnterprise() {
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()

  const [step, setStep] = createSignal<"starting" | "code" | "verifying" | "sn-choice" | "select-sn-instance">(
    "starting",
  )
  const [sessionId, setSessionId] = createSignal("")
  const [authCode, setAuthCode] = createSignal("")
  const [verificationUrl, setVerificationUrl] = createSignal("")
  const [portalUrl, setPortalUrl] = createSignal("")
  const [snInstances, setSnInstances] = createSignal<SnInstance[]>([])
  const [entToken, setEntToken] = createSignal("")
  const [deviceError, setDeviceError] = createSignal("")

  const PORTAL_URL = "https://dashboard.serac.build"

  let codeInput: TextareaRenderable

  // Single managed dashboard — start device authorization immediately.
  onMount(() => {
    startDeviceAuth()
  })

  useKeyboard((evt) => {
    if (evt.name === "escape") {
      const currentStep = step()
      if (currentStep === "starting" || currentStep === "code" || currentStep === "verifying") {
        dialog.replace(() => <DialogAuth />)
      } else if (currentStep === "sn-choice" || currentStep === "select-sn-instance") {
        // Dashboard auth is already saved, just close dialog
        dialog.clear()
      }
    }

    // Retry the device request if it failed
    if (step() === "starting" && deviceError() && evt.name === "r") {
      setDeviceError("")
      startDeviceAuth()
    }

    // Handle 1/2/3 keypresses for ServiceNow choice
    if (step() === "sn-choice") {
      if (evt.name === "1") {
        tryOpenBrowser(`${portalUrl()}/portal/integrations/servicenow`)
        toast.show({ variant: "info", message: "Opening portal settings in browser...", duration: 3000 })
        dialog.clear()
      } else if (evt.name === "2") {
        dialog.replace(() => <DialogAuthServiceNowOAuth />)
      } else if (evt.name === "3") {
        dialog.replace(() => <DialogAuthServiceNowBasic />)
      }
    }
  })

  const startDeviceAuth = async () => {
    setStep("starting")
    setDeviceError("")
    const portalUrl = PORTAL_URL

    try {
      // Get machine info
      const os = await import("os")
      const machineInfo = `${os.hostname()} (${os.platform()} ${os.arch()})`

      // Request device session
      const response = await fetch(`${portalUrl}/api/auth/device/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ machineInfo }),
      })

      if (!response.ok) {
        const err = await response.json().catch(() => ({}))
        throw new Error(err.error || "Failed to start device authorization")
      }

      const data = await response.json()
      setSessionId(data.sessionId)

      // Open browser with verification URL (works in Codespaces via xdg-open)
      const url = data.verificationUrl
      setVerificationUrl(url)
      tryOpenBrowser(url).then((opened) => {
        if (opened) {
          toast.show({ variant: "info", message: "Browser opened for verification", duration: 3000 })
        }
      })
      Clipboard.copy(url).catch(() => {})

      setStep("code")
      setTimeout(() => codeInput?.focus(), 10)
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to reach your Serac dashboard"
      setDeviceError(msg)
      toast.show({ variant: "error", message: msg, duration: 5000 })
    }
  }

  const verifyAuthCode = async () => {
    const code = authCode().trim().toUpperCase()
    if (!code) {
      toast.show({ variant: "error", message: "Please enter the authorization code" })
      return
    }

    setStep("verifying")
    const resolvedPortalUrl = PORTAL_URL

    try {
      // Retry up to 5 times with 2s delay — handles race condition where
      // the user submits the code before browser approval completes
      const maxAttempts = 5
      let data: any = null

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const response = await fetch(`${resolvedPortalUrl}/api/auth/device/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: sessionId(),
            authCode: code,
          }),
        })

        const responseData = await response.json().catch(() => ({}))

        // 202 = pending approval, or explicit pending status
        const isPending = response.status === 202 || responseData.status === "pending" || responseData.error === "pending"
        if (isPending && attempt < maxAttempts) {
          toast.show({ variant: "info", message: `Waiting for browser approval... (${attempt}/${maxAttempts})`, duration: 2000 })
          await new Promise(r => setTimeout(r, 2000))
          continue
        }

        if (response.ok && !isPending) {
          data = responseData
          break
        }

        // Billing redirect — not retryable
        if (responseData.billingUrl) {
          toast.show({ variant: "error", message: responseData.message || responseData.error || "Subscription required", duration: 8000 })
          toast.show({ variant: "info", message: "Opening billing page...", duration: 4000 })
          tryOpenBrowser(responseData.billingUrl)
          setStep("code")
          return
        }

        if (isPending) {
          throw new Error("Verification timed out — please approve in your browser and try again")
        }

        throw new Error(responseData.error || "Verification failed")
      }

      if (!data) {
        throw new Error("Verification timed out — please approve in your browser and try again")
      }

      // Save to Auth store
      const { Auth } = await import("@/auth")
      await Auth.set("enterprise", {
        type: "enterprise",
        token: data.token,
        enterpriseUrl: resolvedPortalUrl,
        username: data.user?.username || data.user?.email,
        email: data.user?.email,
        role: data.user?.role,
        features: data.features || [],
        subscriptionStatus: data.subscription?.status,
        trialEndsAt: data.subscription?.trialEndsAt,
      })

      // Also save to ~/.snow-code/enterprise.json for the enterprise proxy
      // This is the primary token source used by the MCP server
      try {
        const os = await import("os")
        const enterpriseJsonDir = path.join(os.homedir(), ".snow-code")
        const enterpriseJsonPath = path.join(enterpriseJsonDir, "enterprise.json")
        await fs.mkdir(enterpriseJsonDir, { recursive: true })
        await fs.writeFile(
          enterpriseJsonPath,
          JSON.stringify(
            {
              subdomain: "dashboard",
              token: data.token,
            },
            null,
            2,
          ),
          "utf-8",
        )
        console.error("[Enterprise] Saved JWT token to ~/.snow-code/enterprise.json")
      } catch (saveErr) {
        console.error("[Enterprise] Could not save enterprise.json:", saveErr)
      }

      // Store portalUrl in state for use in sn-choice step
      setPortalUrl(resolvedPortalUrl)

      // Add enterprise MCP server directly (no restart needed)
      try {
        const { MCP } = await import("@/mcp")
        const { Config } = await import("@/config/config")
        await MCP.add("serac-enterprise", {
          type: "local",
          command: Config.getMcpServerCommand("enterprise-proxy"),
          environment: {
            SNOW_PORTAL_URL: resolvedPortalUrl,
            SNOW_LICENSE_KEY: data.token,
          },
          enabled: true,
        })

        // Fetch all ServiceNow instances from the portal and let user choose if multiple
        let serviceNowStarted = false
        let portalInstanceName = ""
        setEntToken(data.token)
        try {
          const allInstances = await fetchSnInstances(resolvedPortalUrl, data.token)

          if (allInstances.length >= 1) {
            // Show instance selection — always let user see and confirm
            const userName = data.user?.username || data.user?.email || "Enterprise"
            toast.show({
              variant: "info",
              message: `Connected as ${userName}! Select a ServiceNow instance.`,
              duration: 3000,
            })
            setSnInstances(allInstances)
            setStep("select-sn-instance")
          }

          // If portal had no instances, try local auth store as fallback
          if (!serviceNowStarted && allInstances.length === 0) {
            const snAuth = await Auth.get("servicenow")
            if (snAuth?.type === "servicenow-oauth" || snAuth?.type === "servicenow-basic") {
              const snEnv: Record<string, string> = {
                SERVICENOW_INSTANCE_URL: snAuth.instance,
              }
              if (snAuth.type === "servicenow-oauth") {
                snEnv.SERVICENOW_CLIENT_ID = snAuth.clientId
                snEnv.SERVICENOW_CLIENT_SECRET = snAuth.clientSecret ?? ""
                if (snAuth.accessToken) snEnv.SERVICENOW_ACCESS_TOKEN = snAuth.accessToken
                if (snAuth.refreshToken) snEnv.SERVICENOW_REFRESH_TOKEN = snAuth.refreshToken
              } else {
                snEnv.SERVICENOW_USERNAME = snAuth.username
                snEnv.SERVICENOW_PASSWORD = snAuth.password ?? ""
              }
              await MCP.add("servicenow-unified", {
                type: "local",
                command: Config.getMcpServerCommand("servicenow-unified"),
                environment: snEnv,
                enabled: true,
              })
              serviceNowStarted = true
            }
          }
        } catch {
          // ServiceNow credentials not available from portal or local, skip
        }

        // Don't show additional toasts if we're in the instance selection step
        if (step() === "select-sn-instance") {
          // User is choosing — skip to doc update
        } else if (serviceNowStarted) {
          const userName = data.user?.username || data.user?.email || "Enterprise"
          const snMsg = portalInstanceName
            ? `Using ServiceNow instance '${portalInstanceName}' from your portal account.`
            : "Enterprise + ServiceNow MCP servers are now active."
          toast.show({
            variant: "info",
            message: `Connected as ${userName}! ${snMsg}`,
            duration: 5000,
          })
        } else {
          // No ServiceNow credentials found — will show choice menu after doc update
          const userName = data.user?.username || data.user?.email || "Enterprise"
          toast.show({
            variant: "info",
            message: `Connected as ${userName}! Enterprise MCP server is now active.`,
            duration: 3000,
          })
          setStep("sn-choice")
        }
      } catch (mcpError) {
        // MCP add failed, but auth succeeded - user can restart
        const userName = data.user?.username || data.user?.email || data.customer?.name || "Enterprise"
        toast.show({
          variant: "info",
          message: `Connected as ${userName}! MCP server will be available on next restart.`,
          duration: 5000,
        })
      }

      // Update documentation with enterprise instructions (only for active integrations)
      try {
        const activeFeatures = await fetchActiveIntegrations(resolvedPortalUrl, data.token)
        const userRole = data.user?.role || "developer"
        await updateDocumentationWithEnterprise(activeFeatures, userRole)
      } catch (docError) {
        console.error("[Enterprise] Failed to update documentation:", docError)
      }

      // Show trial/subscription status toast
      try {
        const subStatus = data.subscription?.status
        const trialEnd = data.subscription?.trialEndsAt
        const featureCount = (data.features || []).length

        if (subStatus === "trialing" && trialEnd) {
          const daysLeft = Math.max(0, Math.ceil((trialEnd - Date.now()) / (24 * 60 * 60 * 1000)))
          if (daysLeft <= 0) {
            toast.show({
              variant: "error",
              message: "Trial ended — visit dashboard.serac.build/portal/billing to activate features",
              duration: 8000,
            })
          } else if (daysLeft <= 3) {
            toast.show({
              variant: "warning",
              message: `Trial ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"} — all features enabled`,
              duration: 6000,
            })
          } else {
            toast.show({
              variant: "info",
              message: `Trial active — all features enabled (${daysLeft} days remaining)`,
              duration: 4000,
            })
          }
        } else if (subStatus === "past_due") {
          toast.show({
            variant: "error",
            message: "Trial ended — visit dashboard.serac.build/portal/billing to activate features",
            duration: 8000,
          })
        } else if (subStatus === "active" && featureCount > 0) {
          toast.show({
            variant: "info",
            message: `Enterprise connected — ${featureCount} feature${featureCount === 1 ? "" : "s"} enabled`,
            duration: 4000,
          })
        }
      } catch {
        // Non-critical, skip toast on error
      }

      // If no ServiceNow credentials found, show choice menu instead of closing
      if (step() === "sn-choice") return

      dialog.clear()
    } catch (e) {
      toast.show({ variant: "error", message: e instanceof Error ? e.message : "Verification failed" })
      setStep("code")
      setTimeout(() => codeInput?.focus(), 10)
    }
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Serac dashboard
        </text>
        <text fg={theme.textMuted}>esc</text>
      </box>

      <Show when={step() === "starting"}>
        <box gap={1}>
          <Show when={!deviceError()}>
            <text fg={theme.primary} attributes={TextAttributes.BOLD}>
              Connecting to your Serac dashboard…
            </text>
            <text fg={theme.textMuted}>
              Opening dashboard.serac.build to authorize this device. Your ServiceNow, Jira and other credentials
              are loaded from your dashboard account.
            </text>
          </Show>
          <Show when={deviceError()}>
            <text fg={theme.warning} attributes={TextAttributes.BOLD}>
              Could not reach your Serac dashboard
            </text>
            <text fg={theme.textMuted}>{deviceError()}</text>
            <box paddingTop={1} flexDirection="row">
              <text fg={theme.text}>r </text>
              <text fg={theme.textMuted}>retry</text>
              <text fg={theme.text}> esc </text>
              <text fg={theme.textMuted}>back</text>
            </box>
          </Show>
        </box>
      </Show>

      <Show when={step() === "code"}>
        <box gap={1}>
          <Show when={verificationUrl()}>
            <text fg={theme.primary} attributes={TextAttributes.BOLD}>
              Verify in your browser
            </text>
            <text fg={theme.text}>Open this URL to authorize this device:</text>
            <text fg={theme.primary}>{verificationUrl()}</text>
            <box paddingTop={1}>
              <text fg={theme.text}>After logging in on the portal:</text>
              <text fg={theme.textMuted}> 1. Click "Approve" to authorize this device</text>
              <text fg={theme.textMuted}> 2. Copy the authorization code shown</text>
              <text fg={theme.textMuted}> 3. Paste it below and press Enter</text>
            </box>
          </Show>
          <text fg={theme.textMuted}>Enter the authorization code from the portal</text>
          <textarea
            ref={(val: TextareaRenderable) => (codeInput = val)}
            height={3}
            initialValue={authCode()}
            placeholder="ABC-DEF-12"
            textColor={theme.text}
            focusedTextColor={theme.text}
            cursorColor={theme.text}
            keyBindings={[{ name: "return", action: "submit" }]}
            onSubmit={() => {
              setAuthCode(codeInput.plainText)
              verifyAuthCode()
            }}
          />
          <text fg={theme.textMuted}>Dashboard: dashboard.serac.build</text>
          <box paddingTop={1} flexDirection="row">
            <text fg={theme.text}>enter </text>
            <text fg={theme.textMuted}>verify</text>
          </box>
        </box>
      </Show>

      <Show when={step() === "verifying"}>
        <box gap={1}>
          <text fg={theme.primary} attributes={TextAttributes.BOLD}>
            Verifying...
          </text>
          <text fg={theme.textMuted}>Validating authorization code with dashboard.serac.build</text>
        </box>
      </Show>

      <Show when={step() === "sn-choice"}>
        <box gap={1}>
          <text fg={theme.success}>✓ Enterprise connected!</text>
          <box paddingTop={1}>
            <text fg={theme.textMuted}>ServiceNow not configured in your portal account.</text>
          </box>
          <box paddingTop={1} gap={1}>
            <box
              flexDirection="row"
              gap={2}
              borderStyle="single"
              borderColor={theme.border}
              paddingLeft={1}
              paddingRight={1}
            >
              <text fg={theme.text}>[1] Configure in portal</text>
              <text fg={theme.textMuted}>- Opens portal settings in browser</text>
            </box>
            <box
              flexDirection="row"
              gap={2}
              borderStyle="single"
              borderColor={theme.border}
              paddingLeft={1}
              paddingRight={1}
            >
              <text fg={theme.text}>[2] Set up locally — OAuth</text>
              <text fg={theme.textMuted}>- OAuth2 + PKCE</text>
            </box>
            <box
              flexDirection="row"
              gap={2}
              borderStyle="single"
              borderColor={theme.border}
              paddingLeft={1}
              paddingRight={1}
            >
              <text fg={theme.text}>[3] Set up locally — Basic Auth</text>
              <text fg={theme.textMuted}>- Username/Password</text>
            </box>
          </box>
          <box paddingTop={1} flexDirection="row">
            <text fg={theme.text}>1 </text>
            <text fg={theme.textMuted}>portal</text>
            <text fg={theme.text}> 2 </text>
            <text fg={theme.textMuted}>OAuth</text>
            <text fg={theme.text}> 3 </text>
            <text fg={theme.textMuted}>Basic</text>
            <text fg={theme.text}> esc </text>
            <text fg={theme.textMuted}>skip</text>
          </box>
        </box>
      </Show>

      <Show when={step() === "select-sn-instance"}>
        <DialogSelect
          title="Select ServiceNow Instance"
          options={snInstances().map((inst) => ({
            title: inst.instanceName,
            value: String(inst.id),
            description: inst.instanceUrl,
            footer: inst.environmentType + (inst.isDefault ? " (default)" : ""),
            category: "ServiceNow Instances",
            onSelect: async () => {
              const creds = await fetchSnInstanceById(portalUrl(), entToken(), inst.id)
              if (creds) {
                try {
                  await connectSnInstance(creds)
                  toast.show({
                    variant: "info",
                    message: `Connected to ${inst.instanceName} (${inst.instanceUrl}). MCP server is now active.`,
                    duration: 5000,
                  })
                  dialog.clear()
                } catch {
                  toast.show({
                    variant: "info",
                    message: `Credentials saved for ${inst.instanceName} (${inst.instanceUrl}). MCP server will be available on next restart.`,
                    duration: 5000,
                  })
                  dialog.clear()
                }
              } else {
                toast.show({ variant: "error", message: `Failed to fetch credentials for ${inst.instanceName}.`, duration: 5000 })
              }
            },
          }))}
        />
      </Show>
    </box>
  )
}

/**
 * Standalone "Select ServiceNow Instance" dialog
 * For users already authenticated with enterprise portal who want to switch SN instance
 */
export function DialogAuthSelectInstance() {
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()

  type SelectStep = "loading" | "not-enterprise" | "select-instance" | "connecting"

  const [step, setStep] = createSignal<SelectStep>("loading")
  const [instances, setInstances] = createSignal<SnInstance[]>([])
  const [portalUrl, setPortalUrl] = createSignal("")
  const [token, setToken] = createSignal("")

  const connectInstance = async (creds: { instanceUrl: string; clientId: string; clientSecret: string }) => {
    setStep("connecting")
    try {
      await connectSnInstance(creds)
      toast.show({
        variant: "info",
        message: `ServiceNow connected to ${creds.instanceUrl}! MCP server is now active.`,
        duration: 5000,
      })
      dialog.clear()
    } catch {
      toast.show({
        variant: "info",
        message: `Credentials saved for ${creds.instanceUrl}. MCP server will be available on next restart.`,
        duration: 5000,
      })
      dialog.clear()
    }
  }

  onMount(async () => {
    try {
      const { Auth } = await import("@/auth")
      const entAuth = await Auth.get("enterprise")
      if (!entAuth?.type || entAuth.type !== "enterprise" || !entAuth.token || !entAuth.enterpriseUrl) {
        setStep("not-enterprise")
        return
      }

      setPortalUrl(entAuth.enterpriseUrl)
      setToken(entAuth.token)

      const result = await fetchSnInstances(entAuth.enterpriseUrl, entAuth.token)

      if (result.length === 0) {
        toast.show({ variant: "error", message: "No ServiceNow instances found on enterprise portal.", duration: 5000 })
        dialog.replace(() => <DialogAuth />)
        return
      }

      setInstances(result)
      setStep("select-instance")
    } catch {
      toast.show({ variant: "error", message: "Failed to load enterprise credentials.", duration: 5000 })
      dialog.replace(() => <DialogAuth />)
    }
  })

  useKeyboard((evt) => {
    if (evt.name === "escape") {
      dialog.replace(() => <DialogAuth />)
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <Show when={step() === "not-enterprise"}>
        <box gap={1}>
          <box flexDirection="row" justifyContent="space-between">
            <text attributes={TextAttributes.BOLD} fg={theme.text}>
              Select ServiceNow Instance
            </text>
            <text fg={theme.textMuted}>esc</text>
          </box>
          <text fg={theme.warning} attributes={TextAttributes.BOLD}>
            Enterprise feature
          </text>
          <text fg={theme.textMuted}>This feature requires an active Enterprise Portal connection.</text>
          <text fg={theme.textMuted}>Please authenticate via "Serac dashboard" first.</text>
          <box paddingTop={1} flexDirection="row">
            <text fg={theme.text}>esc </text>
            <text fg={theme.textMuted}>back</text>
          </box>
        </box>
      </Show>

      <Show when={step() === "loading"}>
        <box gap={1}>
          <text fg={theme.primary} attributes={TextAttributes.BOLD}>
            Loading ServiceNow instances...
          </text>
          <text fg={theme.textMuted}>Fetching instances from enterprise portal</text>
        </box>
      </Show>

      <Show when={step() === "select-instance"}>
        <DialogSelect
          title="Select ServiceNow Instance"
          options={instances().map((inst) => ({
            title: inst.instanceName,
            value: String(inst.id),
            description: inst.instanceUrl,
            footer: inst.environmentType + (inst.isDefault ? " (default)" : ""),
            category: "ServiceNow Instances",
            onSelect: async () => {
              const creds = await fetchSnInstanceById(portalUrl(), token(), inst.id)
              if (creds) {
                await connectInstance(creds)
              } else {
                toast.show({ variant: "error", message: "Failed to fetch instance credentials.", duration: 5000 })
              }
            },
          }))}
        />
      </Show>

      <Show when={step() === "connecting"}>
        <box gap={1}>
          <text fg={theme.primary} attributes={TextAttributes.BOLD}>
            Connecting to ServiceNow...
          </text>
          <text fg={theme.textMuted}>Setting up credentials and starting MCP server</text>
        </box>
      </Show>
    </box>
  )
}
