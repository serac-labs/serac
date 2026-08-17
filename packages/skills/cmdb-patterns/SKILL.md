---
name: cmdb-patterns
description: Create ServiceNow CIs and cmdb_rel_ci relationships, walk upstream/downstream impact, detect orphan/stale CIs, and align discovered CIs with the proper sys_class_name hierarchy.
license: Apache-2.0
compatibility: Designed for Serac and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_cmdb_search
  - snow_cmdb_identify_reconcile
  - snow_create_ci
  - snow_create_ci_relationship
  - snow_query_table
---

# CMDB Patterns for ServiceNow

The Configuration Management Database (CMDB) is the foundation of ServiceNow ITSM, tracking all Configuration Items (CIs) and their relationships.

## CMDB Architecture

### CI Class Hierarchy

```
cmdb (Base)
└── cmdb_ci (Configuration Item)
    ├── cmdb_ci_computer
    │   ├── cmdb_ci_server
    │   │   ├── cmdb_ci_linux_server
    │   │   ├── cmdb_ci_win_server
    │   │   └── cmdb_ci_unix_server
    │   └── cmdb_ci_pc_hardware
    ├── cmdb_ci_service
    │   ├── cmdb_ci_service_business
    │   ├── cmdb_ci_service_technical
    │   └── cmdb_ci_service_auto
    │       └── cmdb_ci_service_discovered
    ├── cmdb_ci_appl
    │   ├── cmdb_ci_app_server
    │   └── cmdb_ci_db_instance
    └── cmdb_ci_network_gear
        ├── cmdb_ci_netgear
        └── cmdb_ci_lb
```

### Key CI Tables

| Table             | Purpose           | Key Fields                                  |
| ----------------- | ----------------- | ------------------------------------------- |
| `cmdb_ci`         | Base CI table     | name, sys_class_name, operational_status    |
| `cmdb_ci_server`  | Servers           | ip_address, os, cpu_count, ram              |
| `cmdb_ci_service` | Service (base class — Business Service is `cmdb_ci_service_business`) | service_classification, busines_criticality |
| `cmdb_ci_appl`    | Applications      | version, install_directory                  |
| `cmdb_rel_ci`     | CI Relationships  | parent, child, type                         |

## Creating Configuration Items

### Basic CI Creation (ES5)

```javascript
// Create a new server CI
var ci = new GlideRecord("cmdb_ci_server")
ci.initialize()
ci.setValue("name", "PROD-WEB-001")
ci.setValue("ip_address", "10.0.1.100")
ci.setValue("os", "Linux Red Hat")
ci.setValue("os_version", "8.5")
ci.setValue("cpu_count", 8)
ci.setValue("ram", 32768)
ci.setValue("operational_status", 1) // Operational
ci.setValue("install_status", 1) // Installed
ci.setValue("used_for", "Production")
ci.setValue("owned_by", "sys_id_of_owner")
ci.setValue("support_group", "sys_id_of_group")
var sysId = ci.insert()
```

### CI with Discovery Source

```javascript
// CI from Discovery
var ci = new GlideRecord("cmdb_ci_linux_server")
ci.initialize()
ci.setValue("name", "discovered-server-001")
ci.setValue("discovery_source", "ServiceNow")
ci.setValue("first_discovered", new GlideDateTime())
ci.setValue("last_discovered", new GlideDateTime())
ci.setValue("ip_address", "10.0.2.50")

// Set classification
ci.setValue("classification", "Production")
ci.setValue("environment", "Production")

ci.insert()
```

## CI Relationships

### Relationship Types

| Type                     | Parent → Child   | Example                   |
| ------------------------ | ---------------- | ------------------------- |
| `Runs on::Runs`          | App → Server     | ERP runs on PROD-DB-01    |
| `Depends on::Used by`    | Service → App    | HR Service depends on SAP |
| `Contains::Contained by` | Cluster → Server | Cluster contains Node1    |
| `Hosted on::Hosts`       | VM → Hypervisor  | VM01 hosted on ESX01      |
| `Members::Member of`     | CI → Group       | Server member of Pool     |

### Creating Relationships (ES5)

```javascript
// Create relationship between CIs
function createCIRelationship(parentSysId, childSysId, relationType) {
  // Find relationship type
  var relType = new GlideRecord("cmdb_rel_type")
  relType.addQuery("name", relationType)
  relType.query()

  if (!relType.next()) {
    gs.error("Relationship type not found: " + relationType)
    return null
  }

  // Check if relationship already exists
  var existing = new GlideRecord("cmdb_rel_ci")
  existing.addQuery("parent", parentSysId)
  existing.addQuery("child", childSysId)
  existing.addQuery("type", relType.getUniqueValue())
  existing.query()

  if (existing.next()) {
    gs.info("Relationship already exists")
    return existing.getUniqueValue()
  }

  // Create new relationship
  var rel = new GlideRecord("cmdb_rel_ci")
  rel.initialize()
  rel.setValue("parent", parentSysId)
  rel.setValue("child", childSysId)
  rel.setValue("type", relType.getUniqueValue())
  return rel.insert()
}

// Usage
createCIRelationship(appSysId, serverSysId, "Runs on::Runs")
```

### Querying Relationships

```javascript
// Find all servers an application runs on
function getAppServers(appSysId) {
  var servers = []

  var rel = new GlideRecord("cmdb_rel_ci")
  rel.addQuery("parent", appSysId)
  rel.addQuery("type.name", "Runs on::Runs")
  rel.query()

  while (rel.next()) {
    var server = rel.child.getRefRecord()
    servers.push({
      sys_id: server.getUniqueValue(),
      name: server.getValue("name"),
      ip_address: server.getValue("ip_address"),
    })
  }

  return servers
}

// Find all dependencies of a service
function getServiceDependencies(serviceSysId) {
  var deps = []

  var rel = new GlideRecord("cmdb_rel_ci")
  rel.addQuery("parent", serviceSysId)
  rel.addQuery("type.name", "Depends on::Used by")
  rel.query()

  while (rel.next()) {
    deps.push({
      sys_id: rel.child.getUniqueValue(),
      name: rel.child.getDisplayValue(),
      class: rel.child.sys_class_name.toString(),
    })
  }

  return deps
}
```

## Impact Analysis

### Upstream/Downstream Analysis

```javascript
// Get all CIs affected by a CI outage (downstream impact)
function getDownstreamImpact(ciSysId, depth) {
  if (typeof depth === "undefined") depth = 3

  var impacted = []
  var processed = {}

  function traverse(sysId, currentDepth) {
    if (currentDepth > depth || processed[sysId]) return
    processed[sysId] = true

    var rel = new GlideRecord("cmdb_rel_ci")
    rel.addQuery("child", sysId)
    rel.query()

    while (rel.next()) {
      var parentId = rel.parent.toString()
      if (!processed[parentId]) {
        impacted.push({
          sys_id: parentId,
          name: rel.parent.getDisplayValue(),
          depth: currentDepth,
        })
        traverse(parentId, currentDepth + 1)
      }
    }
  }

  traverse(ciSysId, 1)
  return impacted
}

// Get all CIs this CI depends on (upstream dependencies)
function getUpstreamDependencies(ciSysId, depth) {
  if (typeof depth === "undefined") depth = 3

  var dependencies = []
  var processed = {}

  function traverse(sysId, currentDepth) {
    if (currentDepth > depth || processed[sysId]) return
    processed[sysId] = true

    var rel = new GlideRecord("cmdb_rel_ci")
    rel.addQuery("parent", sysId)
    rel.query()

    while (rel.next()) {
      var childId = rel.child.toString()
      if (!processed[childId]) {
        dependencies.push({
          sys_id: childId,
          name: rel.child.getDisplayValue(),
          depth: currentDepth,
        })
        traverse(childId, currentDepth + 1)
      }
    }
  }

  traverse(ciSysId, 1)
  return dependencies
}
```

### Business Service Impact

```javascript
// Find all business services impacted by a CI
function getImpactedServices(ciSysId) {
  var services = []
  var processed = {}

  function findServices(sysId) {
    if (processed[sysId]) return
    processed[sysId] = true

    // Check if this CI is a service
    var ci = new GlideRecord("cmdb_ci")
    if (ci.get(sysId)) {
      if (ci.sys_class_name.toString().indexOf("cmdb_ci_service") === 0) {
        services.push({
          sys_id: sysId,
          name: ci.getValue("name"),
          criticality: ci.getValue("busines_criticality"),
        })
      }
    }

    // Traverse upstream
    var rel = new GlideRecord("cmdb_rel_ci")
    rel.addQuery("child", sysId)
    rel.query()

    while (rel.next()) {
      findServices(rel.parent.toString())
    }
  }

  findServices(ciSysId)
  return services
}
```

## CMDB Health & Data Quality

### Orphan CI Detection

```javascript
// Find CIs without relationships
function findOrphanCIs(ciClass) {
  var orphans = []

  var ci = new GlideRecord(ciClass || "cmdb_ci")
  ci.addQuery("operational_status", 1) // Operational only
  ci.query()

  while (ci.next()) {
    var sysId = ci.getUniqueValue()

    // Check for any relationships
    var rel = new GlideRecord("cmdb_rel_ci")
    rel.addQuery("parent", sysId).addOrCondition("child", sysId)
    rel.setLimit(1)
    rel.query()

    if (!rel.hasNext()) {
      orphans.push({
        sys_id: sysId,
        name: ci.getValue("name"),
        class: ci.getValue("sys_class_name"),
      })
    }
  }

  return orphans
}
```

### Stale CI Detection

```javascript
// Find CIs not updated by discovery
function findStaleCIs(daysOld) {
  if (typeof daysOld === "undefined") daysOld = 30

  var stale = []
  var cutoff = new GlideDateTime()
  cutoff.addDaysLocalTime(-daysOld)

  var ci = new GlideRecord("cmdb_ci")
  ci.addQuery("operational_status", 1)
  ci.addQuery("last_discovered", "<", cutoff)
  ci.addNotNullQuery("last_discovered")
  ci.query()

  while (ci.next()) {
    stale.push({
      sys_id: ci.getUniqueValue(),
      name: ci.getValue("name"),
      last_discovered: ci.getValue("last_discovered"),
    })
  }

  return stale
}
```

## MCP Tool Integration

### Available CMDB Tools

| Tool                           | Purpose                                                              |
| ------------------------------ | -------------------------------------------------------------------- |
| `snow_cmdb_identify_reconcile` | Insert/update CIs through IRE — identifies before it writes          |
| `snow_create_ci`               | Create new CI with proper class (writes straight to the class table) |
| `snow_cmdb_search`             | Search CIs with filters                                              |
| `snow_create_ci_relationship`  | Create CI relationships                                              |
| `snow_impact_analysis`         | Analyze CI impact                                                    |
| `snow_get_ci_details`          | Get full CI information                                              |
| `snow_run_discovery`           | Trigger discovery                                                    |

### Write CIs through IRE, not by searching first

Searching for a CI and creating it when the search misses is the pattern that fills a CMDB with
duplicates: it loses to any variance in name, IP or serial, and the second write carries no record of where
the data came from. The Identification and Reconciliation Engine exists to do that matching properly.
`snow_cmdb_identify_reconcile` posts the payload to `/api/now/identifyreconcile`, so each class's identifier
rules run against it, an existing CI is updated instead of duplicated, reconciliation rules decide whether
this data source may overwrite each attribute, and the write is recorded in Source [`sys_object_source`].

`snow_create_ci` and `snow_update_ci` write to a class table directly, which skips all of that. Use them for
a CI you know is not in the CMDB and do not need attributed to a source. Ignore `snow_reconcile_ci` despite
the name — it PUTs your fields onto base `cmdb_ci` and echoes its `reconciliation_rule` argument back
untouched; no rule runs.

One payload can also carry `relations` between its own items, where `type` is a name field value from CI
Relationship Type [`cmdb_rel_type`] and `parent`/`child` are indexes into `items`. That is how a source that
discovers a host and the application on it submits both in a single call.

`dry_run` commits nothing, but permission is per tool rather than per argument, so it still counts as a
write: on a production instance the dry run needs the same `__confirmProd` as the real call.

### Example Workflow

```javascript
// 1. Dry run first: IRE reports what it would do and commits nothing. On a
//    400-CI payload this is the only way to see the verdict before taking it.
await snow_cmdb_identify_reconcile({
  data_source: "ServiceNow", // must be a choice on cmdb_ci.discovery_source
  dry_run: true,
  items: [
    {
      className: "cmdb_ci_linux_server",
      values: { name: "PROD-WEB-002", ip_address: "10.0.1.101", serial_number: "VMW-42-8A" },
    },
  ],
})
// Read items[0].operation — INSERT, UPDATE, NO_CHANGE, UPDATE_WITH_UPGRADE,
// UPDATE_WITH_DOWNGRADE, UPDATE_WITH_SWITCH or DELETE — and
// items[0].identificationAttempts for the identifier rule that matched.

// 2. Same payload without dry_run commits it. IRE answers HTTP 200 even when
//    individual items fail, so check data.items[i].errors, which the tool
//    surfaces as a failure rather than a success.
const ire = await snow_cmdb_identify_reconcile({
  data_source: "ServiceNow",
  items: [
    {
      className: "cmdb_ci_linux_server",
      values: { name: "PROD-WEB-002", ip_address: "10.0.1.101", serial_number: "VMW-42-8A" },
    },
  ],
})
// sys_id of the CI IRE inserted or matched: ire.data.items[0].sysId

// 3. Create relationship (relationship_type is a cmdb_rel_type sys_id,
//    look it up via snow_query_table on cmdb_rel_type)
await snow_create_ci_relationship({
  parent_ci: appSysId,
  child_ci: serverSysId,
  relationship_type: runsOnRelTypeSysId, // sys_id of "Runs on::Runs"
})

// 4. Impact analysis (the CI argument is ci_id; there is no direction parameter).
//    include_services is left off on purpose: the business_services key it fills
//    is not impact — see the csdm-modeling skill.
await snow_impact_analysis({
  ci_id: serverSysId,
  depth: 3,
  include_services: false,
})
```

## Best Practices

1. **Use Correct CI Class** - Always use most specific class (cmdb_ci_linux_server, not cmdb_ci)
2. **Maintain Relationships** - CIs without relationships have limited value
3. **Discovery Alignment** - Align manual CIs with discovery patterns
4. **Operational Status** - Keep status current (Operational, Retired, etc.)
5. **Unique Identifiers** - Use serial_number, asset_tag for uniqueness
6. **Service Mapping** - Connect CIs to business services
7. **Regular Cleanup** - Archive retired CIs, remove orphans
