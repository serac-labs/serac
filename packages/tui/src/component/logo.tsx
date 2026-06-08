import { TextAttributes } from "@opentui/core"
import { createMemo, For, Show, type JSX } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../context/theme"

// Serac wordmark — ported from the previous fork (which replaced opencode's
// animated wordmark with this static block logo). The rebaseline keeps the
// Serac brand here; props are accepted but ignored for drop-in compatibility
// with the upstream Logo signature.
const LOGO_SERAC = [
  "███████╗███████╗██████╗  █████╗  ██████╗",
  "██╔════╝██╔════╝██╔══██╗██╔══██╗██╔════╝",
  "███████╗█████╗  ██████╔╝███████║██║     ",
  "╚════██║██╔══╝  ██╔══██╗██╔══██║██║     ",
  "███████║███████╗██║  ██║██║  ██║╚██████╗",
  "╚══════╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝",
]

export function Logo(_props: { shape?: unknown; ink?: unknown; idle?: boolean } = {}): JSX.Element {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  // Block logo is 40 chars wide. Below that, drop to a plain wordmark so the
  // layout doesn't wrap mid-glyph on narrow terminals.
  const compact = createMemo(() => dimensions().width < 40)

  return (
    <Show
      when={compact()}
      fallback={
        <box>
          <For each={LOGO_SERAC}>
            {(line) => (
              <box>
                <text fg={theme.primary} attributes={TextAttributes.BOLD} selectable={false}>
                  {line}
                </text>
              </box>
            )}
          </For>
        </box>
      }
    >
      <box>
        <text fg={theme.primary} attributes={TextAttributes.BOLD} selectable={false}>
          serac
        </text>
      </box>
    </Show>
  )
}

export function GoLogo(): JSX.Element {
  return <Logo />
}
