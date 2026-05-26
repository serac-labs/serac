import IDENTITY from "./agent-fragments/oss/identity.txt"
import MCP_DISCOVERY from "./agent-fragments/shared/mcp-discovery.txt"
import INSTRUCTION_HIERARCHY from "./agent-fragments/oss/instruction-hierarchy.txt"
import INSTANCE_MD from "./agent-fragments/shared/instance-md.txt"
import SKILLS_MD from "./agent-fragments/shared/skills-md.txt"
import REVIEWER from "./agent-fragments/oss/reviewer.txt"
import BEHAVIORAL_PRINCIPLES from "./agent-fragments/shared/behavioral-principles.txt"
import TWO_HARD_RULES from "./agent-fragments/shared/two-hard-rules.txt"
import DEV_WORKFLOWS from "./agent-fragments/oss/dev-workflows.txt"
import PROACTIVE_FETCHING from "./agent-fragments/oss/proactive-fetching.txt"
import ANTI_PATTERNS_CORE from "./agent-fragments/shared/anti-patterns-core.txt"
import ANTI_PATTERNS_EXTRA from "./agent-fragments/oss/anti-patterns-extra.txt"
import FINAL_CHECKLIST from "./agent-fragments/oss/final-checklist.txt"

/**
 * The end-user agent's `AGENTS.md` doctrine, composed from the fragments in
 * `./agent-fragments/`. `shared/` holds environment-invariant ServiceNow
 * doctrine that downstream products (the Serac Portal) consume too; `oss/`
 * holds the CLI/TUI-specific overlay. See `./agent-fragments/README.md`.
 *
 * The order below is the reading order of the generated `AGENTS.md`. A
 * snapshot test (`test/project/agents-template.test.ts`) locks the result
 * so a fragment edit shows up as a reviewable diff, not silent drift.
 */
export const AGENTS_TEMPLATE =
  [
    IDENTITY,
    MCP_DISCOVERY,
    INSTRUCTION_HIERARCHY,
    INSTANCE_MD,
    SKILLS_MD,
    REVIEWER,
    BEHAVIORAL_PRINCIPLES,
    TWO_HARD_RULES,
    DEV_WORKFLOWS,
    PROACTIVE_FETCHING,
    ANTI_PATTERNS_CORE,
    ANTI_PATTERNS_EXTRA,
    FINAL_CHECKLIST,
  ]
    .map((fragment) => fragment.trim())
    .join("\n\n") + "\n"
