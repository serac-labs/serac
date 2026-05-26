import { describe, expect, test } from "bun:test"
import { AGENTS_TEMPLATE } from "../../src/project/agents-template"

describe("agents-template", () => {
  // Locks the composed AGENTS.md so a fragment edit shows up as a
  // reviewable diff instead of silent drift in the shipping TUI.
  test("composed AGENTS.md matches snapshot", () => {
    expect(AGENTS_TEMPLATE).toMatchSnapshot()
  })

  // Belt-and-braces: the crown-jewel ServiceNow doctrine that must never
  // drop out of the prompt, regardless of how the fragments are reshuffled.
  test("retains the core ServiceNow doctrine", () => {
    const required = [
      "# AI Agent Instructions",
      "HOW MCP TOOLS WORK",
      "SILENT DISCOVERY",
      "INSTRUCTION HIERARCHY",
      "INSTANCE.md",
      "SKILLS.md",
      "REVIEWER.md",
      "BEHAVIORAL CORE PRINCIPLES",
      "THE TWO HARD RULES",
      "Update Set FIRST",
      "ES5 only",
      "Mozilla Rhino",
      "CRITICAL ANTI-PATTERNS",
      "blast-radius",
      "FINAL CHECKLIST",
    ]
    for (const needle of required) {
      expect(AGENTS_TEMPLATE).toContain(needle)
    }
  })

  test("is non-trivial and ends with a single trailing newline", () => {
    expect(AGENTS_TEMPLATE.length).toBeGreaterThan(5000)
    expect(AGENTS_TEMPLATE.endsWith("\n")).toBe(true)
    expect(AGENTS_TEMPLATE.endsWith("\n\n")).toBe(false)
  })
})
