---
name: asset-management
description: Manage ServiceNow hardware assets, software licenses, and lifecycle states on alm_hardware/alm_license — license allocation, CMDB-to-asset linking, warranty tracking, inventory aggregation (HAM/SAM).
license: Apache-2.0
compatibility: Designed for Snow-Code and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_create_asset
  - snow_cmdb_search
  - snow_query_table
  - snow_artifact_manage
---

# Asset Management for ServiceNow

Asset Management tracks hardware and software assets throughout their lifecycle.

## Asset Architecture

```
Asset (alm_asset)
    ├── Hardware Asset (alm_hardware)
    │   └── Consumable (alm_consumable)
    └── License (alm_license)

CI (cmdb_ci) ←→ Asset (alm_asset)
    ↑
    One CI can have multiple assets over time
```

## Key Tables

| Table            | Purpose             |
| ---------------- | ------------------- |
| `alm_asset`      | Base asset table    |
| `alm_hardware`   | Hardware assets     |
| `alm_license`    | Software licenses   |
| `alm_consumable` | Consumable assets   |
| `ast_contract`   | Asset contracts     |
| `cmdb_ci`        | Configuration items |

## Hardware Assets (ES5)

### Create Hardware Asset

```javascript
// Create hardware asset (ES5 ONLY!)
var asset = new GlideRecord("alm_hardware")
asset.initialize()

// Basic info
asset.setValue("display_name", "Dell Latitude 5520")
asset.setValue("asset_tag", "ASSET-" + generateAssetTag())
asset.setValue("serial_number", "SN123456789")

// Model
asset.setValue("model", getModelSysId("Dell Latitude 5520"))
asset.setValue("model_category", getModelCategorySysId("Laptop"))

// Status and substatus
asset.setValue("install_status", 1) // Installed
asset.setValue("substatus", "in_use")

// Assignment
asset.setValue("assigned_to", userSysId)
asset.setValue("assigned", new GlideDateTime())
asset.setValue("location", locationSysId)
asset.setValue("department", departmentSysId)

// Financial
asset.setValue("cost", 1299.99)
asset.setValue("cost_center", costCenterSysId)

// Dates
asset.setValue("purchase_date", "2024-01-15")
asset.setValue("warranty_expiration", "2027-01-15")

// Link to CI if exists
asset.setValue("ci", cmdbCiSysId)

asset.insert()
```

### Asset Lifecycle States

```javascript
// Asset install_status values
var ASSET_STATUS = {
  INSTALLED: 1, // In use
  ON_ORDER: 2, // Ordered, not received
  IN_STOCK: 6, // In inventory
  IN_TRANSIT: 7, // Being shipped
  IN_MAINTENANCE: 8, // Under repair
  RETIRED: 9, // End of life
  DISPOSED: 10, // Disposed of
}

// Transition asset status (ES5 ONLY!)
function transitionAssetStatus(assetSysId, newStatus, notes) {
  var asset = new GlideRecord("alm_hardware")
  if (!asset.get(assetSysId)) {
    return { success: false, message: "Asset not found" }
  }

  var currentStatus = parseInt(asset.getValue("install_status"), 10)

  // Validate transition
  var validTransitions = {
    2: [6, 7], // On Order -> In Stock, In Transit
    7: [6, 1], // In Transit -> In Stock, Installed
    6: [1, 7, 9], // In Stock -> Installed, In Transit, Retired
    1: [8, 6, 9], // Installed -> In Maintenance, In Stock, Retired
    8: [1, 6, 9], // In Maintenance -> Installed, In Stock, Retired
    9: [10], // Retired -> Disposed
  }

  if (!validTransitions[currentStatus] || validTransitions[currentStatus].indexOf(newStatus) === -1) {
    return {
      success: false,
      message: "Invalid transition from " + currentStatus + " to " + newStatus,
    }
  }

  // Update status
  asset.setValue("install_status", newStatus)

  // Handle specific transitions
  if (newStatus === 1) {
    asset.setValue("installed", new GlideDateTime())
  } else if (newStatus === 9) {
    asset.setValue("retired", new GlideDateTime())
    asset.setValue("assigned_to", "")
  } else if (newStatus === 10) {
    asset.setValue("disposed", new GlideDateTime())
  }

  // Add work note
  if (notes) {
    asset.work_notes = notes
  }

  asset.update()

  return { success: true, asset_tag: asset.getValue("asset_tag") }
}
```

## Software Licenses (ES5)

### Create License Record

```javascript
// Create software license (ES5 ONLY!)
var license = new GlideRecord("alm_license")
license.initialize()

// Basic info
license.setValue("display_name", "Microsoft Office 365 E3")
license.setValue("product", getProductSysId("Microsoft Office 365"))
license.setValue("license_type", "per_user") // per_user, per_device, site, enterprise

// Quantities
license.setValue("rights", 500) // Total licenses purchased
license.setValue("used", 0) // Will be calculated
license.setValue("remaining", 500) // Will be calculated

// Dates
license.setValue("start_date", "2024-01-01")
license.setValue("end_date", "2024-12-31")

// Cost
license.setValue("cost", 25000.0)
license.setValue("cost_per_unit", 50.0)

// Vendor
license.setValue("vendor", vendorSysId)
license.setValue("contract", contractSysId)

license.insert()
```

### License Allocation

```javascript
// Allocate license to user (ES5 ONLY!)
function allocateLicense(licenseSysId, userSysId) {
  var license = new GlideRecord("alm_license")
  if (!license.get(licenseSysId)) {
    return { success: false, message: "License not found" }
  }

  // Check availability
  var remaining = parseInt(license.getValue("remaining"), 10)
  if (remaining <= 0) {
    return { success: false, message: "No licenses available" }
  }

  // Check if user already has this license
  var existing = new GlideRecord("alm_entitlement_user")
  existing.addQuery("licensed_by", licenseSysId)
  existing.addQuery("user", userSysId)
  existing.query()

  if (existing.hasNext()) {
    return { success: false, message: "User already has this license" }
  }

  // Create entitlement
  var entitlement = new GlideRecord("alm_entitlement_user")
  entitlement.initialize()
  entitlement.setValue("licensed_by", licenseSysId)
  entitlement.setValue("user", userSysId)
  entitlement.setValue("allocated", new GlideDateTime())
  entitlement.insert()

  // Update license counts
  updateLicenseCounts(licenseSysId)

  return {
    success: true,
    message: "License allocated",
    entitlement: entitlement.getUniqueValue(),
  }
}

function updateLicenseCounts(licenseSysId) {
  var license = new GlideRecord("alm_license")
  if (!license.get(licenseSysId)) return

  // Count allocations
  var ga = new GlideAggregate("alm_entitlement_user")
  ga.addQuery("licensed_by", licenseSysId)
  ga.addAggregate("COUNT")
  ga.query()

  var used = 0
  if (ga.next()) {
    used = parseInt(ga.getAggregate("COUNT"), 10)
  }

  var rights = parseInt(license.getValue("rights"), 10)

  license.setValue("used", used)
  license.setValue("remaining", rights - used)
  license.update()
}
```

## Asset Discovery Integration (ES5)

### Match Discovered CI to Asset

```javascript
// Match discovered CI to existing asset (ES5 ONLY!)
function matchCIToAsset(ciSysId) {
  var ci = new GlideRecord("cmdb_ci_computer")
  if (!ci.get(ciSysId)) {
    return null
  }

  var serialNumber = ci.getValue("serial_number")
  var assetTag = ci.getValue("asset_tag")

  // Try to find matching asset
  var asset = new GlideRecord("alm_hardware")

  // Match by serial number first
  if (serialNumber) {
    asset.addQuery("serial_number", serialNumber)
    asset.query()
    if (asset.next()) {
      return linkAssetToCI(asset, ci)
    }
  }

  // Match by asset tag
  if (assetTag) {
    asset = new GlideRecord("alm_hardware")
    asset.addQuery("asset_tag", assetTag)
    asset.query()
    if (asset.next()) {
      return linkAssetToCI(asset, ci)
    }
  }

  // No match - create new asset
  return createAssetFromCI(ci)
}

function linkAssetToCI(asset, ci) {
  asset.setValue("ci", ci.getUniqueValue())
  asset.update()

  ci.setValue("asset", asset.getUniqueValue())
  ci.update()

  return asset.getUniqueValue()
}

function createAssetFromCI(ci) {
  var asset = new GlideRecord("alm_hardware")
  asset.initialize()
  asset.setValue("display_name", ci.getDisplayValue())
  asset.setValue("serial_number", ci.getValue("serial_number"))
  asset.setValue("asset_tag", ci.getValue("asset_tag"))
  asset.setValue("model", ci.getValue("model_id"))
  asset.setValue("ci", ci.getUniqueValue())
  asset.setValue("install_status", 1)

  var assetSysId = asset.insert()

  ci.setValue("asset", assetSysId)
  ci.update()

  return assetSysId
}
```

## Asset Reports (ES5)

### Asset Inventory Summary

```javascript
// Get asset inventory summary (ES5 ONLY!)
function getAssetInventorySummary() {
  var summary = {
    by_status: {},
    by_category: {},
    by_location: {},
    total_value: 0,
  }

  // By status
  var ga = new GlideAggregate("alm_hardware")
  ga.addAggregate("COUNT")
  ga.addAggregate("SUM", "cost")
  ga.groupBy("install_status")
  ga.query()

  while (ga.next()) {
    var status = ga.install_status.getDisplayValue()
    summary.by_status[status] = {
      count: parseInt(ga.getAggregate("COUNT"), 10),
      value: parseFloat(ga.getAggregate("SUM", "cost")) || 0,
    }
    summary.total_value += summary.by_status[status].value
  }

  // By model category
  ga = new GlideAggregate("alm_hardware")
  ga.addAggregate("COUNT")
  ga.groupBy("model_category")
  ga.query()

  while (ga.next()) {
    var category = ga.model_category.getDisplayValue() || "Uncategorized"
    summary.by_category[category] = parseInt(ga.getAggregate("COUNT"), 10)
  }

  // By location
  ga = new GlideAggregate("alm_hardware")
  ga.addQuery("install_status", 1) // Only installed
  ga.addAggregate("COUNT")
  ga.groupBy("location")
  ga.query()

  while (ga.next()) {
    var location = ga.location.getDisplayValue() || "Unknown"
    summary.by_location[location] = parseInt(ga.getAggregate("COUNT"), 10)
  }

  return summary
}
```

## MCP Tool Integration

### Available Tools

| Tool                   | Purpose                                     |
| ---------------------- | ------------------------------------------- |
| `snow_query_table`     | Query assets and licenses                   |
| `snow_cmdb_search`     | Search CMDB for CIs                         |
| `snow_execute_script`  | Test asset scripts                          |
| `snow_artifact_manage` | Find asset configurations (`action: find`)  |

### Example Workflow

```javascript
// 1. Query hardware assets
await snow_query_table({
  table: "alm_hardware",
  query: "install_status=1",
  fields: "asset_tag,display_name,assigned_to,location,model",
})

// 2. Check license compliance
await snow_execute_script({
  script: `
        var license = new GlideRecord('alm_license');
        license.addQuery('remainingRELATIVELT@integer@0');
        license.query();
        while (license.next()) {
            gs.info('Over-allocated: ' + license.display_name);
        }
    `,
})

// 3. Find assets nearing warranty expiration
await snow_query_table({
  table: "alm_hardware",
  query: "warranty_expirationBETWEENjavascript:gs.beginningOfToday()@javascript:gs.daysAgoEnd(-30)",
  fields: "asset_tag,display_name,warranty_expiration,assigned_to",
})
```

## Best Practices

1. **Asset Tags** - Unique, scannable identifiers
2. **Lifecycle Tracking** - Track all state changes
3. **CI Linking** - Connect assets to CMDB
4. **License Compliance** - Monitor allocation vs rights
5. **Warranty Tracking** - Alert before expiration
6. **Financial Accuracy** - Maintain cost data
7. **Regular Audits** - Verify physical inventory
8. **ES5 Only** - No modern JavaScript syntax
