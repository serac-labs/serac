import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Absolute path to the directory that holds the skill directories.
 *
 * Kept separate from `./index.ts` so a consumer that just wants the path does
 * not drag in the embedded string map.
 */
export const skillsRoot = (): string => join(dirname(fileURLToPath(import.meta.url)), "..")
