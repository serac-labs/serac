---
name: grc-compliance
description: Build ServiceNow GRC — sn_compliance_policy lifecycle, sn_compliance_control tests, sn_risk_risk assessment with inherent/residual scoring, audit engagements, and findings remediation.
license: Apache-2.0
compatibility: Designed for Snow-Code and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_query_table
  - snow_execute_script_with_output
  - snow_audit_compliance
  - snow_assess_risk
---

# GRC & Compliance for ServiceNow

GRC (Governance, Risk, Compliance) manages organizational policies, risks, and regulatory compliance.

## GRC Architecture

```
Policy (sn_compliance_policy)
    └── Policy Statements
        └── Controls (sn_compliance_control)
            └── Control Tests
                └── Test Results

Risk (sn_risk_risk)
    ├── Risk Assessment
    └── Risk Response
```

## Key Tables

| Table                        | Purpose             |
| ---------------------------- | ------------------- |
| `sn_compliance_policy`       | Compliance policies |
| `sn_compliance_control`      | Controls            |
| `sn_compliance_control_test` | Control tests       |
| `sn_risk_risk`               | Risk records        |
| `sn_audit_engagement`        | Audit engagements   |

## Policies (ES5)

### Create Policy

```javascript
// Create compliance policy (ES5 ONLY!)
var policy = new GlideRecord("sn_compliance_policy")
policy.initialize()

// Basic info
policy.setValue("name", "Information Security Policy")
policy.setValue("description", "Enterprise information security requirements")
policy.setValue("short_description", "InfoSec Policy")

// Classification
policy.setValue("category", "security")
policy.setValue("type", "corporate")

// Owner
policy.setValue("owner", policyOwnerSysId)
policy.setValue("owning_group", securityTeamSysId)

// Status
policy.setValue("state", "draft")

// Dates
policy.setValue("effective_date", "2024-01-01")
policy.setValue("review_date", "2025-01-01")

policy.insert()
```

### Policy Lifecycle

```javascript
// Transition policy state (ES5 ONLY!)
function transitionPolicy(policySysId, newState, notes) {
  var policy = new GlideRecord("sn_compliance_policy")
  if (!policy.get(policySysId)) {
    return { success: false, message: "Policy not found" }
  }

  var validTransitions = {
    draft: ["review", "retired"],
    review: ["approved", "draft"],
    approved: ["published", "draft"],
    published: ["review", "retired"],
    retired: ["draft"],
  }

  var currentState = policy.getValue("state")

  if (!validTransitions[currentState] || validTransitions[currentState].indexOf(newState) === -1) {
    return { success: false, message: "Invalid transition" }
  }

  policy.setValue("state", newState)

  if (newState === "published") {
    policy.setValue("published_date", new GlideDateTime())
  }

  if (notes) {
    policy.work_notes = notes
  }

  policy.update()

  return { success: true, state: newState }
}
```

## Controls (ES5)

### Create Control

```javascript
// Create compliance control (ES5 ONLY!)
var control = new GlideRecord("sn_compliance_control")
control.initialize()

// Basic info
control.setValue("name", "Access Control Review")
control.setValue("description", "Quarterly review of user access rights")
control.setValue("short_description", "Access Review Control")

// Link to policy
control.setValue("policy", policySysId)

// Classification
control.setValue("type", "detective") // preventive, detective, corrective
control.setValue("category", "access_control")
control.setValue("frequency", "quarterly")

// Owner
control.setValue("owner", controlOwnerSysId)

// Testing
control.setValue("test_frequency", "quarterly")
control.setValue("test_type", "manual")

// Status
control.setValue("state", "draft")

control.insert()
```

### Control Testing

```javascript
// Create control test (ES5 ONLY!)
function createControlTest(controlSysId, testData) {
  var test = new GlideRecord("sn_compliance_control_test")
  test.initialize()

  test.setValue("control", controlSysId)
  test.setValue("name", testData.name)
  test.setValue("description", testData.description)

  // Test details
  test.setValue("test_type", testData.type) // design, operating
  test.setValue("planned_start", testData.plannedStart)
  test.setValue("planned_end", testData.plannedEnd)

  // Assignment
  test.setValue("assigned_to", testData.tester)

  // Status
  test.setValue("state", "open")

  return test.insert()
}

// Record test result
function recordTestResult(testSysId, result) {
  var test = new GlideRecord("sn_compliance_control_test")
  if (!test.get(testSysId)) {
    return false
  }

  test.setValue("state", "closed")
  test.setValue("result", result.outcome) // pass, fail, not_tested
  test.setValue("actual_end", new GlideDateTime())
  test.setValue("findings", result.findings)
  test.setValue("evidence", result.evidence)

  // If failed, create issue
  if (result.outcome === "fail") {
    createComplianceIssue(test, result)
  }

  test.update()
  return true
}
```

## Risk Management (ES5)

### Create Risk

```javascript
// Create risk record (ES5 ONLY!)
var risk = new GlideRecord("sn_risk_risk")
risk.initialize()

// Basic info
risk.setValue("name", "Data Breach Risk")
risk.setValue("description", "Risk of unauthorized access to customer data")
risk.setValue("short_description", "Data Breach")

// Classification
risk.setValue("category", "security")
risk.setValue("subcategory", "data_protection")

// Risk assessment
risk.setValue("inherent_likelihood", 3) // 1-5 scale
risk.setValue("inherent_impact", 5) // 1-5 scale
// Inherent risk = likelihood x impact

// Controls that mitigate this risk
risk.setValue("controls", controlSysIds) // Comma-separated

// Residual risk (after controls)
risk.setValue("residual_likelihood", 2)
risk.setValue("residual_impact", 5)

// Owner
risk.setValue("owner", riskOwnerSysId)

// Status
risk.setValue("state", "assess")

risk.insert()
```

### Risk Assessment

```javascript
// Calculate risk score (ES5 ONLY!)
function calculateRiskScore(likelihood, impact) {
  var score = likelihood * impact

  var rating = "low"
  if (score >= 20) {
    rating = "critical"
  } else if (score >= 12) {
    rating = "high"
  } else if (score >= 6) {
    rating = "medium"
  }

  return {
    score: score,
    rating: rating,
  }
}

// Assess risk and update record (ES5 ONLY!)
function assessRisk(riskSysId, assessment) {
  var risk = new GlideRecord("sn_risk_risk")
  if (!risk.get(riskSysId)) {
    return false
  }

  // Update inherent risk
  risk.setValue("inherent_likelihood", assessment.inherentLikelihood)
  risk.setValue("inherent_impact", assessment.inherentImpact)

  var inherentScore = calculateRiskScore(assessment.inherentLikelihood, assessment.inherentImpact)
  risk.setValue("inherent_risk_score", inherentScore.score)
  risk.setValue("inherent_risk_rating", inherentScore.rating)

  // Update residual risk
  risk.setValue("residual_likelihood", assessment.residualLikelihood)
  risk.setValue("residual_impact", assessment.residualImpact)

  var residualScore = calculateRiskScore(assessment.residualLikelihood, assessment.residualImpact)
  risk.setValue("residual_risk_score", residualScore.score)
  risk.setValue("residual_risk_rating", residualScore.rating)

  // Assessment metadata
  risk.setValue("assessed_date", new GlideDateTime())
  risk.setValue("assessed_by", gs.getUserID())
  risk.setValue("state", "monitor")

  risk.update()

  return true
}
```

## Audits (ES5)

### Create Audit Engagement

```javascript
// Create audit engagement (ES5 ONLY!)
var audit = new GlideRecord("sn_audit_engagement")
audit.initialize()

audit.setValue("name", "Q1 2024 SOX Audit")
audit.setValue("description", "Quarterly SOX compliance audit")
audit.setValue("type", "compliance")

// Dates
audit.setValue("planned_start", "2024-01-15")
audit.setValue("planned_end", "2024-02-15")

// Scope
audit.setValue("scope", "Financial controls, access management")

// Team
audit.setValue("lead_auditor", auditorSysId)
audit.setValue("audit_team", auditTeamSysId)

// Status
audit.setValue("state", "planning")

audit.insert()
```

### Audit Findings

```javascript
// Create audit finding (ES5 ONLY!)
function createAuditFinding(auditSysId, findingData) {
  var finding = new GlideRecord("sn_audit_finding")
  finding.initialize()

  finding.setValue("engagement", auditSysId)
  finding.setValue("title", findingData.title)
  finding.setValue("description", findingData.description)

  // Severity
  finding.setValue("severity", findingData.severity) // critical, high, medium, low

  // Related control
  if (findingData.control) {
    finding.setValue("control", findingData.control)
  }

  // Recommendation
  finding.setValue("recommendation", findingData.recommendation)

  // Owner for remediation
  finding.setValue("owner", findingData.owner)

  // Due date for remediation
  finding.setValue("due_date", findingData.dueDate)

  finding.setValue("state", "open")

  return finding.insert()
}
```

## Compliance Reporting (ES5)

### Compliance Dashboard Data

```javascript
// Get compliance summary (ES5 ONLY!)
function getComplianceSummary() {
  var summary = {
    policies: { total: 0, published: 0, review_needed: 0 },
    controls: { total: 0, effective: 0, failed: 0 },
    risks: { critical: 0, high: 0, medium: 0, low: 0 },
    audits: { open: 0, findings: 0 },
  }

  // Policies
  var ga = new GlideAggregate("sn_compliance_policy")
  ga.addAggregate("COUNT")
  ga.groupBy("state")
  ga.query()

  while (ga.next()) {
    var count = parseInt(ga.getAggregate("COUNT"), 10)
    summary.policies.total += count
    if (ga.getValue("state") === "published") {
      summary.policies.published = count
    }
  }

  // Risks by rating
  ga = new GlideAggregate("sn_risk_risk")
  ga.addQuery("active", true)
  ga.addAggregate("COUNT")
  ga.groupBy("residual_risk_rating")
  ga.query()

  while (ga.next()) {
    var rating = ga.getValue("residual_risk_rating")
    var riskCount = parseInt(ga.getAggregate("COUNT"), 10)
    if (summary.risks.hasOwnProperty(rating)) {
      summary.risks[rating] = riskCount
    }
  }

  return summary
}
```

## MCP Tool Integration

### Available Tools

| Tool                              | Purpose               |
| --------------------------------- | --------------------- |
| `snow_query_table`                | Query GRC tables      |
| `snow_execute_script_with_output` | Test GRC scripts      |
| `snow_audit_compliance`           | Run compliance audits |
| `snow_assess_risk`                | Risk assessment       |

### Example Workflow

```javascript
// 1. Query active policies
await snow_query_table({
  table: "sn_compliance_policy",
  query: "state=published",
  fields: "name,category,effective_date,review_date",
})

// 2. Find high risks
await snow_query_table({
  table: "sn_risk_risk",
  query: "residual_risk_rating=high^ORresidual_risk_rating=critical",
  fields: "name,category,residual_risk_score,owner",
})

// 3. Get compliance summary
await snow_execute_script_with_output({
  script: `
        var summary = getComplianceSummary();
        gs.info(JSON.stringify(summary));
    `,
})
```

## Best Practices

1. **Clear Ownership** - Assign policy/control/risk owners
2. **Regular Reviews** - Schedule periodic assessments
3. **Evidence Collection** - Document control effectiveness
4. **Risk Quantification** - Use consistent scoring
5. **Audit Trail** - Track all changes
6. **Automation** - Automate testing where possible
7. **Reporting** - Regular compliance dashboards
8. **ES5 Only** - No modern JavaScript syntax
