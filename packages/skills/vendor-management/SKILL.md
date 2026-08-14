---
name: vendor-management
description: Manage ServiceNow vendors and contracts — core_company vendor records, ast_contract with renewal alerts, ast_contract_sla performance tracking, vendor_risk_assessment scoring, and vendor scorecards.
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

# Vendor Management for ServiceNow

Vendor Management tracks suppliers, contracts, performance, and risk.

## Vendor Architecture

```
Vendor (core_company)
    ├── Contracts (ast_contract)
    │   ├── Contract Terms
    │   └── SLAs
    ├── Contacts
    ├── Assessments
    └── Performance Metrics
```

## Key Tables

| Table                    | Purpose           |
| ------------------------ | ----------------- |
| `core_company`           | Vendors/Companies |
| `ast_contract`           | Contracts         |
| `ast_contract_sla`       | Contract SLAs     |
| `vendor_risk_assessment` | Risk assessments  |
| `procurement_vendor`     | Vendor details    |

## Vendors (ES5)

### Create Vendor

```javascript
// Create vendor (ES5 ONLY!)
var vendor = new GlideRecord("core_company")
vendor.initialize()

// Basic info
vendor.setValue("name", "Acme Technology Solutions")
vendor.setValue("vendor", true)

// Contact info
vendor.setValue("phone", "+1-555-123-4567")
vendor.setValue("email", "vendor@acmetech.com")
vendor.setValue("website", "https://www.acmetech.com")

// Address
vendor.setValue("street", "456 Vendor Ave")
vendor.setValue("city", "San Francisco")
vendor.setValue("state", "CA")
vendor.setValue("zip", "94105")
vendor.setValue("country", "US")

// Classification
vendor.setValue("vendor_type", "technology")
vendor.setValue("u_vendor_tier", "strategic")

// Primary contact
vendor.setValue("contact", primaryContactSysId)

vendor.insert()
```

### Vendor Search

```javascript
// Search vendors (ES5 ONLY!)
function searchVendors(criteria) {
  var vendors = []

  var gr = new GlideRecord("core_company")
  gr.addQuery("vendor", true)
  gr.addQuery("vendor_active", true)

  if (criteria.name) {
    gr.addQuery("name", "CONTAINS", criteria.name)
  }
  if (criteria.type) {
    gr.addQuery("vendor_type", criteria.type)
  }
  if (criteria.tier) {
    gr.addQuery("u_vendor_tier", criteria.tier)
  }

  gr.query()

  while (gr.next()) {
    vendors.push({
      sys_id: gr.getUniqueValue(),
      name: gr.getValue("name"),
      type: gr.getValue("vendor_type"),
      tier: gr.getValue("u_vendor_tier"),
      contact: gr.contact.getDisplayValue(),
      active_contracts: countActiveContracts(gr.getUniqueValue()),
    })
  }

  return vendors
}

function countActiveContracts(vendorSysId) {
  var ga = new GlideAggregate("ast_contract")
  ga.addQuery("vendor", vendorSysId)
  ga.addQuery("state", "active")
  ga.addAggregate("COUNT")
  ga.query()

  if (ga.next()) {
    return parseInt(ga.getAggregate("COUNT"), 10)
  }
  return 0
}
```

## Contracts (ES5)

### Create Contract

```javascript
// Create vendor contract (ES5 ONLY!)
var contract = new GlideRecord("ast_contract")
contract.initialize()

// Basic info
contract.setValue("short_description", "Cloud Hosting Services")
contract.setValue("vendor", vendorSysId)
contract.setValue("contract_model", "service_agreement")

// Dates
contract.setValue("starts", "2024-01-01")
contract.setValue("ends", "2025-12-31")

// Financial
contract.setValue("contract_value", 500000)
contract.setValue("payment_terms", "net_30")
contract.setValue("currency", "USD")

// Renewal
contract.setValue("renewal_type", "auto")
contract.setValue("renewal_notice_period", 90) // days

// Owner
contract.setValue("contract_administrator", adminSysId)
contract.setValue("stakeholders", stakeholderSysIds)

// Status
contract.setValue("state", "active")

contract.insert()
```

### Contract Renewal Alert

```javascript
// Find contracts expiring soon (ES5 ONLY!)
function getExpiringContracts(daysAhead) {
  var expiringContracts = []
  var futureDate = new GlideDateTime()
  futureDate.addDaysLocalTime(daysAhead)

  var contract = new GlideRecord("ast_contract")
  contract.addQuery("state", "active")
  contract.addQuery("ends", "<=", futureDate)
  contract.addQuery("ends", ">=", new GlideDateTime())
  contract.orderBy("ends")
  contract.query()

  while (contract.next()) {
    expiringContracts.push({
      sys_id: contract.getUniqueValue(),
      number: contract.getValue("number"),
      description: contract.getValue("short_description"),
      vendor: contract.vendor.getDisplayValue(),
      ends: contract.getValue("ends"),
      value: contract.getValue("contract_value"),
      renewal_type: contract.getValue("renewal_type"),
    })
  }

  return expiringContracts
}

// Scheduled job to send alerts
;(function executeScheduledJob() {
  var expiring = getExpiringContracts(90)

  for (var i = 0; i < expiring.length; i++) {
    var contract = new GlideRecord("ast_contract")
    if (contract.get(expiring[i].sys_id)) {
      gs.eventQueue("contract.expiring.soon", contract, "90", "")
    }
  }
})()
```

## Contract SLAs (ES5)

### Define Contract SLA

```javascript
// Create contract SLA (ES5 ONLY!)
var sla = new GlideRecord("ast_contract_sla")
sla.initialize()

sla.setValue("contract", contractSysId)
sla.setValue("name", "Uptime Guarantee")
sla.setValue("description", "99.9% uptime guarantee")

// Metrics
sla.setValue("metric_type", "availability")
sla.setValue("target_value", "99.9")
sla.setValue("measurement_period", "monthly")

// Penalties/Credits
sla.setValue("penalty_type", "credit")
sla.setValue("penalty_description", "10% credit for each 0.1% below target")

sla.insert()
```

### Track SLA Performance

```javascript
// Record SLA measurement (ES5 ONLY!)
function recordSLAMeasurement(slaSysId, period, actualValue) {
  var measurement = new GlideRecord("u_sla_measurement")
  measurement.initialize()

  measurement.setValue("sla", slaSysId)
  measurement.setValue("period", period)
  measurement.setValue("actual_value", actualValue)
  measurement.setValue("measured_date", new GlideDateTime())

  // Get target
  var sla = new GlideRecord("ast_contract_sla")
  if (sla.get(slaSysId)) {
    var target = parseFloat(sla.getValue("target_value"))
    var actual = parseFloat(actualValue)

    measurement.setValue("target_value", target)
    measurement.setValue("met", actual >= target)

    if (actual < target) {
      // Calculate penalty/credit
      var shortfall = target - actual
      measurement.setValue("shortfall", shortfall)
      measurement.work_notes = "SLA not met. Shortfall: " + shortfall + "%"
    }
  }

  return measurement.insert()
}
```

## Vendor Risk Assessment (ES5)

### Create Risk Assessment

```javascript
// Create vendor risk assessment (ES5 ONLY!)
function createVendorAssessment(vendorSysId, assessmentData) {
  var assessment = new GlideRecord("vendor_risk_assessment")
  assessment.initialize()

  assessment.setValue("vendor", vendorSysId)
  assessment.setValue("assessment_date", new GlideDateTime())
  assessment.setValue("assessor", gs.getUserID())

  // Risk scores (1-5 scale)
  assessment.setValue("financial_risk", assessmentData.financial)
  assessment.setValue("operational_risk", assessmentData.operational)
  assessment.setValue("security_risk", assessmentData.security)
  assessment.setValue("compliance_risk", assessmentData.compliance)
  assessment.setValue("strategic_risk", assessmentData.strategic)

  // Calculate overall score
  var scores = [
    assessmentData.financial,
    assessmentData.operational,
    assessmentData.security,
    assessmentData.compliance,
    assessmentData.strategic,
  ]
  var total = 0
  for (var i = 0; i < scores.length; i++) {
    total += parseInt(scores[i], 10)
  }
  var average = total / scores.length
  assessment.setValue("overall_risk_score", average.toFixed(1))

  // Risk rating
  var rating = "low"
  if (average >= 4) rating = "critical"
  else if (average >= 3) rating = "high"
  else if (average >= 2) rating = "medium"
  assessment.setValue("risk_rating", rating)

  // Notes
  assessment.setValue("notes", assessmentData.notes)

  return assessment.insert()
}
```

### Vendor Performance Scorecard

```javascript
// Calculate vendor performance score (ES5 ONLY!)
function getVendorScorecard(vendorSysId) {
  var scorecard = {
    vendor_sys_id: vendorSysId,
    sla_performance: 0,
    ticket_metrics: {},
    risk_rating: "",
    overall_score: 0,
  }

  // SLA performance
  var slaMeasurements = new GlideAggregate("u_sla_measurement")
  slaMeasurements.addQuery("sla.contract.vendor", vendorSysId)
  slaMeasurements.addQuery("measured_date", ">=", gs.monthsAgo(12))
  slaMeasurements.addAggregate("AVG", "met")
  slaMeasurements.query()

  if (slaMeasurements.next()) {
    scorecard.sla_performance = Math.round(slaMeasurements.getAggregate("AVG", "met") * 100)
  }

  // Incident metrics
  var incidents = new GlideAggregate("incident")
  incidents.addQuery("vendor", vendorSysId)
  incidents.addQuery("opened_at", ">=", gs.monthsAgo(12))
  incidents.addAggregate("COUNT")
  incidents.addAggregate("AVG", "calendar_duration")
  incidents.query()

  if (incidents.next()) {
    scorecard.ticket_metrics.count = parseInt(incidents.getAggregate("COUNT"), 10)
    scorecard.ticket_metrics.avg_resolution = incidents.getAggregate("AVG", "calendar_duration")
  }

  // Latest risk assessment
  var assessment = new GlideRecord("vendor_risk_assessment")
  assessment.addQuery("vendor", vendorSysId)
  assessment.orderByDesc("assessment_date")
  assessment.setLimit(1)
  assessment.query()

  if (assessment.next()) {
    scorecard.risk_rating = assessment.getValue("risk_rating")
  }

  // Calculate overall score
  scorecard.overall_score = calculateOverallScore(scorecard)

  return scorecard
}
```

## MCP Tool Integration

### Available Tools

| Tool                              | Purpose             |
| --------------------------------- | ------------------- |
| `snow_query_table`     | Query vendor tables |
| `snow_execute_script`  | Test vendor scripts |
| `snow_artifact_manage` (action='find') | Find configurations |

### Example Workflow

```javascript
// 1. Query active vendors
await snow_query_table({
  table: "core_company",
  query: "vendor=true^vendor_active=true",
  fields: "name,vendor_type,u_vendor_tier,contact",
})

// 2. Find expiring contracts
await snow_execute_script({
  script: `
        var expiring = getExpiringContracts(60);
        gs.info(JSON.stringify(expiring));
    `,
})

// 3. Get vendor scorecard
await snow_execute_script({
  script: `
        var scorecard = getVendorScorecard('vendor_sys_id');
        gs.info(JSON.stringify(scorecard));
    `,
})
```

## Best Practices

1. **Vendor Classification** - Tier by importance
2. **Contract Tracking** - Monitor expirations
3. **SLA Monitoring** - Track performance
4. **Risk Assessment** - Regular evaluations
5. **Performance Reviews** - Quarterly scorecards
6. **Documentation** - Complete records
7. **Compliance** - Verify certifications
8. **ES5 Only** - No modern JavaScript syntax
