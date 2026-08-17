/**
 * `@serac-labs/skills` — the bundled ServiceNow skill guides.
 *
 * The skills themselves are plain markdown, one directory per skill, each with
 * a `SKILL.md`. There are two ways to consume them:
 *
 *   - **As files.** `skillsRoot()` returns the directory holding the skill
 *     dirs. This is what anything with a real filesystem should use — the
 *     Serac Portal reads the tree straight out of a checkout.
 *   - **As an embedded string map.** `BUNDLED_SKILLS` maps a path relative to
 *     the skills root (e.g. `incident-management/SKILL.md`) to that file's
 *     contents. This exists for consumers with no source filesystem alongside
 *     them — a bundled single file, a compiled binary, a serverless deploy. It
 *     is generated — see `./embedded.ts`.
 *
 * Importing this module pulls in the embedded map (a few hundred KB of string
 * literals). Import `@serac-labs/skills/root` instead if you only need the
 * directory path.
 */
// `.js` specifiers, not extensionless: tsc preserves the specifier verbatim, and
// Node's ESM resolver does no extension guessing, so an extensionless import
// here is an ERR_MODULE_NOT_FOUND for every npm consumer on node. Bun and
// TypeScript both map the .js back onto the .ts source in this repo.
export { BUNDLED_SKILLS } from "./embedded.js"
export { skillsRoot } from "./root.js"
