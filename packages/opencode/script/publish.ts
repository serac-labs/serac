#!/usr/bin/env bun
import { $ } from "bun"
import pkg from "../package.json"
import { Script } from "@opencode-ai/script"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

const { binaries } = await import("./build.ts")
{
  const name = `serac-${process.platform}-${process.arch}`
  console.log(`smoke test: running dist/${name}/bin/serac --version`)
  await $`./dist/${name}/bin/serac --version`
}

await $`mkdir -p ./dist/${pkg.name}`
await $`cp -r ./bin ./dist/${pkg.name}/bin`
await $`cp ./script/postinstall.mjs ./dist/${pkg.name}/postinstall.mjs`

await Bun.file(`./dist/${pkg.name}/package.json`).write(
  JSON.stringify(
    {
      name: pkg.name + "-ai",
      bin: {
        [pkg.name]: `./bin/${pkg.name}`,
      },
      scripts: {
        postinstall: "bun ./postinstall.mjs || node ./postinstall.mjs",
      },
      version: Script.version,
      optionalDependencies: binaries,
    },
    null,
    2,
  ),
)

const tags = [Script.channel]

const tasks = Object.entries(binaries).map(async ([name]) => {
  if (process.platform !== "win32") {
    await $`chmod -R 755 .`.cwd(`./dist/${name}`)
  }
  await $`bun pm pack`.cwd(`./dist/${name}`)
  for (const tag of tags) {
    await $`npm publish *.tgz --access public --tag ${tag}`.cwd(`./dist/${name}`)
  }
})
await Promise.all(tasks)
for (const tag of tags) {
  await $`cd ./dist/${pkg.name} && bun pm pack && npm publish *.tgz --access public --tag ${tag}`
}

if (!Script.preview) {
  // Create archives for GitHub release
  // Include both bin/ and mcp/ directories so postinstall gets the MCP server files
  for (const key of Object.keys(binaries)) {
    if (key.includes("linux")) {
      await $`tar -czf ../${key}.tar.gz bin mcp`.cwd(`dist/${key}`)
    } else {
      await $`zip -r ../${key}.zip bin mcp`.cwd(`dist/${key}`)
    }
  }

  const image = "ghcr.io/serac-labs/serac"
  const platforms = "linux/amd64,linux/arm64"
  const tags = [`${image}:${Script.version}`, `${image}:latest`]
  const tagFlags = tags.flatMap((t) => ["-t", t])
  await $`docker buildx build --platform ${platforms} ${tagFlags} --push .`
}
