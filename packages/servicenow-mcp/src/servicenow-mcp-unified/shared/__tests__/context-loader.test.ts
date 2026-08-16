/**
 * Credential loading from the environment.
 *
 * The regression that motivated this file: `SNOW_INSTANCE_URL` is the variable
 * the README quick start, the package README, CONTRIBUTING and SECURITY all
 * tell people to set, and `loadContext()` read every name except that one. The
 * result was silent — the server starts fine without credentials — so the first
 * symptom was an auth error inside an unrelated tool call, hours later.
 *
 * Nothing is mocked: the real loader is called against a real (temporarily
 * emptied) process environment.
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals"

import { ENV_VARS, envCredential, authJsonPaths, loadContext } from "../context-loader.js"

const NAMES = Object.values(ENV_VARS).flat()

const saved = new Map<string, string | undefined>()

beforeEach(() => {
  NAMES.forEach((name) => {
    saved.set(name, process.env[name])
    delete process.env[name]
  })
})

afterEach(() => {
  saved.forEach((value, name) => {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  })
  saved.clear()
})

describe("environment credentials", () => {
  test("the env block from the README quick start configures the server", () => {
    // Copied from the "mcpServers" example in README.md. If this ever fails,
    // the documented setup produces an unauthenticated server again.
    process.env.SNOW_INSTANCE_URL = "https://dev12345.service-now.com"
    process.env.SNOW_CLIENT_ID = "3b7f2c1e9a4d4f6b8c0e1a2b3c4d5e6f"
    process.env.SNOW_CLIENT_SECRET = "not-a-real-secret"

    const context = loadContext()

    expect(context.instanceUrl).toBe("https://dev12345.service-now.com")
    expect(context.clientId).toBe("3b7f2c1e9a4d4f6b8c0e1a2b3c4d5e6f")
    expect(context.clientSecret).toBe("not-a-real-secret")
  })

  test.each(ENV_VARS.instanceUrl)("%s supplies the instance URL", (name) => {
    process.env[name] = "https://dev12345.service-now.com"
    process.env.SNOW_CLIENT_ID = "id"
    process.env.SNOW_CLIENT_SECRET = "secret"

    expect(loadContext().instanceUrl).toBe("https://dev12345.service-now.com")
    expect(envCredential("instanceUrl")?.name).toBe(name)
  })

  test("a bare host gets a scheme, whichever variable it came from", () => {
    process.env.SERVICENOW_INSTANCE_URL = "dev12345.service-now.com"
    process.env.SNOW_CLIENT_ID = "id"
    process.env.SNOW_CLIENT_SECRET = "secret"

    expect(loadContext().instanceUrl).toBe("https://dev12345.service-now.com")
  })

  test("the first variable that is set wins, and reports its own name", () => {
    process.env.SNOW_INSTANCE_URL = "https://second.service-now.com"
    process.env.SERVICENOW_INSTANCE_URL = "https://first.service-now.com"

    expect(envCredential("instanceUrl")).toEqual({
      name: "SERVICENOW_INSTANCE_URL",
      value: "https://first.service-now.com",
    })
  })

  test("a whitespace-only variable counts as unset", () => {
    process.env.SNOW_CLIENT_ID = "   "

    expect(envCredential("clientId")).toBeUndefined()
  })

  test("half a credential set does not configure anything", () => {
    // The environment link needs instance + id + secret together. Anything less
    // falls through to auth.json, which is the moment a stale file takes over.
    process.env.SNOW_INSTANCE_URL = "https://dev12345.service-now.com"
    process.env.SNOW_CLIENT_ID = "id"

    expect(loadContext().instanceUrl).not.toBe("https://dev12345.service-now.com")
  })
})

describe("auth.json locations", () => {
  test("the documented Serac path is among the ones the loader reads", () => {
    const paths = authJsonPaths()

    expect(paths.length).toBeGreaterThan(0)
    expect(paths.some((path) => path.endsWith(`.serac/auth.json`))).toBe(true)
    // Every path is absolute — the doctor prints these, and a relative path
    // would be meaningless to whoever has to go and delete the stale file.
    expect(paths.every((path) => path.startsWith("/") || /^[A-Za-z]:\\/.test(path))).toBe(true)
  })
})
