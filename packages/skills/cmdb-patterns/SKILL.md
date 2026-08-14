---
name: cmdb-patterns
description: Create ServiceNow CIs and cmdb_rel_ci relationships, walk upstream/downstream impact, detect orphan/stale CIs, and align discovered CIs with the proper sys_class_name hierarchy.
license: Apache-2.0
compatibility: Designed for Snow-Code and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_cmdb_search
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
    │   ├── cmdb_ci_service_auto
    │   └── cmdb_ci_service_discovered
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
| `cmdb_ci_service` | Business Services | service_classification, busines_criticality |
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

| Tool                          | Purpose                         |
| ----------------------------- | ------------------------------- |
| `snow_create_ci`              | Create new CI with proper class |
| `snow_cmdb_search`            | Search CIs with filters         |
| `snow_create_ci_relationship` | Create CI relationships         |
| `snow_impact_analysis`        | Analyze CI impact               |
| `snow_get_ci_details`         | Get full CI information         |
| `snow_run_discovery`          | Trigger discovery               |

### Example Workflow

```javascript
// 1. Search for existing CI
await snow_cmdb_search({
  ci_class: "cmdb_ci_server",
  query: "name=PROD-WEB-001",
  include_relationships: true,
})

// 2. Create new CI if not found (extra CI fields go in attributes)
await snow_create_ci({
  ci_class: "cmdb_ci_linux_server",
  name: "PROD-WEB-002",
  attributes: { ip_address: "10.0.1.101" },
  operational_status: "1",
})

// 3. Create relationship (relationship_type is a cmdb_rel_type sys_id,
//    look it up via snow_query_table on cmdb_rel_type)
await snow_create_ci_relationship({
  parent_ci: appSysId,
  child_ci: serverSysId,
  relationship_type: runsOnRelTypeSysId, // sys_id of "Runs on::Runs"
})

// 4. Impact analysis
await snow_impact_analysis({
  ci_sys_id: serverSysId,
  direction: "downstream",
  depth: 3,
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
