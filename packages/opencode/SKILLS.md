# SKILLS.md — Serac Skill Index

This file lists every skill bundled with Serac. Skills are **specialized knowledge packages** loaded on demand. To use a skill, call:

```javascript
Skill({ skill: "skill-name" })
```

Only load a skill when the current task touches its domain. Skills are lazy-loaded for the same reason MCP tools are: keeping unused content out of the context window.

The authoritative description for each skill lives in its own `SKILL.md` frontmatter — this index is just a map.

---

## Development & Patterns

| Skill | Purpose |
|---|---|
| `es5-compliance` | ES5 JavaScript patterns for ServiceNow server-side scripts (Rhino engine) |
| `business-rule-patterns` | Business rule design, timing, and best practices |
| `client-scripts` | Client-side scripting patterns |
| `script-include-patterns` | Reusable script libraries |
| `gliderecord-patterns` | GlideRecord query patterns and pitfalls |
| `widget-coherence` | Service Portal widget HTML/Client/Server synchronization |
| `ui-actions-policies` | UI Actions and UI Policies |
| `ui-builder-patterns` | UI Builder component patterns |

## ITSM Modules

| Skill | Purpose |
|---|---|
| `incident-management` | Incident workflows and automation |
| `change-management` | Change request processes and CAB |
| `problem-management` | Problem and known error management |
| `request-management` | Service requests and fulfillment |
| `sla-management` | SLA definitions, breaches, and escalations |
| `approval-workflows` | Approval routing and delegation |

## Platform Features

| Skill | Purpose |
|---|---|
| `flow-designer` | Flow Designer flows, subflows, IF/ELSE/TRY/CATCH placement |
| `catalog-items` | Service catalog configuration |
| `knowledge-management` | Knowledge base articles |
| `email-notifications` | Email notifications and templates |
| `notification-events` | Event-driven notifications |
| `scheduled-jobs` | Scheduled scripts and jobs |
| `reporting-dashboards` | Reports and Performance Analytics |
| `performance-analytics` | PA indicators and dashboards |
| `virtual-agent` | Virtual Agent NLU topics |
| `workspace-builder` | Configurable workspaces |
| `agent-workspace` | Agent Workspace configuration |

## Integration & Data

| Skill | Purpose |
|---|---|
| `rest-integration` | REST API integrations |
| `integration-hub` | IntegrationHub and spokes |
| `import-export` | Import sets and data loading |
| `transform-maps` | Data transformation |
| `mid-server` | MID Server patterns |
| `discovery-patterns` | Discovery configuration |

## Security & Administration

| Skill | Purpose |
|---|---|
| `acl-security` | Access control lists |
| `instance-security` | Instance hardening and security baseline |
| `scoped-apps` | Scoped application development |
| `domain-separation` | Multi-tenant configurations |
| `update-set-workflow` | Update Set workflow, OAuth context, auto_switch |
| `data-policies` | Data policies vs business rules |
| `code-review` | Code review checklist for ServiceNow artifacts |

## Advanced Modules

| Skill | Purpose |
|---|---|
| `atf-testing` | Automated Test Framework |
| `cmdb-patterns` | CMDB and CI relationships |
| `asset-management` | Asset management lifecycle |
| `csm-patterns` | Customer Service Management |
| `hr-service-delivery` | HR Service Delivery |
| `field-service` | Field Service Management |
| `event-management` | Event Management and alerting |
| `security-operations` | Security Operations (SecOps) |
| `grc-compliance` | GRC and compliance |
| `vendor-management` | Vendor and contract management |
| `predictive-intelligence` | Predictive Intelligence and ML |
| `mobile-development` | Mobile-specific development |
| `document-management` | Document templates and management |

## Debugging & Verification

| Skill | Purpose |
|---|---|
| `debugging-mutations` | Post-execution mutation inspection: `snow_inspect_mutations`, syslog, flow execution logs, sys_audit caveats |
| `blast-radius` | Assess the blast radius of a change before deploying |

## Serac Specific

| Skill | Purpose |
|---|---|
| `mcp-tool-discovery` | Discover and use MCP tools via `tool_search` |
| `snow-flow-commands` | Serac CLI commands and modes |

---

## How to use

Skills complement the rules in `AGENTS.md`. Always follow the hard rules from `AGENTS.md` (Update Set first, ES5 only, silent tool discovery) — skills add domain-specific patterns on top.

```javascript
Skill({ skill: "flow-designer" })       // before creating a flow
Skill({ skill: "widget-coherence" })    // before building a Service Portal widget
Skill({ skill: "es5-compliance" })      // when writing or reviewing server-side JS
Skill({ skill: "update-set-workflow" }) // when the Update Set behavior is unclear
Skill({ skill: "debugging-mutations" }) // when verifying what a tool actually changed
```

Don't load every skill upfront. Load the one(s) the current task actually needs.
