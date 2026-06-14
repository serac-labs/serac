---
name: domain-separation
description: Configure ServiceNow multi-tenant domain separation — domain hierarchy, sys_user_has_domain membership, domain-aware vs cross-domain queries, MSP tenant onboarding, and domain picker logic.
license: Apache-2.0
compatibility: Designed for Snow-Code and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_query_table
  - snow_execute_script
  - snow_artifact_manage
---

# Domain Separation for ServiceNow

Domain Separation enables multi-tenancy by partitioning data and processes between domains.

## Domain Architecture

```
TOP (Global)
    ├── Domain A (Customer 1)
    │   ├── Sub-domain A1
    │   └── Sub-domain A2
    └── Domain B (Customer 2)
        └── Sub-domain B1
```

## Key Tables

| Table                 | Purpose                |
| --------------------- | ---------------------- |
| `domain`              | Domain definitions     |
| `sys_user_has_domain` | User domain membership |
| `domain_path`         | Domain hierarchy paths |
| `sys_db_object`       | Table domain settings  |

## Domain Configuration (ES5)

### Create Domain

```javascript
// Create domain (ES5 ONLY!)
var domain = new GlideRecord("domain")
domain.initialize()

domain.setValue("name", "Acme Corp")
domain.setValue("description", "Domain for Acme Corporation")

// Parent domain (empty for top-level)
domain.setValue("parent", parentDomainSysId)

// Domain visibility
domain.setValue("active", true)

domain.insert()
```

### Domain-Aware Queries

```javascript
// Query respecting domain separation (ES5 ONLY!)
function getDomainAwareRecords(tableName, query) {
  var gr = new GlideRecord(tableName)

  // Domain separation is automatic when enabled
  // Records are filtered to user's visible domains

  if (query) {
    gr.addEncodedQuery(query)
  }
  gr.query()

  var records = []
  while (gr.next()) {
    records.push({
      sys_id: gr.getUniqueValue(),
      sys_domain: gr.getValue("sys_domain"),
      sys_domain_path: gr.getValue("sys_domain_path"),
    })
  }

  return records
}
```

### Cross-Domain Access

```javascript
// Access records across domains (requires elevated privileges) (ES5 ONLY!)
function getCrossdomainRecords(tableName) {
  var gr = new GlideRecord(tableName)

  // Disable domain separation for this query
  gr.setQueryReferences(false)

  // Query all domains
  gr.queryNoDomain()

  var records = []
  while (gr.next()) {
    records.push({
      sys_id: gr.getUniqueValue(),
      domain: gr.sys_domain.getDisplayValue(),
    })
  }

  return records
}
```

## User Domain Membership (ES5)

### Assign User to Domain

```javascript
// Add user to domain (ES5 ONLY!)
function addUserToDomain(userSysId, domainSysId, isPrimary) {
  // Check if already assigned
  var existing = new GlideRecord("sys_user_has_domain")
  existing.addQuery("user", userSysId)
  existing.addQuery("domain", domainSysId)
  existing.query()

  if (existing.next()) {
    return existing.getUniqueValue()
  }

  // Create assignment
  var assignment = new GlideRecord("sys_user_has_domain")
  assignment.initialize()
  assignment.setValue("user", userSysId)
  assignment.setValue("domain", domainSysId)
  assignment.setValue("primary", isPrimary)
  return assignment.insert()
}
```

### Get User's Domains

```javascript
// Get domains accessible to user (ES5 ONLY!)
function getUserDomains(userSysId) {
  var domains = []

  var membership = new GlideRecord("sys_user_has_domain")
  membership.addQuery("user", userSysId)
  membership.query()

  while (membership.next()) {
    var domain = membership.domain.getRefRecord()
    domains.push({
      sys_id: domain.getUniqueValue(),
      name: domain.getValue("name"),
      is_primary: membership.getValue("primary") === "true",
    })
  }

  return domains
}
```

## Domain-Separated Tables (ES5)

### Configure Table for Domain Separation

```javascript
// Enable domain separation on table (ES5 ONLY!)
// Note: This is typically done via UI, shown for reference

var tableConfig = new GlideRecord("sys_db_object")
if (tableConfig.get("name", "u_custom_table")) {
  // Enable domain separation
  tableConfig.setValue("domain_separated", true)

  // Domain separation type
  // 'simple' = records belong to one domain
  // 'containment' = records visible to parent domains
  tableConfig.setValue("domain_id_type", "simple")

  tableConfig.update()
}
```

### Create Record in Specific Domain

```javascript
// Create record in specific domain (ES5 ONLY!)
function createInDomain(tableName, data, domainSysId) {
  var gr = new GlideRecord(tableName)
  gr.initialize()

  // Set field values
  for (var field in data) {
    if (data.hasOwnProperty(field)) {
      gr.setValue(field, data[field])
    }
  }

  // Set domain
  gr.setValue("sys_domain", domainSysId)

  return gr.insert()
}
```

## Domain Picker (ES5)

### Get Available Domains for Picker

```javascript
// Get domains for domain picker widget (ES5 ONLY!)
function getDomainsForPicker() {
  var domains = []
  var userId = gs.getUserID()

  // Get user's accessible domains
  var membership = new GlideRecord("sys_user_has_domain")
  membership.addQuery("user", userId)
  membership.query()

  while (membership.next()) {
    var domain = membership.domain.getRefRecord()
    if (domain.getValue("active") === "true") {
      domains.push({
        sys_id: domain.getUniqueValue(),
        name: domain.getValue("name"),
        is_primary: membership.getValue("primary") === "true",
        is_current: domain.getUniqueValue() === gs.getSession().getCurrentDomainID(),
      })
    }
  }

  // Sort: primary first, then alphabetically
  domains.sort(function (a, b) {
    if (a.is_primary && !b.is_primary) return -1
    if (!a.is_primary && b.is_primary) return 1
    return a.name.localeCompare(b.name)
  })

  return domains
}
```

### Switch Current Domain

```javascript
// Switch user's current domain (ES5 ONLY!)
function switchDomain(domainSysId) {
  var session = gs.getSession()

  // Verify user has access
  var membership = new GlideRecord("sys_user_has_domain")
  membership.addQuery("user", gs.getUserID())
  membership.addQuery("domain", domainSysId)
  membership.query()

  if (!membership.next()) {
    gs.addErrorMessage("You do not have access to this domain")
    return false
  }

  // Switch domain
  session.setDomainID(domainSysId)
  gs.addInfoMessage("Switched to domain: " + membership.domain.getDisplayValue())

  return true
}
```

## Domain Visibility Rules (ES5)

### Check Domain Visibility

```javascript
// Check if record is visible in current domain (ES5 ONLY!)
function isRecordVisibleInDomain(tableName, recordSysId) {
  var gr = new GlideRecord(tableName)
  gr.addQuery("sys_id", recordSysId)
  gr.query()

  // If record is found, it's visible in current domain context
  return gr.hasNext()
}
```

### Get Domain Path

```javascript
// Get full domain hierarchy path (ES5 ONLY!)
function getDomainPath(domainSysId) {
  var path = []

  var domain = new GlideRecord("domain")
  if (!domain.get(domainSysId)) {
    return path
  }

  // Build path from current to root
  while (domain.isValidRecord()) {
    path.unshift({
      sys_id: domain.getUniqueValue(),
      name: domain.getValue("name"),
    })

    if (!domain.parent) break
    domain = domain.parent.getRefRecord()
  }

  return path
}
```

## MSP/Managed Services Patterns (ES5)

### Onboard New Tenant

```javascript
// Create new tenant domain with initial setup (ES5 ONLY!)
function onboardTenant(tenantData) {
  // Create domain
  var domain = new GlideRecord("domain")
  domain.initialize()
  domain.setValue("name", tenantData.name)
  domain.setValue("parent", tenantData.parentDomain || "")
  var domainSysId = domain.insert()

  // Create tenant admin user
  var adminUser = new GlideRecord("sys_user")
  adminUser.initialize()
  adminUser.setValue("user_name", tenantData.adminEmail)
  adminUser.setValue("email", tenantData.adminEmail)
  adminUser.setValue("first_name", tenantData.adminFirstName)
  adminUser.setValue("last_name", tenantData.adminLastName)
  var adminSysId = adminUser.insert()

  // Assign user to domain
  addUserToDomain(adminSysId, domainSysId, true)

  // Assign tenant admin role
  var role = new GlideRecord("sys_user_has_role")
  role.initialize()
  role.setValue("user", adminSysId)
  role.setValue("role", getTenantAdminRoleSysId())
  role.insert()

  return {
    domain_sys_id: domainSysId,
    admin_sys_id: adminSysId,
  }
}
```

## MCP Tool Integration

### Available Tools

| Tool                   | Purpose                                      |
| ---------------------- | -------------------------------------------- |
| `snow_query_table`     | Query domain-aware data                      |
| `snow_execute_script`  | Test domain scripts                          |
| `snow_artifact_manage` | Find domain configurations (`action='find'`) |

### Example Workflow

```javascript
// 1. Query domains
await snow_query_table({
  table: "domain",
  query: "active=true",
  fields: "name,parent,sys_id",
})

// 2. Get user domain memberships
await snow_query_table({
  table: "sys_user_has_domain",
  query: "user=user_sys_id",
  fields: "domain,primary",
})

// 3. Check domain-separated tables
await snow_query_table({
  table: "sys_db_object",
  query: "domain_separated=true",
  fields: "name,label,domain_id_type",
})
```

## Best Practices

1. **Plan Hierarchy** - Design domain structure before implementation
2. **Minimal Domains** - Only create necessary separation
3. **User Access** - Assign minimum required domains
4. **Testing** - Test with domain picker
5. **Global Data** - Keep shared data in TOP domain
6. **Performance** - Domain queries add overhead
7. **Documentation** - Document domain purposes
8. **ES5 Only** - No modern JavaScript syntax
