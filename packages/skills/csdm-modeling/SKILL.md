---
name: csdm-modeling
description: Pick the right ServiceNow service class under the Common Service Data Model — business service, service offering, application service, business application — and point the CMDB tools at it without creating the records CSDM tells customers to migrate away from.
license: Apache-2.0
compatibility: Designed for Serac and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_query_table
  - snow_discover_table_fields
  - snow_create_ci
  - snow_update_ci
  - snow_get_ci_details
  - snow_get_ci_relationships
  - snow_create_ci_relationship
  - snow_cmdb_search
---

# CSDM Modeling

The Common Service Data Model is ServiceNow's prescription for **which table a service record goes in**.
It is not a plugin, not a field, and not something you switch on. It is a set of classes that already
exist in your CMDB, plus guidance about which one a given record belongs to. Get the class wrong and
nothing fails today — the record saves, the tool returns `created: true`, and the bill arrives later.
ServiceNow's own migration guidance is blunt about the trade: you can keep using non-conforming tables,
but "you might not get the full benefit of your products", and moving CIs to the right table afterwards
does not move the reports, business rules and references already pointing at them, while "during
migration, you lose all customized or base-system attributes that are not in the same table hierarchy".

This guide is about the model. `cmdb-patterns` is about the tools — relationship mechanics, orphan and
stale detection, the `cmdb_rel_type` lookup. Read that one for those.

## The default mistake

Asked to "create a business service", an agent reaches for `snow_create_ci` with
`ci_class: "cmdb_ci_service"`. That produces a record in the base Service class — precisely the record
ServiceNow publishes a migration path *off* of. A dedicated Business Service class exists, the guidance
to move records into it is published, and a large share of long-lived instances are carrying exactly
that backlog right now.

**Never create a record in `cmdb_ci_service`.** It is a parent class. Records belong in one of its
children.

## The classes, and what belongs in each

| What you are modelling | Table | Platform label |
| --- | --- | --- |
| A service published to business users | `cmdb_ci_service_business` | Business Service |
| A service published to service owners, underpinning business services | `cmdb_ci_service_technical` | Technology Management Service (formerly Technical Service) |
| A specific consumable variant of a service, with commitments | `service_offering` | Service Offering |
| A running, mapped instance of an application and its infrastructure | `cmdb_ci_service_auto` | Service Instance (formerly Application Service) |
| The same, created by the Manual service population method | `cmdb_ci_service_discovered` | Mapped Application Service |
| The conceptual application the business talks about | `cmdb_ci_business_app` | Business Application |
| The installed software instance on a host | `cmdb_ci_appl` | Application |

Two things about that list:

- `cmdb_ci_service_discovered` sits **under** `cmdb_ci_service_auto`, not beside it. Both hold
  application services; what separates them is population method, not a different kind of record, so do
  not model "discovered" versus "manual" as two peer classes. ServiceNow's table reference documents no
  parent for either table, so confirm the parentage on the instance with the `sys_db_object` query below
  before you lean on it. The docs are loose about the labels here too — the CMDB table reference calls
  `cmdb_ci_service_auto` Service Instance and `cmdb_ci_service_discovered` Mapped Application Service,
  while the ITOM documentation calls `cmdb_ci_service_discovered` the Service Instance table.
- There is no `cmdb_application` table, and no `cmdb_ci_application` table. `cmdb_ci_appl` is the
  Application class. If you find yourself typing a class name that reads like English, stop and check
  it against `sys_db_object` first.

CSDM 5 renamed several labels without renaming the tables. A colleague, a KB article and the form
header may all say "Application Service" while the table is still `cmdb_ci_service_auto`. Table names
are the stable identity; labels are not.

## The domains

CSDM 5 groups its tables into seven domains. These are a conceptual grouping in ServiceNow's
documentation — there is no domain field on a CI, and you never set one. They are worth knowing only
because they tell you which *kind* of record a table is for:

| Domain | What lives there |
| --- | --- |
| Foundation | Base referential data pointed at from every other domain — companies, locations, departments, groups, users, contracts |
| Ideation & Strategy | Ideas and concepts for new services, in Strategic Portfolio Management |
| Design & Planning | Where architects and product owners design digital products — business capabilities, business applications |
| Build & Integration | What development teams produce during systems and agile development |
| Service Delivery | The end-to-end delivery system: infrastructure, technologies, technical services, application services |
| Service Consumption | What consumers request and subscribe to: business services and their offerings, request catalog |
| Manage Portfolio | A layer over the other domains rather than a set of CI classes of its own |

Older material — CSDM 3 and 4 — uses a different, shorter list with names like *Sell/Consume* and
*Manage Technical Services*. The rows did not move; the labels did. When a document and your instance
disagree about a domain name, that is a version gap, not an error. Anchor on the table.

## The order operations must happen in

Service records reference each other, and two of the links are reference fields rather than
`cmdb_rel_ci` rows. Build downward:

1. **Business Service** — `cmdb_ci_service_business`. Nothing depends on it existing first except
   everything below.
2. **Service Offering** — `service_offering`, with its `parent` field set to the business service's
   `sys_id`. This is a **reference field on the offering**, not a CI relationship. Creating a
   `cmdb_rel_ci` row between a service and its offering instead of setting `parent` leaves the offering
   orphaned from the SPM and CSDM views, which read `parent`. Several fields — owner, business
   criticality, delivery manager — are inherited from the parent service when the offering is first
   added, so set `parent` before you set those, or you will overwrite your own values.
3. **Application Service** — `cmdb_ci_service_auto` (or `cmdb_ci_service_discovered` if a mapping
   process owns it). This is the layer that actually touches infrastructure.
4. **Relationships** — `cmdb_rel_ci` from the offering or service down to the application service, and
   from the application service down to infrastructure CIs. The dependent, higher record is the
   `parent` side of the relationship; the thing being used is the `child`. Look the type's `sys_id` up
   in `cmdb_rel_type` first — `snow_create_ci_relationship` wants a sys_id, not a name. See
   `cmdb-patterns` for that lookup.

CSDM prescribes specific relationship types between these layers, and the prescription has changed
between CSDM versions. Do not take a type name from memory or from a blog. Read the types your
instance actually has and pick from those:

```
snow_query_table({
  table: "cmdb_rel_type",
  fields: ["name", "parent_descriptor", "child_descriptor"],
  limit: 200,
})
```

### `svc_ci_assoc` is derived — read it, do not write it

Which CIs belong to an application service is materialised in `svc_ci_assoc` (Service Configuration
Item Association), with `service_id` pointing at the application service and `ci_id` at the CI. Query
it to answer "what is in this service" cheaply. Do not write to it. ServiceNow documents it as the
binding between an application service and the CIs that are part of it: a derived view, not an input
you author. Model membership in `cmdb_rel_ci` and read `svc_ci_assoc`.

## Class choices agents get wrong

**Business Application is not a Business Service.** `cmdb_ci_business_app` is the conceptual
application — one record, business owner, cost centre, lifecycle. A business service is what is
delivered to a user. "Workday" is a business application; "Payroll" is a business service. ServiceNow's
CSDM-to-CMDB mapping is explicit that business application data belongs in `cmdb_ci_business_app` and
not in the application table. Pointing a task straight at a business application instead of at the
service or offering it consumes is against CSDM guidance rather than against any platform rule —
nothing stops you, and nothing warns you.

**Service Offering is not a classification of a service.** It is its own table. `cmdb_ci_service` also
carries a `service_classification` field, and it is tempting to read that as the class. It is not — it
is a functional label that survives from before the dedicated classes existed. ServiceNow's CMDB table
reference documents five choices for it: *Application Service*, *Technical Service*, *Service
Offering*, *Shared Service*, *Billable Service*. Note what is missing: there is no *Business Service*
choice, and a record classified *Service Offering* is still not a `service_offering` record. Choices on
this field are commonly customised, so read them off the instance rather than trusting any list,
including this one:

```
snow_query_table({
  table: "sys_choice",
  query: "name=cmdb_ci_service^element=service_classification^inactive=false",
  fields: ["value", "label", "sequence"],
})
```

**`busines_criticality` is spelled with one `s`.** The column on `cmdb_ci_service` is
`busines_criticality` — a platform typo that has never been corrected, so it is now the field name, and
ServiceNow's own API reference prints it that way in its example service payloads.
`business_criticality` is a different string and, on most instances, not a column on that table. This
matters more than it sounds: an encoded query naming a column that does not exist does **not** error by
default. With `glide.invalid_query.returns_no_rows` at its default of `false`, the invalid condition is
dropped and the query returns rows based on whatever is left — often the whole table. A filter you
misspelled returns confident, wrong data. Verify field names before querying on them:

```
snow_discover_table_fields({ table_name: "cmdb_ci_service" })
```

**Class-specific fields do not exist on the parent.** `busines_criticality` is on `cmdb_ci_service`,
not on `cmdb_ci`. Anything you write to the base table that the base table does not define is not
stored. See the tool notes below — several tools in this server write to base tables.

## Reading the model off an unfamiliar instance

Before modelling anything, find out where this install actually is. Two queries answer that.

**Does the class exist, and what does it extend?**

```
snow_query_table({
  table: "sys_db_object",
  query: "nameSTARTSWITHcmdb_ci_service^ORname=service_offering^ORname=cmdb_ci_business_app",
  fields: ["name", "label", "super_class"],
})
```

`super_class` is a reference to another `sys_db_object` row, so it comes back as a sys_id, not a table
name. Resolve it with a second query on `sys_id=<value>`, or pass `display_value: true` to get the
readable label instead.

**Where are the records?** Query the base class and group by what you get back. Because a query on
`cmdb_ci_service` returns every class beneath it, counting "rows in `cmdb_ci_service`" tells you
nothing on its own — you have to read `sys_class_name`:

```
snow_query_table({
  table: "cmdb_ci_service",
  fields: ["sys_id", "name", "sys_class_name"],
  limit: 500,
})
```

To count only the records genuinely stuck in the base class, filter on it explicitly:
`query: "sys_class_name=cmdb_ci_service"`.

An instance with 400 records still sitting in the base class and none in
`cmdb_ci_service_business` has not started its migration, and dropping one correctly-classed record
into it creates a two-model instance nobody asked for. Say that to the user before you create
anything: the right answer is usually "migrate the existing 400 first", which is a reclassification
job in the UI, not an API job.

## What this means for the CMDB tools in this server

The tools here are thin wrappers over `/api/now/table/...`. That has consequences that a generic
ServiceNow guide would not warn you about.

**`snow_create_ci` performs no class validation at all.** `ci_class` is interpolated straight into the
POST URL, so the class you pass *is* the table the record lands in, and a class that does not exist on
the instance fails at the HTTP layer with the Table API's own message rather than a helpful one.
Everything beyond `name`, `operational_status` and `asset_tag` goes in `attributes`. Do not try to
reclassify by putting `sys_class_name` in `attributes` — the record is created in the table you POST
to, and a mismatched `sys_class_name` is how you get a row that queries cannot find in either class.

It also inserts through the plain Table API, which means it does **not** go through the CMDB
Identification and Reconciliation Engine. Nothing dedupes. Search before you create. If this server
offers a tool that posts to `/api/now/identifyreconcile`, prefer it for anything Discovery or an
integration also populates — `snow_reconcile_ci` is not that tool despite its name, see the tool notes
below.

**`snow_cmdb_search` maps `ci_type: "service"` to `cmdb_ci_service`.** That is the base class, and
because a query on a parent table returns rows of every class beneath it, you *do* get business
services, offerings and application services back. What you do not get is a way to tell them apart
except by reading `sys_class_name` on each result, which the tool does return. Two further catches:
the field list is fixed, so no service-specific column (`busines_criticality`, `service_classification`,
`parent`) is ever in the payload; and if the mapped table answers HTTP 400, the tool silently retries
against `cmdb_ci` while still reporting the original class in `table_searched`. Treat `table_searched`
as the table it *meant* to search. That fallback is not hypothetical: the same mapping sends
`ci_type: "application"` to `cmdb_ci_application`, which on a base instance is not a table at all — the
Application class is `cmdb_ci_appl` — so every `application` search degrades into a search of all of
`cmdb_ci` while still reporting `cmdb_ci_application` as the table searched.

For anything class-specific, skip it and query the class directly:

```
snow_query_table({
  table: "cmdb_ci_service_business",
  query: "operational_status=1",
  fields: ["sys_id", "name", "busines_criticality", "service_classification", "owned_by"],
})
```

**`snow_discover_table_fields` does not walk up the class tree.** It reads `sys_dictionary` with
`name=<table>`, which returns only the columns *declared on that table*. Run it on
`cmdb_ci_service_business` and you get a nearly empty list, because `name`, `operational_status`,
`busines_criticality` and almost everything else is declared on an ancestor. That is not evidence the
fields are missing. Ask the parent classes too — `cmdb_ci_service`, then `cmdb_ci` — and union the
results. The `extends` value it reports is unreliable for the same class of reason: the underlying
call does not request display values, so a reference field arrives as an object and the tool reads a
property that is not there. Use the `sys_db_object` query above when you need the real parent.

**`snow_get_ci_details` always queries `cmdb_ci`.** Services are found — they extend it — but you get
the columns `cmdb_ci` defines, so none of the service fields appear. It also matches a non-sys_id
`ci_id` as `name=<value>` with a limit of 1, and service names repeat across classes constantly
("Payroll" as a business service and as an application service is normal). Pass a sys_id, or accept
that you may be reading a different record than you meant.

**`snow_update_ci` takes `ci_class` and uses it — `snow_reconcile_ci` does not.** `snow_update_ci`
PUTs to `/api/now/table/<ci_class>/<sys_id>`, which is what you want. `snow_reconcile_ci` PUTs to
`/api/now/table/cmdb_ci/<sys_id>` regardless of what the record is, so class-specific fields in
`source_data` do not reach the record while the tool still reports `reconciled: true`. Use
`snow_update_ci` with the record's real class for anything below `cmdb_ci`. After any write, read the
record back and confirm the field is set; a success object from these tools means the HTTP call
succeeded, not that your column landed.

**`snow_impact_analysis` returns a `business_services` key that is not impact.** It fills that key by
querying `cmdb_ci_service` filtered on a column named `cmdb_ci`. Service-to-CI membership is not stored
in a column on the service — it lives in `cmdb_rel_ci` and, derived, in `svc_ci_assoc`. On a default
instance that filter is dropped as an invalid condition and you get an arbitrary slice of the service
table back. **Do not report `business_services` to a user as the services affected by a change.**

The `affected_cis` half is a real traversal of `cmdb_rel_ci`, but look at what it hands back before you
quote it. Each entry is `{sys_id, relationship_type, depth}` — no name, no class, so you are reading
every CI yourself anyway, and the sys_id is the only field of the three you can trust. The relationship
read does not ask for display values, so reference fields arrive as `{link, value}` objects:
`relationship_type` is that raw object rather than a type name, and the comparison that decides which
end of the row to follow can never match a string, which is why the walk only ever climbs toward
parents. `depth` is computed as `4 - <remaining depth>`, with the default baked into the constant, so
levels are labelled correctly only when you call the tool at its default `depth: 3` — and since
`impact.directly_affected` counts entries at depth 1 and `impact.risk_level` is derived from that count,
both go wrong with them. At depth 3 the numbers mean what they say. At any other depth, ignore them and
count sys_ids yourself.

`snow_get_ci_impact` is honest about being shallow — one hop of `cmdb_rel_ci` where your CI is the
`child` — but its `include_services` argument does nothing.

To answer "which services does this CI support", walk it yourself:

```
snow_get_ci_relationships({ ci_sys_id: "<ci sys_id>" })
```

then take the parent side of each row and read its `sys_class_name` — a `cmdb_rel_ci` row carries the
two sys_ids and their display values but not their classes, so deciding which parents are services costs
a second read — and repeat upward from the ones that are not. Or read
`svc_ci_assoc` on `ci_id=<sys_id>` for application-service membership, which is the cheap answer when
Service Mapping is in use. State which method you used — they do not return the same set, and the
difference is exactly the part of the model that has not been built yet.

## Where services attach to work records

Task records carry the service links, not the other way round. On `incident` (and `task` generally):
`business_service` references the service, `service_offering` references the offering, and `cmdb_ci`
references the affected configuration item. All three appear on a base `incident` in ServiceNow's own
documented payloads. Older or heavily customised instances may not have all of them; check with
`snow_discover_table_fields({ table_name: "incident" })` before you write to one.

CSDM guidance is offering first, then CI, because an offering already identifies the service it belongs
to. Filling `business_service` by hand and then picking an offering that belongs to a different service
leaves a record that contradicts itself. Nothing on the platform validates that pair, so the
contradiction survives until a report trips over it.
