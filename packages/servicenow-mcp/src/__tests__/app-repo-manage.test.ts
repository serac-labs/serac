/**
 * Tests for snow_app_repo_manage that need no instance.
 *
 * Four things here are worth pinning down. reportProgress is the single place
 * that decides what a CI/CD progress record means, and the tool exists because
 * the thing it replaced reported deployments it never performed — so "a job
 * that is not Successful is never reported as a success" is the property the
 * tool is for, not an implementation detail. progressPath decides which
 * address gets polled: the client it runs on carries the instance's
 * Authorization header on every request, so a host arriving in a response body
 * must not survive into the request. pollUntilFinal has to tell "I could not
 * read the progress record" apart from "the job failed", because an install can
 * knock the node out for a poll or two. And snow_install_application, the tool
 * this one replaces, must stay incapable of reporting an install again.
 */

import { describe, expect, test } from "bun:test"
import type { AxiosInstance } from "axios"
import {
  ACTIONS,
  execute,
  pollUntilFinal,
  progressPath,
  reportProgress,
  toolDefinition,
} from "../servicenow-mcp-unified/tools/applications/snow_app_repo_manage"

describe("reportProgress", () => {
  test("a Successful job is the only thing that comes back as a success", () => {
    const result = reportProgress("Install of x_acme_app", "install", { status: "2", status_label: "Successful" }, "p1")
    expect(result.success).toBe(true)
    expect(result.data.state).toBe("successful")
    expect(result.data.finished).toBe(true)
  })

  test("a Failed job is an error carrying ServiceNow's own message", () => {
    const result = reportProgress(
      "Install of x_acme_app",
      "install",
      { status: "3", status_label: "Failed", error: "Dependency x_acme_lib is not installed" },
      "p1",
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain("Failed")
    expect(result.error).toContain("Dependency x_acme_lib is not installed")
  })

  test("a Canceled job is an error too", () => {
    const result = reportProgress("Publish of x_acme_app", "publish", { status: "4", status_label: "Canceled" }, "p1")
    expect(result.success).toBe(false)
  })

  test("a running job is never reported as finished", () => {
    const result = reportProgress(
      "Install of x_acme_app",
      "install",
      { status: "1", status_label: "Running", percent_complete: 40 },
      "p1",
    )
    expect(result.data.finished).toBe(false)
    expect(result.data.state).toBe("running")
    expect(result.summary).toContain("NOT finished")
  })

  test("an unrecognised status is unknown, not assumed complete", () => {
    const result = reportProgress("Install of x_acme_app", "install", { status: "9" }, "p1")
    expect(result.data.state).toBe("unknown")
    expect(result.data.finished).toBe(false)
  })
})

describe("progressPath", () => {
  test("follows the returned link, but only its path — never its host", () => {
    expect(
      progressPath({
        id: "d174f8e11bd800103d374087bc4bcbd9",
        url: "https://dev12345.service-now.com/api/sn_cicd/progress/d174f8e11bd800103d374087bc4bcbd9",
      }),
    ).toBe("/api/sn_cicd/progress/d174f8e11bd800103d374087bc4bcbd9")
  })

  test("a host swapped into the response body does not become the request target", () => {
    const path = progressPath({ id: "abc", url: "https://attacker.example.com/api/sn_cicd/progress/abc" })
    expect(path).toBe("/api/sn_cicd/progress/abc")
    expect(path).not.toContain("attacker.example.com")
  })

  test("falls back to the id when the link has no usable url", () => {
    expect(progressPath({ id: "abc" })).toBe("/api/sn_cicd/progress/abc")
    expect(progressPath({ id: "abc", url: "/api/sn_cicd/progress/abc" })).toBe("/api/sn_cicd/progress/abc")
  })

  test("returns nothing when ServiceNow returned no progress link at all", () => {
    expect(progressPath({})).toBeUndefined()
  })
})

describe("pollUntilFinal", () => {
  // A stand-in for the axios client rather than a mocking framework: the point
  // is what pollUntilFinal does with a GET that rejects, and there is no way to
  // make a real client reject on demand without an instance.
  const failing = (message: string) => ({ get: () => Promise.reject(new Error(message)) }) as unknown as AxiosInstance

  test("a progress GET that fails does not abort the wait", async () => {
    // Regression: fetchProgress used to throw straight out of settle(), so a
    // 502 during an install — which auth.ts renders as "hibernating or starting
    // up" — was reported instead of the install, and the progress_id went with
    // it. An unreadable poll is now a poll to retry, not an outcome.
    const polled = await pollUntilFinal(
      failing("ServiceNow instance is hibernating or starting up (HTTP 503)."),
      "/api/sn_cicd/progress/p1",
      // Already spent, so this returns after one attempt instead of sleeping.
      Date.now(),
    )
    expect(polled.final).toBe(false)
    expect(polled.progress.poll_error).toContain("HTTP 503")
    expect(polled.progress.status).toBeUndefined()
  })

  test("the last status this loop did read survives a later failed poll", async () => {
    const polled = await pollUntilFinal(failing("socket hang up"), "/api/sn_cicd/progress/p1", Date.now(), {
      status: "1",
      status_label: "Running",
      percent_complete: 40,
    })
    expect(polled.final).toBe(false)
    expect(polled.progress.status_label).toBe("Running")
    expect(polled.progress.poll_error).toBe("socket hang up")
  })
})

describe("snow_install_application is retired, not fabricating", () => {
  test("it makes no request and routes to the tool that installs", async () => {
    // It used to POST { sys_id, version } to /api/now/table/sys_store_app and
    // return { installed: true } from the row the Table API echoed back. The
    // executor no longer imports an auth client at all, so there is no path on
    // which it can report an install again.
    const retired = await import("../servicenow-mcp-unified/tools/applications/snow_install_application")
    const result = await retired.execute({ app_id: "abc123", version: "1.2.0" })
    expect(result.success).toBe(false)
    expect(result.error).toContain("snow_app_repo_manage")
    expect(retired.toolDefinition.description.slice(0, 60)).toMatch(/\bdeprecated\b/i)
  })
})

describe("snow_app_repo_manage dispatch", () => {
  test("every action the schema advertises is one the executor dispatches", () => {
    expect(Object.keys(ACTIONS).sort()).toEqual(
      [...(toolDefinition.inputSchema.properties.action.enum as string[])].sort(),
    )
  })

  test("an unknown action is rejected before anything touches the instance", async () => {
    // Deliberately unreachable credentials: if the executor authenticated
    // first, this would fail with a connection error instead of the argument
    // error.
    const result = await execute(
      { action: "deploy" },
      { instanceUrl: "https://unreachable.invalid", clientId: "", clientSecret: "" },
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain("Unknown action: deploy")
    expect(result.error).toContain("publish, install, progress")
  })
})
