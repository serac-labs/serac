---
name: form-list-layout
description: Configure what a form and a list look like — sys_ui_form, sys_ui_section and sys_ui_element for forms; sys_ui_list, sys_ui_list_element and sys_ui_related_list for lists; sys_filter for saved filters. Views, why a field must exist in the dictionary first, and what snow_create_menu really writes.
license: Apache-2.0
compatibility: Designed for Serac and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_create_form_layout
  - snow_create_form_section
  - snow_add_form_field
  - snow_create_list_view
  - snow_create_list_layout
  - snow_add_list_column
  - snow_create_related_list
  - snow_create_saved_filter
  - snow_create_menu
  - snow_create_menu_item
  - snow_discover_table_fields
---

# Form and List Layout

`ui-actions-policies` covers behaviour on a form — what happens when a field changes. This covers the
shape of it: which fields are on the form, in what order, in which sections, and what the list shows.
Nothing covered lists at all before this guide.

## Views come first

Almost every table in this guide has a `view` field, and it is the thing to decide before anything else.

A **view** is a named layout for one table. The empty string `""` is the **default view** — the one
everyone gets. `"mobile"`, `"ess"` and any custom name are separate layouts on the same table, and
editing one changes nothing about the others.

```javascript
await snow_add_list_column({ table: "incident", element: "u_root_cause" })   // default view: everyone
await snow_create_list_layout({ table: "incident", view: "mobile", columns: [...] })  // mobile only
```

Getting this wrong is the most common way to "change nothing" — the edit landed on a view nobody opens —
and the most common way to break a form for the whole company, which is the same mistake pointed the
other way.

## The field must exist first

`sys_ui_element` and `sys_ui_list_element` hold a *field name as a string*. Neither the platform nor
these tools check that the column exists in `sys_dictionary`. Placing a field that is not there produces
a layout row that silently renders nothing.

Check before you place:

```javascript
await snow_discover_table_fields({ table: "incident" })
```

The same applies to dot-walked columns on a list (`caller_id.department`): the path has to resolve or the
column comes back blank.

## Forms

```
sys_ui_form       the form layout for (table, view)  — the container
  └── sys_ui_section    a section on it, with a caption and a position
       └── sys_ui_element   one field, with a position inside the section
```

Build outward from the container:

```javascript
const form = await snow_create_form_layout({ name: "Incident", table: "incident", type: "standard" })
const sec = await snow_create_form_section({ name: "Root cause", table: "incident",
                                             caption: "Root cause", position: 2 })
await snow_add_form_field({ section_sys_id: sec.sys_id, element: "u_root_cause", position: 1 })
```

`type` on the layout is `standard`, `related_list` or `split`. `position` is an ordering hint, not an
index — leave gaps (100, 200, 300) so a later insertion does not mean renumbering.

A field can appear in only one section of a view. Adding it to a second does not move it; it produces a
duplicate row and an unpredictable render.

## Lists

Two different things share the word "list":

| | Table | What it is |
| --- | --- | --- |
| **List layout** | `sys_ui_list` + `sys_ui_list_element` | which columns the table shows |
| **Related list** | `sys_ui_related_list` | which child tables appear *under a form* |

### Columns

```javascript
// one column onto the default layout
await snow_add_list_column({ table: "incident", element: "u_root_cause", position: 4, width: 120 })

// or a whole layout at once
await snow_create_list_layout({ table: "incident", view: "", columns: [
  { element: "number", position: 1 }, { element: "short_description", position: 2 },
] })
```

`snow_create_list_view` is the third one and does something different: it creates a **named** view
(`sys_ui_list`) with a comma-joined field list and an optional default filter, so users can switch into a
curated column set. It does not touch the default view.

### Related lists

```javascript
await snow_create_related_list({ name: "Child incidents", parent_table: "incident",
                                 related_table: "incident", relationship_field: "parent_incident" })
```

A related list is addressed by the **field on the child table that points at the parent**. That is what
`relationship_field` is. Omit it and ServiceNow looks for the conventional reference, which is right for
`task.parent` and wrong for anything custom. Related lists are per (parent table, view) — a related list
added to the default view does not appear on `mobile`.

### Saved filters

```javascript
await snow_create_saved_filter({ name: "My open P1s", table: "incident",
                                 filter: "active=true^priority=1^assigned_to=javascript:gs.getUserID()",
                                 roles: "itil", order: 100 })
```

`filter` is an encoded query, the same syntax `snow_query_table` takes. Leave `user` empty for a global
filter; set it for a personal one. `roles` restricts who sees it in the dropdown — it is visibility, not
security. The rows the filter returns are still whatever the ACLs allow.

## Navigation: read this before using `snow_create_menu`

**Both navigation tools write `sys_app_module`.** `snow_create_menu` does not create an application menu
— an application menu is a `sys_app_application` record. It creates a module, exactly like
`snow_create_menu_item` does, and calls it a menu.

What that means in practice:

- To hang items under an existing menu, use `snow_create_menu_item` with the application menu's sys_id
  as `parent`. This works and is the normal case.
- To create a genuinely new application menu, neither tool does it. Create the `sys_app_application`
  record directly (`snow_record_manage`) and pass its sys_id as `parent`.
- `snow_create_menu` produces a parentless module. It is not harmful, and it is not a menu.

```javascript
await snow_create_menu_item({ title: "Open P1s", parent: appMenuSysId, link_type: "list",
                              table: "incident", order: 200 })
```

`link_type` is `list`, `new`, `detail` or `home`. A `list` module obeys the table's default view unless
its own filter says otherwise, which ties navigation back to the first section of this guide.

## Everything here is configuration

`sys_ui_form`, `sys_ui_section`, `sys_ui_element`, `sys_ui_list`, `sys_ui_list_element`,
`sys_ui_related_list`, `sys_filter` and `sys_app_module` are all captured in an update set. Start one
before you change a layout — see `update-set-workflow` — or the change is unrepeatable on the next
instance.

## Related

- `ui-actions-policies` — behaviour on the form, once the fields are on it.
- `update-set-workflow` — mandatory before any of this.
- `blast-radius` — what else is configured against the table you are about to reshape.
