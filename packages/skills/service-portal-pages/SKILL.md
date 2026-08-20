---
name: service-portal-pages
description: The container side of Service Portal — the sp_portal → sp_page → sp_row → sp_column → sp_instance hierarchy, why widget options belong on the instance and not the widget, cloning pages, and what is theme (sp_theme, sp_brand, sp_css) rather than page.
license: Apache-2.0
compatibility: Designed for Serac and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_create_sp_page
  - snow_sp_page_manage
  - snow_sp_theme_manage
  - snow_create_sp_widget
  - snow_query_table
---

# Service Portal Pages and Themes

`widget-coherence` covers the inside of one widget — server script, client controller and HTML staying in
step. This covers everything around it: the page the widget sits on, and the theme the page renders in.

## The hierarchy

```
sp_portal      one portal. Has a URL suffix ("sp"), a homepage, and a THEME.
  └── sp_page       a page, addressed by its stable `id` → /sp?id=<id>
       └── sp_row        a row in the page layout
            └── sp_column    a column in that row (12-column grid)
                 └── sp_instance   ONE PLACEMENT of one widget, with its options
                      └── sp_widget    the widget definition, shared by every instance
```

The two things to hold onto:

**A page is not "in" a portal.** `sp_page` has no portal reference. A page is reachable from any portal
as `/<portal-suffix>?id=<page-id>`; what ties it to one is being that portal's homepage, or being linked
from a menu. Listing pages "for a portal" is therefore a convenience filter, not a containment query.

**`id` is the address, `sys_id` is the record.** `sp_page.id` is the human-readable stable key that
appears in the URL. Both are accepted by the management tool; the `id` is what a user will quote at you.

## Creating and placing

```javascript
await snow_create_sp_page({ id: "team_requests", title: "Team requests", public: false })

await snow_sp_page_manage({ action: "add_widget_instance", id: "team_requests",
                            widget_id: "widget-my-requests", column_sys_id: colSysId, order: 100 })
```

`public: true` means reachable without login — anonymous. It is the one field on this page worth a second
look before setting it.

`add_widget_instance` prefers `column_sys_id`. Omitting it attaches the instance to the page directly,
which renders but sits outside the grid; a page built that way cannot be laid out afterwards without
recreating the instances. Build rows and columns first when the layout matters.

## Widget options live on the instance

This is the single most useful fact in this guide. `sp_widget` is the definition — template, client
script, server script, CSS, and an option *schema*. It is shared by every page that uses it.
`sp_instance` is one placement, and it carries the **values**: title, glyph, colour, and everything in
the widget's option schema, stored as JSON in `sp_instance.options`.

So: "the widget shows the wrong list on the team page" is almost never a widget change. Editing the
widget changes it everywhere; editing the instance changes it on that page.

```javascript
// what a widget is actually configured as, per placement
await snow_query_table({ table: "sp_instance", query: "sp_widget.id=widget-my-requests",
                         fields: "sys_id,title,sp_column,options" })
```

Change the widget only when the behaviour is wrong for everyone. `widget-coherence` is the skill for
that, and it is a different blast radius.

## Cloning

```javascript
await snow_sp_page_manage({ action: "clone", id: "team_requests", new_id: "team_requests_v2",
                            title: "Team requests (draft)", copy_widget_instances: true })
```

`copy_widget_instances: true` (the default) duplicates the `sp_instance` rows with their options, which is
what makes the clone a working copy rather than an empty shell. Cloning is the safe way to change a live
page: clone, edit the clone, then point whatever links to the page at the new `id`.

`delete` **does not cascade**. Deleting a page leaves its `sp_instance` rows orphaned. List and remove
them first, or leave the page in place with `draft: true` — which is usually the better answer, because
a deleted page breaks every bookmark to it.

## What is theme, not page

Theme is a different axis from layout, and the split is not obvious:

| Belongs to the **page** | Belongs to the **theme** |
| --- | --- |
| which widgets, in which columns | header and footer widgets |
| per-instance titles and options | colour variables, fonts |
| page-level CSS (`sp_page.css`) | portal-wide CSS (`sp_css`) |
| `public`, `draft`, `internal` | logo, favicon, brand name (`sp_brand`) |

`snow_sp_theme_manage` covers `sp_theme` (definitions), `sp_css` (theme-scoped stylesheets), `sp_brand`
(per-portal logo/favicon/colours) and the `sp_portal.theme` pointer:

```javascript
// a per-tenant variant, editable without touching the source theme
await snow_sp_theme_manage({ action: "clone_theme", theme_name: "Base", name: "Acme", copy_css: true })

// branding is upserted per portal — an existing sp_brand row is patched, not duplicated
await snow_sp_theme_manage({ action: "update_branding", portal: portalSysId, logo: logoUrl,
                             primary_color: "#1f6feb", brand_name: "Acme Support" })

// and finally point the portal at it
await snow_sp_theme_manage({ action: "apply_theme_to_portal", portal: portalSysId, theme_name: "Acme" })
```

`apply_theme_to_portal` sets `sp_portal.theme` and takes effect on the next page load — no publish step,
no cache flush. That also means it is instantly visible to every user of that portal, so apply to a test
portal first.

If a colour change does not show up, the order to check is: the portal's theme pointer, then `sp_css`
rows on that theme, then the page's own `css`, then the widget's CSS. The most specific one wins, and
widget CSS overriding a theme variable is the usual culprit.

## Related

- `widget-coherence` — the inside of a widget, and the only place widget-level changes belong.
- `update-set-workflow` — `sp_page`, `sp_instance`, `sp_theme` and `sp_widget` are all captured.
