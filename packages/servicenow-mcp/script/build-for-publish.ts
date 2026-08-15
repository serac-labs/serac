#!/usr/bin/env bun
// Build the package to dist/ and rewrite package.json exports/bin from
// ./src/*.ts to ./dist/*.js (+ .d.ts) so the published tarball resolves to
// the built output. Run right before `npm publish` in CI. The runner is
// ephemeral (tag-triggered publish), so package.json is intentionally NOT
// restored afterwards.
import { $ } from "bun"

const dir = new URL("..", import.meta.url).pathname
process.chdir(dir)

await $`bun tsc --project tsconfig.build.json`

const pkg = await import("../package.json").then((m) => m.default)
if (!pkg.exports || !pkg.bin) throw new Error("package.json must declare exports and bin to rewrite for publish")
for (const [key, value] of Object.entries(pkg.exports)) {
  // Non-TypeScript exports (the agent-fragment .txt assets, exposed as a
  // subpath pattern) ship verbatim from src/ — `files` includes that dir and
  // tsc never emits them into dist/, so rewriting them to ./dist/ would point
  // the published package at files that do not exist.
  if (!value.endsWith(".ts")) continue
  const file = value.replace("./src/", "./dist/").replace(".ts", "")
  // @ts-ignore
  pkg.exports[key] = { import: file + ".js", types: file + ".d.ts" }
}
for (const [key, value] of Object.entries(pkg.bin)) {
  // @ts-ignore
  pkg.bin[key] = value.replace("./src/", "./dist/").replace(/\.ts$/, ".js")
}
await Bun.write("package.json", JSON.stringify(pkg, null, 2))
