---
name: update-set-workflow
description: Manage ServiceNow update sets — create named sets before any development, ensure auto_switch tracks API changes under the OAuth service account, complete on done, and export for promotion. Mandatory for all change-producing work.
version: 1.0.0
tools:
  - snow_update_set_manage (action='create')
  - snow_update_set_query (action='current')
  - snow_update_set_manage (action='switch')
  - snow_update_set_manage (action='complete')
  - snow_ensure_active_update_set
---

# Update Set Workflow for ServiceNow

Update Sets are MANDATORY for tracking changes in ServiceNow development. Without an Update Set, changes are not tracked and cannot be deployed to other instances.

This is also enforced: configuration writes are blocked at the tool layer while no update set is active for the session. When you hit that block, ask the user whether to capture the work in a named update set, then call `snow_ensure_active_update_set({ name })` once and retry. Only if the user explicitly declines tracking, re-issue the call once with `__skipUpdateSet: true` — the choice is remembered for the rest of the session.

## Before ANY Development

ALWAYS create or ensure an Update Set is active before making changes:

```javascript
// Step 1: Check current Update Set
var current = await snow_update_set_query({ action: "current" })

// Step 2: If no Update Set or using Default, create one
if (!current || current.name === "Default") {
  await snow_update_set_manage({
    action: "create",
    name: "Feature: [Descriptive Name]",
    description: "What and why this change is being made",
  })
}

// Step 3: Now safe to make changes
// All changes will be tracked!

// Step 4: When done, complete the Update Set
await snow_update_set_manage({
  action: "complete",
  update_set_id: current.sys_id,
})
```

## Update Set Naming Conventions

| Type        | Format                | Example                              |
| ----------- | --------------------- | ------------------------------------ |
| Feature     | `Feature: [Name]`     | `Feature: Incident Auto-Assignment`  |
| Bug Fix     | `Fix: [Issue]`        | `Fix: Approval Email Not Sending`    |
| Enhancement | `Enhancement: [Name]` | `Enhancement: Dashboard Performance` |
| Hotfix      | `Hotfix: [Issue]`     | `Hotfix: Critical Login Bug`         |

## Update Set Lifecycle

1. **In Progress** - Active, receiving changes
2. **Complete** - Ready for export/promotion
3. **Ignore** - Changes won't be promoted (use for experiments)

## What Gets Tracked

Update Sets automatically capture changes to:

- Tables and columns
- Business Rules
- Script Includes
- Client Scripts
- UI Policies and Actions
- Workflows and Flow Designer flows
- Service Portal widgets and pages
- ACLs and Security Rules
- System Properties
- Scheduled Jobs
- And more...

## What Does NOT Get Tracked

- Data records (use Import Sets for data)
- Attachments on records
- User session information
- Some system tables (sys_user, etc.)

## MCP Tools for Update Sets

```javascript
// Create new Update Set
snow_update_set_manage({
  action: "create",
  name: "Feature: My Feature",
  description: "Description of changes",
})

// Switch to existing Update Set
snow_update_set_manage({
  action: "switch",
  update_set_id: "sys_id_here",
})

// Get current Update Set
snow_update_set_query({ action: "current" })

// Complete Update Set
snow_update_set_manage({
  action: "complete",
  update_set_id: "sys_id_here",
})

// Export Update Set as XML
snow_update_set_manage({
  action: "export",
  update_set_id: "sys_id_here",
})
```

## Best Practices

1. **One feature per Update Set** - Don't mix unrelated changes
2. **Descriptive names** - Make it clear what the Update Set contains
3. **Complete when done** - Don't leave Update Sets open indefinitely
4. **Test before completing** - Verify all changes work correctly
5. **Never use Default** - Always create a named Update Set

## OAuth Context & Update Set Tracking

**Serac uses OAuth service account authentication.** All API calls run as an OAuth **service account**, not as your UI user. Update Sets must be "current" for the user making the changes — for API changes that means current for the service account.

### The Two Contexts

```
┌─────────────────────────────────────────────────────────────┐
│ YOUR UI SESSION (when you log in to ServiceNow UI)         │
│ User: john.doe                                              │
│ Current Update Set: [Whatever you selected in the UI]      │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ SERAC OAUTH SESSION (API calls)                             │
│ User: oauth.service.account                                 │
│ Current Update Set: [Set via Update Set tools]             │
│ ← All Serac changes are tracked here                        │
└─────────────────────────────────────────────────────────────┘
```

### auto_switch — REQUIRED for tracking

- **`auto_switch=true` (DEFAULT)** — Update Set is set as current for the service account, all changes ARE tracked ✅
- **`auto_switch=false`** — Changes will NOT be tracked. Only use for queries/analysis, NEVER for development.

### Key points

- ✅ **Update Sets ARE created** — they exist in ServiceNow
- ✅ **Changes ARE tracked** when `auto_switch=true` — all Serac artifacts go into the Update Set automatically
- ❌ **NOT visible in YOUR UI session** unless you provide the `servicenow_username` parameter (which also makes it current for that UI user)
- ✅ **Deployment still works** — the Update Set can be exported/imported normally
- ⚠️ Don't disable `auto_switch` for development tasks

### When to use `servicenow_username`

Optional. Pass your ServiceNow username when you want the Update Set to also appear as current in your UI session — handy when you're working in the ServiceNow UI alongside Serac and want to see the same Update Set selected in both places. It does not affect tracking; tracking is governed by `auto_switch`.
