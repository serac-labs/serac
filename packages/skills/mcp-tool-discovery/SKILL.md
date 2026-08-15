---
name: mcp-tool-discovery
description: Use tool_search to discover and enable lazy-loaded Serac MCP tools (snow_*, jira_*, github_*, etc). Explains naming conventions, search strategies, and always-available activity tools.
license: Apache-2.0
compatibility: Designed for Serac and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: platform
tools:
  - tool_search
---

# MCP Tool Discovery Guide

Serac provides 429 tools via MCP (Model Context Protocol) servers. Tools are **lazy-loaded** to save tokens - use `tool_search` to discover them.

## Quick Start

```javascript
// Find tools for a specific task
tool_search({ query: "incident" }) // ServiceNow incidents
tool_search({ query: "widget" }) // Widget development
tool_search({ query: "update set" }) // Update Set management
tool_search({ query: "cmdb" }) // CMDB operations
```

## Tool Categories

### ServiceNow Core Operations

| Query           | Tools Found                         |
| --------------- | ----------------------------------- |
| `"incident"`    | Incident CRUD, metrics, SLA         |
| `"change"`      | Change requests, CAB, risk          |
| `"problem"`     | Problem management, known errors    |
| `"cmdb"`        | CI search, relationships, discovery |
| `"user lookup"` | User/group queries                  |
| `"query table"` | Universal table queries             |

### ServiceNow Development

| Query              | Tools Found                |
| ------------------ | -------------------------- |
| `"widget"`         | Widget create/update/sync  |
| `"business rule"`  | BR creation and management |
| `"script include"` | Reusable scripts           |
| `"client script"`  | Client-side scripts        |
| `"ui policy"`      | Form policies              |
| `"ui action"`      | Buttons and links          |
| `"update set"`     | Update Set lifecycle       |
| `"snow deploy"`    | Artifact deployment        |

### ServiceNow Platform

| Query             | Tools Found                 |
| ----------------- | --------------------------- |
| `"flow designer"` | Flow/subflow creation       |
| `"workspace"`     | Workspace builder           |
| `"catalog"`       | Service catalog items       |
| `"knowledge"`     | Knowledge articles          |
| `"notification"`  | Email notifications         |
| `"scheduled job"` | Scheduled scripts           |
| `"rest"`          | REST API integration        |
| `"import"`        | Import sets, transform maps |

### Activity & Instance

| Query             | Tools Found                          |
| ----------------- | ------------------------------------ |
| `"activity"`      | Activity tracking (always available) |
| `"instance info"` | Instance URL and config              |
| `"property"`      | System properties                    |
| `"logs"`          | System logs                          |

### Enterprise (if enabled)

| Query            | Tools Found                        |
| ---------------- | ---------------------------------- |
| `"jira"`         | Jira issues, transitions, comments |
| `"azure devops"` | Work items, boards, pipelines      |
| `"confluence"`   | Pages, spaces, search              |
| `"github"`       | Issues, PRs, workflows, releases   |
| `"gitlab"`       | Issues, MRs, pipelines             |

## Always-Available Tools

These tools are loaded by default (no discovery needed):

```javascript
// Activity tracking
activity_start({ source, storyTitle, storyType, ... })
activity_update({ activityId, status, summary })
activity_complete({ activityId, summary })
activity_add_artifact({ activityId, artifactType, ... })

// Core tool discovery
tool_search({ query, enable: true })
```

## How tool_search Works

1. **Search** - Finds tools matching your query
2. **Enable** - Automatically enables found tools for your session
3. **Use** - Call the discovered tool by name

```javascript
// Step 1: Search
tool_search({ query: "jira" })
// Returns: jira_search_issues, jira_get_issue, jira_create_issue, ...

// Step 2: Call discovered tool
jira_search_issues({ jql: "project = PROJ AND status = Open" })
```

## Search Tips

### Be Specific

```javascript
// Too broad - may not find what you need
tool_search({ query: "github" }) // Returns 20+ tools

// More specific - finds exactly what you need
tool_search({ query: "github content" }) // File content tools
tool_search({ query: "github repository" }) // Repo info tools
tool_search({ query: "github pull request" }) // PR tools
```

### Search by Action

```javascript
tool_search({ query: "create incident" })
tool_search({ query: "update widget" })
tool_search({ query: "query cmdb" })
tool_search({ query: "deploy business rule" })
```

### Search by Table

```javascript
tool_search({ query: "sys_script_include" })
tool_search({ query: "sp_widget" })
tool_search({ query: "sysevent_email_action" })
```

## Tool Naming Patterns

Tools follow consistent naming patterns:

| Pattern         | Example                  | Purpose               |
| --------------- | ------------------------ | --------------------- |
| `snow_*`        | `snow_query_table`       | ServiceNow operations |
| `snow_deploy_*` | `snow_artifact_manage` (action='create', type='sp_widget') | Artifact creation     |
| `snow_update_*` | `snow_update_set_manage` | Update operations     |
| `jira_*`        | `jira_search_issues`     | Jira integration      |
| `azdo_*`        | `azdo_search_work_items` | Azure DevOps          |
| `confluence_*`  | `confluence_create_page` | Confluence            |
| `github_*`      | `github_create_issue`    | GitHub                |
| `gitlab_*`      | `gitlab_create_mr`       | GitLab                |

## MCP Server Categories

Serac includes specialized MCP servers:

| Server                     | Purpose               | Example Tools        |
| -------------------------- | --------------------- | -------------------- |
| **ServiceNow Unified**     | Core ServiceNow ops   | Query, CRUD, scripts |
| **ServiceNow Development** | Artifact management   | Deploy, widget sync  |
| **ServiceNow Automation**  | Script execution      | Background scripts   |
| **ServiceNow ITSM**        | IT Service Management | Incidents, changes   |
| **ServiceNow Platform**    | Platform features     | Flows, workspaces    |
| **Enterprise**             | External integrations | Jira, Azure, GitHub  |

## Best Practices

1. **Discover Before Using** - Always use `tool_search` first
2. **Be Specific** - Narrow queries find better matches
3. **Check Results** - Review tool descriptions before calling
4. **Enable by Default** - `enable: true` is the default
5. **Silent Discovery** - Don't tell users you're discovering tools

## Troubleshooting

| Issue                   | Solution                        |
| ----------------------- | ------------------------------- |
| Tool not found          | Try different query terms       |
| Too many results        | Be more specific in query       |
| Tool doesn't work       | Check parameters, may need auth |
| Enterprise tool missing | Verify enterprise auth status   |

## Example Workflows

### Finding Incident Tools

```javascript
// Discover
tool_search({ query: "incident" })

// Use discovered tools
snow_record_manage({ action: "query", table: "incident", query: "active=true^priority=1" })
snow_record_manage({ action: "create", table: "incident", short_description: "...", caller_id: "..." })
```

### Finding Widget Tools

```javascript
// Discover
tool_search({ query: "widget" })

// Use discovered tools
snow_artifact_manage({ action: "find", type: "sp_widget", query: "incident" })
snow_pull_artifact({ sys_id: "<widget sys_id>", table: "sp_widget", output_dir: "./widgets" })
```

### Finding Enterprise Tools

```javascript
// Discover Jira tools
tool_search({ query: "jira" })

// Use discovered tools
jira_search_issues({ jql: "project = SNOW AND status = Open" })
jira_transition_issue({ issueKey: "SNOW-123", transition: "In Progress" })
```
