/**
 * The scripted-exec endpoint is the single most dangerous artefact Serac
 * installs: it evaluates arbitrary server-side script, and
 * GlideEvaluator.evaluateString ignores ACLs, so whoever reaches it is
 * effectively admin on that instance.
 *
 * Before the guard, the operation was created with no ACL authorisation, which
 * meant ServiceNow authenticated the caller and then authorised everyone — any
 * ESS or itil account could POST a script that granted itself roles. The
 * artefact is also permanent and was never cleaned up.
 *
 * These tests pin the security property of the deployed script itself. They
 * exist because the failure mode is silent: an edit that drops the role check
 * still compiles, still deploys, still works for us, and quietly reopens the
 * hole on every instance the endpoint is installed on.
 */

import { describe, test, expect } from "@jest/globals"
import { OPERATION_SCRIPT, OPERATION_SCRIPT_MARKER } from "../scripted-exec"

describe("scripted-exec endpoint script", () => {
  test("refuses callers without the admin role", () => {
    expect(OPERATION_SCRIPT).toContain("gs.hasRole('admin')")
    expect(OPERATION_SCRIPT).toContain("response.setStatus(403)")
  })

  test("checks the role BEFORE it reads or evaluates anything", () => {
    // Order is the whole point: a check placed after evaluateString would run
    // once the damage is done.
    const guardAt = OPERATION_SCRIPT.indexOf("gs.hasRole('admin')")
    const evalAt = OPERATION_SCRIPT.indexOf("GlideEvaluator.evaluateString")
    const readsBody = OPERATION_SCRIPT.indexOf("request.body.data")
    expect(guardAt).toBeGreaterThan(-1)
    expect(evalAt).toBeGreaterThan(guardAt)
    expect(readsBody).toBeGreaterThan(guardAt)
  })

  test("returns from the guard rather than falling through", () => {
    // A 403 body without a `return` would set the status and then execute the
    // script anyway.
    const guardBlock = OPERATION_SCRIPT.slice(
      OPERATION_SCRIPT.indexOf("gs.hasRole('admin')"),
      OPERATION_SCRIPT.indexOf("var body ="),
    )
    expect(guardBlock).toContain("return;")
  })

  test("carries the version marker used to detect and repair old endpoints", () => {
    // ensureEndpointDiagnosed greps a deployed script for this marker and
    // rewrites the operation when it is missing. If the marker ever leaves the
    // script, every already-planted endpoint silently stops being repaired.
    expect(OPERATION_SCRIPT).toContain(OPERATION_SCRIPT_MARKER)
    expect(OPERATION_SCRIPT_MARKER.length).toBeGreaterThan(0)
  })

  test("still does the job it exists for", () => {
    // Guard against over-correcting: the endpoint must remain a working script
    // runner for an admin caller.
    expect(OPERATION_SCRIPT).toContain("GlideEvaluator.evaluateString(script)")
    expect(OPERATION_SCRIPT).toContain("execution_time_ms")
  })
})
