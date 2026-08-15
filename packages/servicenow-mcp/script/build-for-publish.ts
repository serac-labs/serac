#!/usr/bin/env bun
// Build the package to dist/ and rewrite package.json exports/bin from
// ./src/*.ts to ./dist/*.js (+ .d.ts) so the published tarball resolves to
// the built output. Run right before `npm publish` in CI. The runner is
// ephemeral (tag-triggered publish), so package.json is intentionally NOT
// restored afterwards.
//
// Everything this needs (tsc, @types/bun) is declared in this package's own
// devDependencies, so `bun install && bun run build:publish` works from this
// directory alone — no monorepo root, no hoisted toolchain.
import { $ } from "bun"
import { existsSync, rmSync } from "node:fs"

const dir = new URL("..", import.meta.url).pathname
process.chdir(dir)

// Start from an empty dist/. `files: ["dist"]` ships whatever is in there, so
// without this a stale artifact from an earlier build — a file whose source has
// since been deleted or renamed — rides along into the tarball, and the
// entrypoint checks below cannot tell it apart from a freshly emitted one.
rmSync("dist", { recursive: true, force: true })

// Delegates to the package's own "build" script so the compiler flags have a
// single source of truth. `$` throws on a non-zero exit, which aborts before
// anything is rewritten or published.
await $`bun run build`

type Entry = string | { types: string; import: string }
type Manifest = Record<string, unknown> & { exports?: Record<string, Entry>; bin?: Record<string, string> }

const pkg: Manifest = await Bun.file("package.json").json()
if (!pkg.exports || !pkg.bin) throw new Error("package.json must declare exports and bin to rewrite for publish")

const built = (value: string) => value.replace("./src/", "./dist/").replace(/\.ts$/, "")

const exports: Record<string, Entry> = Object.fromEntries(
  Object.entries(pkg.exports).map(([key, value]) => {
    // Non-TypeScript exports (the agent-fragment .txt assets, exposed as a
    // subpath pattern) ship verbatim from src/ — `files` includes that dir and
    // tsc never emits them into dist/, so rewriting them to ./dist/ would point
    // the published package at files that do not exist. Anything already
    // rewritten (a re-run on the same checkout) is left alone.
    if (typeof value !== "string" || !value.endsWith(".ts")) return [key, value]
    // `types` is listed FIRST: export conditions are matched in declaration
    // order, and publint / are-the-types-wrong flag a `types` condition that
    // trails `import`, because a resolver can match the .js before it ever
    // reaches the declarations.
    return [key, { types: built(value) + ".d.ts", import: built(value) + ".js" }]
  }),
)

// Extension-swapping rather than `built() + ".js"`, so a re-run on an already
// rewritten package.json is a no-op instead of producing ./dist/index.js.js.
const bin: Record<string, string> = Object.fromEntries(
  Object.entries(pkg.bin).map(([key, value]) => [key, value.replace("./src/", "./dist/").replace(/\.ts$/, ".js")]),
)

const targets: { name: string; file: string }[] = [
  ...Object.entries(exports).flatMap(([key, value]) =>
    typeof value === "string"
      ? [{ name: `exports["${key}"]`, file: value }]
      : [
          { name: `exports["${key}"].types`, file: value.types },
          { name: `exports["${key}"].import`, file: value.import },
        ],
  ),
  ...Object.entries(bin).map(([key, file]) => ({ name: `bin["${key}"]`, file })),
]

const onDisk = (file: string) => {
  const path = file.replace(/^\.\//, "")
  // Subpath patterns (./src/agent-fragments/*) resolve at import time; the most
  // that can be checked here is that the directory they ship from exists.
  const star = path.indexOf("*")
  return existsSync(star === -1 ? path : path.slice(0, star))
}

// tsc writes dist/ even when it exits non-zero, so "some dist file exists" is
// not evidence of a successful build. Assert instead that EVERY published
// entrypoint resolves to a file that is really on disk. A partial build that
// drops ./blast-radius would break serac-platform, which imports exactly that
// subpath — this is the check that catches it before npm publish, not after.
const missing = targets.filter((target) => !onDisk(target.file))
if (missing.length > 0) {
  const detail = missing.map((target) => `  ${target.name} -> ${target.file}`).join("\n")
  throw new Error(`build produced no file for ${missing.length} published entrypoint(s):\n${detail}`)
}

// Nothing published may still point into src/ except the deliberate
// agent-fragment passthrough above.
const unbuilt = targets.filter((target) => target.file.startsWith("./src/") && target.file.endsWith(".ts"))
if (unbuilt.length > 0) {
  const detail = unbuilt.map((target) => `  ${target.name} -> ${target.file}`).join("\n")
  throw new Error(`package.json still points at TypeScript source after the rewrite:\n${detail}`)
}

await Bun.write("package.json", JSON.stringify({ ...pkg, exports, bin }, null, 2) + "\n")
console.log(`rewrote ${targets.length} published entrypoints to dist/ — all present`)
