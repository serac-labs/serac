/**
 * Which environment variables actually reach `loadContext`.
 *
 * These names are a published contract: README.md, CONTRIBUTING.md, SECURITY.md, both package READMEs and
 * now the repo's `.mcp.json` all tell people to export `SNOW_INSTANCE_URL`. The loader never read it, and
 * nothing anywhere failed — the server starts fine without credentials, so the only symptom was
 * "Failed to obtain access token" on the first tool call, which reads as a credential problem rather than
 * as "your instance URL was ignored". Every documented setup was affected.
 */

import { afterEach, describe, expect, test } from "@jest/globals"
import { loadContext } from "../context-loader"

const INSTANCE_VARS = ["SNOW_INSTANCE_URL", "SNOW_INSTANCE", "SERVICENOW_INSTANCE_URL"]
const CREDENTIAL_VARS = [
  ...INSTANCE_VARS,
  "SNOW_CLIENT_ID",
  "SERVICENOW_CLIENT_ID",
  "SNOW_CLIENT_SECRET",
  "SERVICENOW_CLIENT_SECRET",
]

const saved = Object.fromEntries(CREDENTIAL_VARS.map((name) => [name, process.env[name]]))

// The machine running these tests may have its own instance exported, and an incomplete environment makes
// loadContext fall through to a real auth.json in the home directory — so a case owns the whole set, not
// just the variable it is about.
const onlyInstance = (name: string, value: string) => {
  CREDENTIAL_VARS.forEach((other) => delete process.env[other])
  process.env[name] = value
  process.env.SNOW_CLIENT_ID = "client-id"
  process.env.SNOW_CLIENT_SECRET = "client-secret"
}

afterEach(() => {
  CREDENTIAL_VARS.forEach((name) => {
    delete process.env[name]
    if (saved[name] !== undefined) process.env[name] = saved[name]
  })
})

describe("loadContext — the instance URL", () => {
  test.each(INSTANCE_VARS)("%s is read", (name) => {
    onlyInstance(name, "https://dev12345.service-now.com")
    expect(loadContext().instanceUrl).toBe("https://dev12345.service-now.com")
  })

  test.each(INSTANCE_VARS)("%s may be given as a bare host", (name) => {
    // Callers copy the host out of the browser address bar. Without a scheme axios treats the value as a
    // relative path and the request never leaves the machine.
    onlyInstance(name, "dev12345.service-now.com")
    expect(loadContext().instanceUrl).toBe("https://dev12345.service-now.com")
  })
})
