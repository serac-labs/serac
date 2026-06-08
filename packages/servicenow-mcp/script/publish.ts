#!/usr/bin/env bun
import { Script } from "@opencode-ai/script"
import { $ } from "bun"

const dir = new URL("..", import.meta.url).pathname
process.chdir(dir)

await $`bun tsc --project tsconfig.build.json`
const pkg = await import("../package.json").then((m) => m.default)
const original = JSON.parse(JSON.stringify(pkg))
for (const [key, value] of Object.entries(pkg.exports)) {
  const file = value.replace("./src/", "./dist/").replace(".ts", "")
  // @ts-ignore
  pkg.exports[key] = {
    import: file + ".js",
    types: file + ".d.ts",
  }
}
for (const [key, value] of Object.entries(pkg.bin)) {
  // @ts-ignore
  pkg.bin[key] = value.replace("./src/", "./dist/").replace(/\.ts$/, ".js")
}
await Bun.write("package.json", JSON.stringify(pkg, null, 2))
await $`bun pm pack && npm publish *.tgz --tag ${Script.channel} --access public`
await Bun.write("package.json", JSON.stringify(original, null, 2))
