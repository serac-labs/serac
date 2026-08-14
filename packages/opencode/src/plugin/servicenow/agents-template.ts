import IDENTITY from "@serac-labs/servicenow-mcp/agent-fragments/oss/identity.txt"
import MCP_DISCOVERY from "@serac-labs/servicenow-mcp/agent-fragments/shared/mcp-discovery.txt"
import INSTRUCTION_HIERARCHY from "@serac-labs/servicenow-mcp/agent-fragments/oss/instruction-hierarchy.txt"
import INSTANCE_MD from "@serac-labs/servicenow-mcp/agent-fragments/shared/instance-md.txt"
import SKILLS_MD from "@serac-labs/servicenow-mcp/agent-fragments/shared/skills-md.txt"
import REVIEWER from "@serac-labs/servicenow-mcp/agent-fragments/oss/reviewer.txt"
import BEHAVIORAL_PRINCIPLES from "@serac-labs/servicenow-mcp/agent-fragments/shared/behavioral-principles.txt"
import TWO_HARD_RULES from "@serac-labs/servicenow-mcp/agent-fragments/shared/two-hard-rules.txt"
import DEV_WORKFLOWS from "@serac-labs/servicenow-mcp/agent-fragments/oss/dev-workflows.txt"
import PROACTIVE_FETCHING from "@serac-labs/servicenow-mcp/agent-fragments/oss/proactive-fetching.txt"
import ANTI_PATTERNS_CORE from "@serac-labs/servicenow-mcp/agent-fragments/shared/anti-patterns-core.txt"
import ANTI_PATTERNS_EXTRA from "@serac-labs/servicenow-mcp/agent-fragments/oss/anti-patterns-extra.txt"
import FINAL_CHECKLIST from "@serac-labs/servicenow-mcp/agent-fragments/oss/final-checklist.txt"

/**
 * Serac's baked-in agent doctrine, composed from the fragments in
 * `@serac-labs/servicenow-mcp/agent-fragments` (on disk:
 * `packages/servicenow-mcp/src/agent-fragments/`). `shared/` holds
 * environment-invariant ServiceNow doctrine that downstream products (the
 * Serac Portal) consume too; `oss/` holds the CLI/TUI-specific overlay. See
 * that directory's README.md.
 *
 * The order below is the reading order of the composed doctrine. The Serac
 * auth plugin writes this to a stable on-disk file and points
 * `config.instructions` at it, so the doctrine is injected into every
 * session's system prompt via the standard instruction mechanism.
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
