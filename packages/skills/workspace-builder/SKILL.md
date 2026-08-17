---
name: workspace-builder
description: Build ServiceNow App Engine Studio applications — sys_scope creation, scoped tables, sys_aw_workspace with lists/forms, the sys_ux_* record chain behind UI Builder workspaces, data brokers, and application export readiness checks. Never create a UI Builder page by inserting a sys_ux_page row.
license: Apache-2.0
compatibility: Designed for Serac and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_query_table
  - snow_execute_script
  - snow_artifact_manage
  - snow_update_set_manage
  - snow_create_ux_experience
  - snow_create_ux_app_config
  - snow_create_ux_page_macroponent
  - snow_create_ux_page_registry
  - snow_create_ux_app_route
  - snow_update_ux_app_config_landing_page
  - snow_create_complete_workspace
  - snow_validate_workspace_configuration
  - snow_discover_all_workspaces
  - snow_uib_discover
  - snow_uib_page_manage (action='create', 'add_element', 'delete')
  - snow_create_uib_client_state
  - snow_create_uib_data_broker
  - snow_configure_uib_data_broker
---

# App Engine Studio & Workspace Builder for ServiceNow

App Engine Studio (AES) enables low-code application development with custom workspaces.

## AES Architecture

```
Application (sys_scope)
    ├── Tables & Forms
    ├── Workflows
    ├── Workspaces (sys_aw_workspace)
    │   ├── Lists
    │   ├── Forms
    │   └── Dashboards
    └── Portals
```

## Key Tables

| Table                  | Purpose                                                      |
| ---------------------- | ------------------------------------------------------------ |
| `sys_scope`            | Application scope                                             |
| `sys_app`              | Application record                                            |
| `sys_aw_workspace`     | Agent Workspace definition                                    |
| `sys_ux_experience`    | Next Experience workspace — top of the UI Builder chain       |
| `sys_ux_app_config`    | Workspace settings; links to the experience                   |
| `sys_ux_macroponent`   | Page content and custom components                            |
| `sys_ux_page_registry` | Registers a macroponent as a page of an app config            |
| `sys_ux_app_route`     | URL slug that reaches a registered page                       |
| `sys_ux_page`          | UI Builder page rows — read them, never insert one directly   |

## Application Development (ES5)

### Create Scoped Application

```javascript
// Create scoped application (ES5 ONLY!)
var app = new GlideRecord("sys_scope")
app.initialize()

// Basic info
app.setValue("name", "IT Asset Tracker")
app.setValue("scope", "x_myco_asset_track")
app.setValue("short_description", "Track IT assets across the organization")
app.setValue("version", "1.0.0")

// Vendor
app.setValue("vendor", "My Company")
app.setValue("vendor_prefix", "x_myco")

// License
app.setValue("licensable", true)

app.insert()
```

### Create Application Table

```javascript
// Create table in scoped app (ES5 ONLY!)
function createAppTable(scope, tableDef) {
  var table = new GlideRecord("sys_db_object")
  table.initialize()

  table.setValue("name", scope + "_" + tableDef.name)
  table.setValue("label", tableDef.label)
  table.setValue("super_class", tableDef.extends || "task")

  // Scope assignment
  table.setValue("sys_scope", getAppSysId(scope))

  // Options
  table.setValue("is_extendable", tableDef.extendable || false)
  table.setValue("create_access_controls", true)

  table.insert()

  // Create fields
  if (tableDef.fields) {
    for (var i = 0; i < tableDef.fields.length; i++) {
      createField(scope + "_" + tableDef.name, tableDef.fields[i])
    }
  }

  return table.getUniqueValue()
}

// Example
createAppTable("x_myco_asset_track", {
  name: "asset_item",
  label: "Asset Item",
  extends: "cmdb_ci",
  fields: [
    { name: "u_purchase_date", label: "Purchase Date", type: "glide_date" },
    { name: "u_warranty_end", label: "Warranty End", type: "glide_date" },
    { name: "u_assigned_user", label: "Assigned User", type: "reference", reference: "sys_user" },
  ],
})
```

## Workspace Configuration (ES5)

### Create Custom Workspace

```javascript
// Create workspace (ES5 ONLY!)
var workspace = new GlideRecord("sys_aw_workspace")
workspace.initialize()

workspace.setValue("name", "asset_tracker_workspace")
workspace.setValue("title", "Asset Tracker")
workspace.setValue("description", "Workspace for IT asset management")

// Primary table
workspace.setValue("primary_table", "x_myco_asset_track_asset_item")

// URL
workspace.setValue("url", "asset-tracker")

// Branding
workspace.setValue("icon", "laptop")
workspace.setValue("color", "#2E7D32")

// App scope
workspace.setValue("sys_scope", appScopeSysId)

// Features
workspace.setValue("agent_assist_enabled", false)
workspace.setValue("contextual_side_panel_enabled", true)

workspace.insert()
```

### Configure Workspace Lists

```javascript
// Create workspace list (ES5 ONLY!)
function createWorkspaceList(workspaceSysId, listDef) {
  var list = new GlideRecord("sys_aw_list")
  list.initialize()

  list.setValue("workspace", workspaceSysId)
  list.setValue("name", listDef.name)
  list.setValue("table", listDef.table)

  // Filter
  list.setValue("filter", listDef.filter || "")

  // Columns
  list.setValue("columns", listDef.columns.join(","))

  // Sorting
  if (listDef.orderBy) {
    list.setValue("order_by", listDef.orderBy)
    list.setValue("order_by_desc", listDef.orderDesc || false)
  }

  // Grouping
  if (listDef.groupBy) {
    list.setValue("group_by", listDef.groupBy)
  }

  list.insert()

  return list.getUniqueValue()
}

// Example lists
createWorkspaceList(workspaceSysId, {
  name: "My Assets",
  table: "x_myco_asset_track_asset_item",
  filter: "u_assigned_user=javascript:gs.getUserID()",
  columns: ["number", "name", "u_purchase_date", "u_warranty_end", "state"],
})

createWorkspaceList(workspaceSysId, {
  name: "Expiring Warranties",
  table: "x_myco_asset_track_asset_item",
  filter: "u_warranty_endBETWEENjavascript:gs.daysAgoStart(0)@javascript:gs.daysAgoEnd(-30)",
  columns: ["number", "name", "u_assigned_user", "u_warranty_end"],
  orderBy: "u_warranty_end",
})
```

## UI Builder Pages and Workspaces

The sections above write ordinary tables from a background script. This one does not work that way.

A Next Experience workspace is a graph of linked records, not a record. Inserting one row on its own —
`new GlideRecord("sys_ux_page")`, which is what earlier versions of this guide told you to do — succeeds,
returns a sys_id, and leaves you an orphan: no experience owns the page, no app config registers it, no route
reaches it. The row itself gives no hint that anything is missing. A lone `sys_ux_macroponent` insert is the
same story.

Two tools in this server will POST a `sys_ux_page` row through the Table API, and neither builds the rest of
the graph. `snow_artifact_manage (action='create', type='uib_page')` writes `name`, `title` and
`description` and stops. `snow_github_deploy` maps both `target_type: "uib_page"` and `"sys_ux_page"` onto
the same table, defaults `upsert` to `true`, and inserts a fresh row whenever its identifier matches nothing
— so a mistyped `target_identifier` produces this same orphan without saying so. Both report success. Use
`snow_artifact_manage` on UI Builder pages for `get`, `find`, `export` and `verify`, not `create`, and give
`snow_github_deploy` a `target_sys_id` or an identifier you have already read back off the instance.

The `sys_ux_page` tools in the `workspace` and `ui-builder` domains otherwise only read and delete. The one
exception is `snow_uib_page_manage (action='create')`, which does not touch the table at all — see *Where
scripting stops*.

### The record chain

| Step | Table                        | Tool                                       | Carries forward       |
| ---- | ---------------------------- | ------------------------------------------ | --------------------- |
| 1    | `sys_ux_experience`          | `snow_create_ux_experience`                | `experience_sys_id`   |
| 2    | `sys_ux_app_config`          | `snow_create_ux_app_config`                | `app_config_sys_id`   |
| 3    | `sys_ux_macroponent`         | `snow_create_ux_page_macroponent`          | `macroponent_sys_id`  |
| 4    | `sys_ux_page_registry`       | `snow_create_ux_page_registry`             | `sys_name`            |
| 5    | `sys_ux_app_route`           | `snow_create_ux_app_route`                 | `name`                |
| 6    | `sys_ux_app_config` (update) | `snow_update_ux_app_config_landing_page`   | —                     |

The order is enforced, not advisory. Step 2 refuses if step 1's experience cannot be read back. Step 4 GETs
both `sys_ux_app_config` and `sys_ux_macroponent` before it writes and refuses if either is missing. Step 5
joins back to step 4 through `page_sys_name` — per step 5's own schema that value is the registry's
`sys_name` **string**, not its sys_id. Step 6 is the one people skip: step 5's own response tells you to run
it, and until you do the app config has no `landing_page`.

Step 5 returns two keys that look interchangeable and are not. Its `name` input is the route name that
becomes the URL slug; its `route` is the path, which it defaults to `/<name>`. Step 6 wants the **name**:
`snow_update_ux_app_config_landing_page` takes `route_name` and PATCHes it straight into `landing_page`. Hand
it step 5's `route` and you set the landing page to `/home` where the route is called `home`.

Step 1 needs only a name. It derives `path` from that name (lowercased, spaces to hyphens) unless you pass
one, defaults `homepage` to `home`, and resolves the app shell itself by querying `sys_ux_macroponent` for
`name=uib_app_shell^category=app_shell`, falling back to
`name=x_snc_app_shell_uib_app_shell^category=app_shell`. If neither row is on the instance you get
`Could not find appShellUI macroponent (uib_app_shell) on this instance` before anything is written.

### The Builder Toolkit dependency

Step 1 is not a Table API write. It POSTs to `/api/sn_uibtk_api/buildertoolkit/experience`, a scoped
endpoint that appears in no reachable ServiceNow REST documentation — the scope name reads like UI
Builder's own toolkit, but treat that as a guess, not a contract, and expect nothing about it to survive a
family release. Steps 2 through 6 write through the ordinary `/api/now/table/...` API.

If the `sn_uibtk_api` scope is not on the instance, step 1 fails with
`Builder Toolkit API not available - UI Builder plugin may not be installed` and names the plugin
`com.snc.ui_builder_toolkit`. That is the tool working correctly, not a broken tool.

**The trap is step 2.** Before it writes anything, `snow_create_ux_app_config` GETs
`/api/sn_uibtk_api/buildertoolkit/experience` to confirm the experience exists, and swallows every failure
from that GET. On an instance without the toolkit the check 404s and the tool reports
`Experience '<sys_id>' not found or not accessible`. The sys_id in that message is fine; the toolkit is
missing. Check step 1's result and the plugin before you go re-copying sys_ids.

### Roles

`sn-roles.manifest.json` in the MCP package records an ACL probe of a live instance, and create permission
across the chain is not uniform:

| Table                  | Create needs one of                                                |
| ---------------------- | ------------------------------------------------------------------ |
| `sys_ux_app_config`    | `delegated_developer`, `ui_builder_admin`                          |
| `sys_ux_macroponent`   | `delegated_developer`, `ui_builder_admin`                          |
| `sys_ux_page_registry` | `canvas_admin`, `maint`, `ui_builder_admin`, `uxframework_designer` |
| `sys_ux_app_route`     | `ui_builder_admin`                                                 |
| `sys_ux_data_broker`   | `ui_builder_admin`                                                 |
| `sys_ux_page_element`  | `ui_builder_admin`, `uxframework_designer`                         |

So a `delegated_developer` clears steps 2 and 3 and then fails at step 4, with three records already
written. `ui_builder_admin` covers the whole chain; the manifest lists `admin` as sufficient everywhere.

When an ACL does reject a write, the failure is quieter than you expect. This server's HTTP client
re-throws ServiceNow error bodies as `ServiceNow: <message>` and drops the body's `detail` whenever
`message` is present — and `detail` is usually the half that says which table and which operation. If a
step fails and the message tells you nothing, query the table for the row rather than guessing.

### This server ships three different chains

They do not agree with each other. Know which one you called.

- **The six steps above.** Experience, app config, macroponent, page registry, route, landing page. No
  lists. Every record is one you can see and verify.
- **`snow_create_complete_workspace`.** Experience, app config, then a page created through the toolkit's
  `/page` endpoint, then — only if you pass `tables` — one `sys_ux_list_menu_config`, one
  `sys_ux_list_category` per table and one `sys_ux_list` per category. It never writes a
  `sys_ux_page_registry` or `sys_ux_app_route` row, because the toolkit `/page` call is what is supposed to
  produce the screen and route server-side. Whether it did is something you check, not something the tool
  reports.
- **`snow_create_workspace`** (the `ui-builder` domain, not `workspace`). Experience, app config, route,
  lists — and no page at all, so nothing lands on anything.

Prefer the six steps when the workspace has to be right, because you can inspect every row. Reach for
`snow_create_complete_workspace` when you were going to open UI Builder afterwards anyway. Do not build
something a user will open with `snow_create_workspace`.

None of the three read a URL back from the instance. `snow_create_ux_app_route` prints
`/now/experience<route>`, `snow_create_complete_workspace` prints `/now/<path>`, and `snow_create_workspace`
prints `<instance_url>/workspace/<path>` — all assembled inside the tool from strings you passed in. For a
path the instance actually knows, call `snow_discover_all_workspaces`, which reads the experience list back
from the toolkit — but read its output, not its status. When the toolkit call fails it does not fail the
tool: it pushes `{type: "UX Experience", error: "Builder Toolkit API not available"}` into the list and
returns success. On a toolkit-less instance that is a green result with no experiences in it.

One more route writer, and its name will mislead you. `snow_create_uib_page_registry`, in the `ui-builder`
domain, does not touch `sys_ux_page_registry` at all: it POSTs to `sys_ux_app_route` with a `page` column,
plus `roles`, `public` and `active`. That is a different shape from step 5, which links through `app_config`
and `page_sys_name`. Two tools, one table, two incompatible ideas of how a route finds its page — do not mix
them in one workspace, and do not reach for this one as step 4 because of what it is called.

### Where scripting stops

The chain leaves you five rows and an update that reference each other the way the tools intend. Whether
that adds up to a page UI Builder will open is not something this repo demonstrates and not something the
reachable documentation settles — verify it by opening the experience, not by reading a success payload.
What the chain definitely does not give you is a page with anything on it.

`snow_create_ux_page_macroponent` writes whatever object you pass as `composition` into that column as a
JSON string, and when you pass nothing it writes `{"layout":"single-column","components":[]}`. That default
is the tool's placeholder. Nothing in this repo establishes that it — or any composition you write by hand —
is a structure the UI Builder runtime renders, and this guide is not going to invent a format for you.

**Lay pages out in UI Builder.** Search the **All** menu for *UI Builder*, open the experience, open the
page. That is the supported editor for the component tree and it writes the composition the runtime expects.
Script the chain; author the page.

`snow_uib_page_manage (action='add_element')` looks like the way around that, and it is honest about what it
does: it POSTs `page`, `component`, `position` and a JSON `properties` string to `sys_ux_page_element`, a
real table with real ACLs. What is unproven is the connection. Its `page_id` is a `sys_ux_page` sys_id, and
the six-step chain never creates a `sys_ux_page` — so there is no demonstrated path from a chain-built page
to an element added this way. Do not build a layout on it without opening the result in UI Builder first.

`snow_uib_page_manage (action='create')` is the one candidate for supplying that missing `sys_ux_page`. It
takes an `experience_id` and a name and POSTs to the toolkit's `/page` endpoint — the same call
`snow_create_complete_workspace` makes — then returns the macroponent, screen and route ids the toolkit hands
back. So the server does the creating, which is why it can plausibly produce a real page and a route at once
where the Table API route cannot. Two caveats before you lean on it: it needs the toolkit, and the ids it
returns are the toolkit's, so confirm a `sys_ux_page` row actually exists before feeding one to
`add_element`. The verdict does not change — open it in UI Builder before you build on it.

The one macroponent internal this server edits through the toolkit rather than the Table API is client
state: `snow_create_uib_client_state` GETs `/api/sn_uibtk_api/buildertoolkit/macroponent`, appends to the
`state_properties` it finds there, and PATCHes the whole array back. It needs the macroponent sys_id. The
read-modify-write is unguarded — no version check, no optimistic lock — so two agents adding state to the
same page concurrently are the classic setup for a lost update. That outcome is read off the code, not
observed on an instance — add state from one caller at a time and you never have to find out.

### Verifying the chain

`snow_validate_workspace_configuration` with `workspace_type: "ux_experience"` does not check the parts that
break. It scores four things: the experience's `active` flag, whether any `sys_ux_app_config` has
`experience_assoc` pointing at it, whether that config has a `list_config_id`, and whether any
`sys_ux_page_property` rows reference it. It never reads `sys_ux_macroponent`, `sys_ux_page_registry` or
`sys_ux_app_route`, so a workspace with no page and no route can come back `passed`.

Check the last two yourself:

```javascript
// The page must be registered against the app config from step 2
await snow_query_table({
  table: "sys_ux_page_registry",
  query: "app_config=" + appConfigSysId,
  fields: ["sys_name", "macroponent", "active"],
})

// ...and a route must name that same sys_name
await snow_query_table({
  table: "sys_ux_app_route",
  query: "app_config=" + appConfigSysId,
  fields: ["name", "route", "page_sys_name", "active"],
})
```

Both should return a row, and the route's `page_sys_name` should equal the registry's `sys_name`.

Read that check with the same suspicion as the data-broker fields below. `sys_ux_page_registry.app_config`,
`sys_ux_page_registry.sys_name` and `sys_ux_app_route.page_sys_name` are the columns the step 4 and step 5
executors write; nothing in this repo confirms them against ServiceNow's own documentation, and the
`sys_ux_*` tables are not in the reachable docs. So an empty result has two readings — the row is missing,
or the column name is wrong — and `sysparm_query` will not tell you which, because an unrecognised field in
an encoded query does not raise an error. Before you trust an empty result, query the same table on
`sys_created_onONToday@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()` with no `fields` list and
read the raw row the chain just wrote. If it is there under different column names, the chain worked and
this recipe is what is out of date.

Do not use `snow_uib_discover` as that check. Its `pages` action reads `sys_ux_page`, which the chain never
creates, and its `routes` action reads `sys_ux_page_registry` filtered by `experience=<sys_id>` — while the
chain links the registry through `app_config`, not `experience`. Neither one filters on anything your six
steps wrote, so whatever it returns says nothing about your workspace. Use it to look at pages that were
authored in UI Builder, and `snow_discover_all_workspaces` to enumerate experiences.

One `snow_query_table` quirk matters when you go looking at a macroponent: `truncate_output` defaults to
`true`, and it cuts to 200 characters with `... [truncated, N chars total]` appended. Which strings it cuts
depends on the field's name. If the name contains one of its large-content substrings — `script`,
`description`, `content`, `body`, `json`, `html`, `xml`, `template`, `comments` and about ten more —
anything past 200 characters is cut. Every other field gets to 400 first. `composition` is not on that list
so it survives to 400, and a real one is far longer than that; `short_description` matches on `description`
and so gets cut at 200. Pass `truncate_output: false` whenever you intend to compare values, or you will
compare two truncations and conclude they match.

### Data resources (data brokers)

Same boundary, same rule. Do not create data brokers from a background script on `sys_ux_data_broker`. The
field set earlier versions of this guide used there — `type: "script"` plus a `script` column — is not one
anything in this repo confirms.

Two tools write the table:

- `snow_create_uib_data_broker` POSTs `page`, `name`, `table`, `query` and `limit`, plus `fields`
  (comma-joined) and `order_by` when you pass them.
- `snow_configure_uib_data_broker` PATCHes an existing row with any of `query`, `refresh_interval`,
  `enable_caching`, `cache_duration`, `parameters` and `filters` — the last two JSON-stringified.

Those column names are this server's assumption about `sys_ux_data_broker`, not something the repo verifies
against a real broker. Do not treat a success response as proof the fields landed: read the row straight
back with `snow_query_table` and compare it against a broker created in UI Builder on the same instance. If
the shapes differ, author in UI Builder and use these tools only to read.

Broker script bodies and the GraphQL broker query shape belong to the `ui-builder-patterns` guide. They are
server-side and ES5, like everything else in this file.

Deletion is the one operation here that walks the graph: `snow_uib_page_manage (action='delete')` with
`delete_dependencies` left at its default first deletes the `sys_ux_page_element`, `sys_ux_data_broker`,
`sys_ux_client_script` and `sys_ux_app_route` rows whose `page` points at the page, then the page itself.
Passing `delete_dependencies: false` leaves all of them behind — more orphans, in the table you were trying
to clean up.

## Application Deployment (ES5)

### Create Update Set

```javascript
// Create update set for app deployment (ES5 ONLY!)
function createAppUpdateSet(appName, description) {
  var updateSet = new GlideRecord("sys_update_set")
  updateSet.initialize()
  updateSet.setValue("name", appName + " - " + new GlideDateTime().getDate())
  updateSet.setValue("description", description)
  updateSet.setValue("application", getAppSysId(appName))
  updateSet.setValue("state", "in progress")
  return updateSet.insert()
}
```

### Export Application

```javascript
// Prepare app for export (ES5 ONLY!)
function prepareAppExport(appScope) {
  // Validate all components
  var issues = []

  // Check for missing dependencies
  var dependency = new GlideRecord("sys_app_dependency")
  dependency.addQuery("app.scope", appScope)
  dependency.query()

  while (dependency.next()) {
    if (!isDependencyInstalled(dependency.getValue("dependency"))) {
      issues.push("Missing dependency: " + dependency.dependency.getDisplayValue())
    }
  }

  // Validate update sets
  var updateSet = new GlideRecord("sys_update_set")
  updateSet.addQuery("application.scope", appScope)
  updateSet.addQuery("state", "in progress")
  updateSet.query()

  while (updateSet.next()) {
    issues.push("Open update set: " + updateSet.getValue("name"))
  }

  return {
    ready: issues.length === 0,
    issues: issues,
  }
}
```

## MCP Tool Integration

The `tools:` list in this file's frontmatter is the full set. There is deliberately no second list here: a
summary table used to sit in this spot and it drifted out of date the moment the UI Builder chain was added,
which is a worse failure than having one list.

### Example Workflow

```javascript
// 1. Query applications
await snow_query_table({
  table: "sys_scope",
  query: "scopeSTARTSWITHx_",
  fields: "name,scope,version,vendor",
})

// 2. Find app tables
await snow_query_table({
  table: "sys_db_object",
  query: "nameSTARTSWITHx_myco",
  fields: "name,label,super_class",
})

// 3. Get workspace configs
await snow_query_table({
  table: "sys_aw_workspace",
  query: "sys_scope.scopeSTARTSWITHx_",
  fields: "name,title,primary_table,url",
})
```

## Best Practices

1. **Naming Conventions** - Consistent prefixes
2. **Scoped Apps** - Use scope isolation
3. **Reusable Components** - Modular design
4. **Data Brokers** - Efficient data fetching
5. **Workspace Design** - User-focused layouts
6. **Testing** - ATF tests for apps
7. **Documentation** - App documentation
8. **ES5 Only** - No modern JavaScript syntax
