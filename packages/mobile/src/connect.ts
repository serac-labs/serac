import { Preferences } from "@capacitor/preferences"

const STORAGE_KEY = "snow-flow-server"

interface ServerConfig {
  url: string
  password?: string
}

export async function loadSavedConfig(): Promise<ServerConfig | null> {
  const { value } = await Preferences.get({ key: STORAGE_KEY })
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

export async function saveConfig(config: ServerConfig): Promise<void> {
  await Preferences.set({ key: STORAGE_KEY, value: JSON.stringify(config) })
}

export async function clearConfig(): Promise<void> {
  await Preferences.remove({ key: STORAGE_KEY })
}

function normalizeUrl(input: string): string {
  let url = input.trim()
  if (!url) return ""

  // Strip trailing slashes
  url = url.replace(/\/+$/, "")

  // Add protocol if missing
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = url.includes("localhost") || url.includes("127.0.0.1") ? `http://${url}` : `https://${url}`
  }

  return url
}

export function buildWsUrl(serverUrl: string): string {
  const normalized = normalizeUrl(serverUrl)
  const url = new URL(normalized)
  const protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return `${protocol}//${url.host}/tui-ws/ws`
}

export async function healthCheck(serverUrl: string): Promise<boolean> {
  const normalized = normalizeUrl(serverUrl)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetch(`${normalized}/global/health`, { signal: controller.signal })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

export function setupConnectScreen(onConnect: (wsUrl: string) => void): void {
  const urlInput = document.getElementById("server-url") as HTMLInputElement
  const passwordInput = document.getElementById("server-password") as HTMLInputElement
  const connectBtn = document.getElementById("connect-btn") as HTMLButtonElement
  const status = document.getElementById("connect-status") as HTMLParagraphElement

  loadSavedConfig().then((config) => {
    if (config) {
      urlInput.value = config.url
      if (config.password) passwordInput.value = config.password
    }
  })

  async function connect() {
    const serverUrl = urlInput.value || "tui.serac.build"
    connectBtn.disabled = true
    status.className = "status"
    status.textContent = "Connecting..."

    const healthy = await healthCheck(serverUrl)
    if (!healthy) {
      status.className = "status error"
      status.textContent = "Could not reach server. Check the URL and try again."
      connectBtn.disabled = false
      return
    }

    await saveConfig({ url: serverUrl, password: passwordInput.value || undefined })

    status.className = "status success"
    status.textContent = "Connected!"

    const wsUrl = buildWsUrl(serverUrl)
    onConnect(wsUrl)
  }

  connectBtn.addEventListener("click", connect)
  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") connect()
  })
  passwordInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") connect()
  })
}
