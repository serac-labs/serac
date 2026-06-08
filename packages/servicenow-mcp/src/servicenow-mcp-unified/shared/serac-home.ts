import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

/**
 * Resolve a path under the Serac per-user config dir (`~/.serac`).
 *
 * Backward compatibility: before the Serac rebrand this data lived in
 * `~/.snow-flow`. If the new location does not exist yet but the legacy one
 * does, we keep using the legacy path so existing installs don't lose their
 * stored auth/tokens. New installs (and anyone who has already migrated) use
 * `~/.serac`.
 */
export function seracHomePath(...segments: string[]): string {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir()
  const current = path.join(home, ".serac", ...segments)
  const legacy = path.join(home, ".snow-flow", ...segments)
  return !fs.existsSync(current) && fs.existsSync(legacy) ? legacy : current
}

/**
 * Resolve the project-local Serac memory dir (`<cwd>/.serac/memory`), falling
 * back to the legacy `<cwd>/.snow-flow/memory` when only that exists. An
 * explicit `SERAC_MEMORY_PATH` (or legacy `SNOW_MEMORY_PATH`) env var wins.
 */
export function seracMemoryPath(): string {
  const override = process.env.SERAC_MEMORY_PATH || process.env.SNOW_MEMORY_PATH
  if (override) return override
  const current = path.join(process.cwd(), ".serac", "memory")
  const legacy = path.join(process.cwd(), ".snow-flow", "memory")
  return !fs.existsSync(current) && fs.existsSync(legacy) ? legacy : current
}
