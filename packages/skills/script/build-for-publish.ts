#!/usr/bin/env bun
// Build the package to dist/ and rewrite package.json exports from ./src/*.ts
// to ./dist/*.js (+ .d.ts) so the published tarball resolves to the built
// output. Run right before `npm publish` in CI. The runner is ephemeral, so
// package.json is intentionally NOT restored afterwards.
//
// Why this package needs a build at all, given the skills are markdown: the
// markdown ships verbatim (see `files`), but the three modules that make it
// reachable — skillsRoot(), BUNDLED_SKILLS and the index that re-exports both —
// are TypeScript. An npm consumer on node cannot load a .ts file, so exports
// pointing at src/ would publish a package whose every entrypoint throws.
//
// Everything this needs (tsc, @types/bun) is declared in this package's own
// devDependencies, so `bun install && bun run script/build-for-publish.ts`
// works from this directory alone — no monorepo root, no hoisted toolchain.
import { $ } from "bun"
import { existsSync, rmSync } from "node:fs"

process.chdir(new URL("..", import.meta.url).pathname)

// src/embedded.ts is generated, and it is the payload of the ./embedded and .
// subpaths — a stale one publishes skills that no longer exist and omits ones
// that do. That is not hypothetical: a shipped binary carried 55 of 58 skills
// for weeks. `bun test` checks the same thing, but a release must not be able
// to skip it by running this script alone. --check never writes.
await $`bun run generate:check`

// Start from an empty dist/. `files` ships whatever is in there, so without
// this a stale artifact from an earlier build — a file whose source has since
// been deleted or renamed — rides along into the tarball.
rmSync("dist", { recursive: true, force: true })

// Delegates to the package's own "build" script so the compiler flags have a
// single source of truth. `$` throws on a non-zero exit, which aborts before
// anything is rewritten or published.
await $`bun run build`

type Entry = string | { types: string; import: string }
type Manifest = Record<string, unknown> & { exports?: Record<string, Entry> }

const pkg: Manifest = await Bun.file("package.json").json()
if (!pkg.exports) throw new Error("package.json must declare exports to rewrite for publish")

const exports: Record<string, Entry> = Object.fromEntries(
  Object.entries(pkg.exports).map(([key, value]) => {
    // Anything already rewritten (a re-run on the same checkout) is left alone.
    if (typeof value !== "string" || !value.endsWith(".ts")) return [key, value]
    // `types` is listed FIRST: export conditions are matched in declaration
    // order, and publint / are-the-types-wrong flag a `types` condition that
    // trails `import`, because a resolver can match the .js before it ever
    // reaches the declarations.
    const built = value.replace("./src/", "./dist/").replace(/\.ts$/, "")
    return [key, { types: built + ".d.ts", import: built + ".js" }]
  }),
)

const targets = Object.entries(exports).flatMap(([key, value]) =>
  typeof value === "string"
    ? [{ name: `exports["${key}"]`, file: value }]
    : [
        { name: `exports["${key}"].types`, file: value.types },
        { name: `exports["${key}"].import`, file: value.import },
      ],
)

// tsc writes dist/ even when it exits non-zero, so "some dist file exists" is
// not evidence of a successful build. Assert instead that EVERY published
// entrypoint resolves to a file that is really on disk.
const missing = targets.filter((target) => !existsSync(target.file.replace(/^\.\//, "")))
if (missing.length > 0)
  throw new Error(
    `build produced no file for ${missing.length} published entrypoint(s):\n` +
      missing.map((target) => `  ${target.name} -> ${target.file}`).join("\n"),
  )

const unbuilt = targets.filter((target) => target.file.startsWith("./src/"))
if (unbuilt.length > 0)
  throw new Error(
    `package.json still points at TypeScript source after the rewrite:\n` +
      unbuilt.map((target) => `  ${target.name} -> ${target.file}`).join("\n"),
  )

// The headline export is a PATH, so "the file exists" proves nothing about
// whether it is correct. skillsRoot() resolves the skill tree as `<its own
// directory>/..`, which only lands on the package root while the emitted module
// sits exactly as deep as src/ did. Widen rootDir in tsconfig.build.json and
// tsc emits dist/src/root.js instead; the export still loads, and every
// consumer that reads skills off disk gets <pkg>/dist — a directory with no
// skills in it. Load the built module and check where it actually points.
// (Specifier built from a URL because dist/ does not exist at typecheck time.)
const root = await import(new URL("../dist/root.js", import.meta.url).href).then((module) => module.skillsRoot())
if (root !== process.cwd())
  throw new Error(`built skillsRoot() resolves to ${root}, not the package root ${process.cwd()}`)

await Bun.write("package.json", JSON.stringify({ ...pkg, exports }, null, 2) + "\n")
console.log(`rewrote ${targets.length} published entrypoints to dist/ — all present, skillsRoot() -> ${root}`)
