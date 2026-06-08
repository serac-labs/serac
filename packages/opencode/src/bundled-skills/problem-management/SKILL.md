---
name: problem-management
description: Manage ServiceNow problems — create from linked incidents, proactive pattern detection, RCA with 5-Whys, known_error workarounds (KEDB), KEDB search by CI/category/keywords, and permanent-fix linkage to changes.
license: Apache-2.0
compatibility: Designed for Snow-Code and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_query_table
  - snow_find_artifact
  - snow_execute_script_with_output
  - snow_knowledge_article_create
---

# Problem Management for ServiceNow

Problem Management identifies root causes of incidents and implements permanent solutions.

## Problem Lifecycle

```
New (1)
    ↓
Assess (2)
    ↓
Root Cause Analysis (3)
    ↓
Fix in Progress (4) ← Known Error Database
    ↓
Resolved (5)
    ↓
Closed (6)

Cancelled (7) ← Can occur from any state
```

## Key Tables

| Table          | Purpose                     |
| -------------- | --------------------------- |
| `problem`      | Problem records             |
| `problem_task` | Problem investigation tasks |
| `known_error`  | Known Error Database (KEDB) |
| `incident`     | Related incidents           |

## Creating Problems (ES5)

### Create Problem from Incidents

```javascript
// Create problem from multiple incidents (ES5 ONLY!)
function createProblemFromIncidents(incidentSysIds, problemData) {
  // Create problem
  var problem = new GlideRecord("problem")
  problem.initialize()

  problem.setValue("short_description", problemData.title)
  problem.setValue("description", problemData.description)
  problem.setValue("category", problemData.category)
  problem.setValue("subcategory", problemData.subcategory)

  // Set impact based on related incidents
  var highestImpact = 3
  for (var i = 0; i < incidentSysIds.length; i++) {
    var incident = new GlideRecord("incident")
    if (incident.get(incidentSysIds[i])) {
      var incImpact = parseInt(incident.getValue("impact"), 10)
      if (incImpact < highestImpact) {
        highestImpact = incImpact
      }
    }
  }
  problem.setValue("impact", highestImpact)
  problem.setValue("urgency", highestImpact)

  // Assignment
  if (problemData.assignmentGroup) {
    problem.setValue("assignment_group", problemData.assignmentGroup)
  }

  // Affected CI
  if (problemData.cmdb_ci) {
    problem.setValue("cmdb_ci", problemData.cmdb_ci)
  }

  var problemSysId = problem.insert()

  // Link incidents to problem
  for (var j = 0; j < incidentSysIds.length; j++) {
    var incidentToLink = new GlideRecord("incident")
    if (incidentToLink.get(incidentSysIds[j])) {
      incidentToLink.setValue("problem_id", problemSysId)
      incidentToLink.work_notes = "Linked to Problem: " + problem.getValue("number")
      incidentToLink.update()
    }
  }

  return {
    sys_id: problemSysId,
    number: problem.getValue("number"),
  }
}
```

### Proactive Problem Creation

```javascript
// Identify patterns for proactive problems (ES5 ONLY!)
function identifyProactiveProblems() {
  var LOG_PREFIX = "[ProactiveProblem] "
  var threshold = 5 // Minimum incidents to trigger

  // Find recurring incident patterns
  var ga = new GlideAggregate("incident")
  ga.addQuery("opened_at", ">=", gs.daysAgo(30))
  ga.addQuery("active", false) // Only closed incidents
  ga.addNotNullQuery("cmdb_ci")
  ga.addAggregate("COUNT")
  ga.groupBy("cmdb_ci")
  ga.groupBy("category")
  ga.groupBy("subcategory")
  ga.addHaving("COUNT", ">", threshold)
  ga.orderByAggregate("COUNT", "DESC")
  ga.query()

  var patterns = []

  while (ga.next()) {
    var count = parseInt(ga.getAggregate("COUNT"), 10)
    var ci = ga.getValue("cmdb_ci")
    var category = ga.getValue("category")
    var subcategory = ga.getValue("subcategory")

    // Check if problem already exists
    if (!problemExistsForPattern(ci, category, subcategory)) {
      patterns.push({
        cmdb_ci: ci,
        ci_name: ga.cmdb_ci.getDisplayValue(),
        category: category,
        subcategory: subcategory,
        incident_count: count,
      })

      gs.info(
        LOG_PREFIX +
          "Pattern found: " +
          count +
          " incidents for CI " +
          ga.cmdb_ci.getDisplayValue() +
          " (" +
          category +
          "/" +
          subcategory +
          ")",
      )
    }
  }

  return patterns
}

function problemExistsForPattern(ci, category, subcategory) {
  var problem = new GlideRecord("problem")
  problem.addQuery("cmdb_ci", ci)
  problem.addQuery("category", category)
  problem.addQuery("subcategory", subcategory)
  problem.addQuery("state", "NOT IN", "5,6,7") // Not resolved/closed/cancelled
  problem.query()
  return problem.hasNext()
}
```

## Root Cause Analysis (ES5)

### RCA Workflow

```javascript
// Start RCA process (ES5 ONLY!)
function startRootCauseAnalysis(problemSysId) {
  var problem = new GlideRecord("problem")
  if (!problem.get(problemSysId)) {
    return false
  }

  // Move to RCA state
  problem.setValue("state", 3) // Root Cause Analysis
  problem.update()

  // Create RCA tasks
  var tasks = [
    { title: "Gather incident data", order: 100 },
    { title: "Interview stakeholders", order: 200 },
    { title: "Review system logs", order: 300 },
    { title: "Identify contributing factors", order: 400 },
    { title: "Document root cause", order: 500 },
  ]

  for (var i = 0; i < tasks.length; i++) {
    createProblemTask(problemSysId, tasks[i])
  }

  return true
}

function createProblemTask(problemSysId, taskData) {
  var task = new GlideRecord("problem_task")
  task.initialize()
  task.setValue("problem", problemSysId)
  task.setValue("short_description", taskData.title)
  task.setValue("order", taskData.order)
  task.setValue("state", 1) // New
  return task.insert()
}
```

### Document Root Cause

```javascript
// Document RCA findings (ES5 ONLY!)
function documentRootCause(problemSysId, rcaData) {
  var problem = new GlideRecord("problem")
  if (!problem.get(problemSysId)) {
    return false
  }

  // Set root cause fields
  problem.setValue("cause_notes", rcaData.rootCause)
  problem.setValue("u_contributing_factors", rcaData.contributingFactors)

  // 5 Whys analysis
  if (rcaData.fiveWhys) {
    problem.setValue("u_five_whys", JSON.stringify(rcaData.fiveWhys))
  }

  // Set root cause category
  problem.setValue("u_root_cause_category", rcaData.category)

  // Document fix
  problem.setValue("fix_notes", rcaData.proposedFix)

  // Move to Fix in Progress if ready
  if (rcaData.readyToFix) {
    problem.setValue("state", 4) // Fix in Progress
  }

  problem.update()

  // Add to work notes
  problem.work_notes =
    "Root Cause Documented:\n" +
    "-------------------\n" +
    rcaData.rootCause +
    "\n\n" +
    "Proposed Fix:\n" +
    "-------------\n" +
    rcaData.proposedFix
  problem.update()

  return true
}
```

## Known Error Database (ES5)

### Create Known Error

```javascript
// Create Known Error from Problem (ES5 ONLY!)
function createKnownError(problemSysId, workaroundInfo) {
  var problem = new GlideRecord("problem")
  if (!problem.get(problemSysId)) {
    return null
  }

  // Create Known Error
  var ke = new GlideRecord("known_error")
  ke.initialize()

  // Copy from problem
  ke.setValue("short_description", problem.getValue("short_description"))
  ke.setValue("description", problem.getValue("description"))
  ke.setValue("cause_notes", problem.getValue("cause_notes"))
  ke.setValue("cmdb_ci", problem.getValue("cmdb_ci"))
  ke.setValue("category", problem.getValue("category"))
  ke.setValue("subcategory", problem.getValue("subcategory"))

  // Workaround
  ke.setValue("workaround", workaroundInfo.description)
  ke.setValue("u_workaround_effectiveness", workaroundInfo.effectiveness)

  // Link to problem
  ke.setValue("problem", problemSysId)

  // Set state
  ke.setValue("state", "published")

  var keSysId = ke.insert()

  // Update problem with known error link
  problem.setValue("known_error", keSysId)
  problem.setValue("known_error_state", "accepted")
  problem.update()

  return {
    sys_id: keSysId,
    number: ke.getValue("number"),
  }
}
```

### Search Known Errors

```javascript
// Search KEDB for matching workarounds (ES5 ONLY!)
var KEDBSearch = Class.create()
KEDBSearch.prototype = {
  initialize: function () {},

  /**
   * Find matching known errors for an incident
   */
  findForIncident: function (incidentSysId) {
    var incident = new GlideRecord("incident")
    if (!incident.get(incidentSysId)) {
      return []
    }

    var matches = []

    // Search by CI
    if (incident.cmdb_ci) {
      var ciMatches = this._searchByCI(incident.getValue("cmdb_ci"))
      matches = matches.concat(ciMatches)
    }

    // Search by category
    var catMatches = this._searchByCategory(incident.getValue("category"), incident.getValue("subcategory"))
    matches = matches.concat(catMatches)

    // Search by keywords
    var keywordMatches = this._searchByKeywords(incident.getValue("short_description"))
    matches = matches.concat(keywordMatches)

    // Deduplicate
    return this._deduplicate(matches)
  },

  _searchByCI: function (ciSysId) {
    var results = []
    var ke = new GlideRecord("known_error")
    ke.addQuery("cmdb_ci", ciSysId)
    ke.addQuery("state", "published")
    ke.query()

    while (ke.next()) {
      results.push(this._toObject(ke, "CI Match"))
    }
    return results
  },

  _searchByCategory: function (category, subcategory) {
    var results = []
    var ke = new GlideRecord("known_error")
    ke.addQuery("category", category)
    if (subcategory) {
      ke.addQuery("subcategory", subcategory)
    }
    ke.addQuery("state", "published")
    ke.query()

    while (ke.next()) {
      results.push(this._toObject(ke, "Category Match"))
    }
    return results
  },

  _searchByKeywords: function (description) {
    var results = []
    var keywords = description.split(" ").filter(function (w) {
      return w.length > 3
    })

    var ke = new GlideRecord("known_error")
    ke.addQuery("state", "published")

    var qc = null
    for (var i = 0; i < keywords.length && i < 5; i++) {
      if (qc === null) {
        qc = ke.addQuery("short_description", "CONTAINS", keywords[i])
      } else {
        qc.addOrCondition("short_description", "CONTAINS", keywords[i])
      }
    }
    ke.query()

    while (ke.next()) {
      results.push(this._toObject(ke, "Keyword Match"))
    }
    return results
  },

  _toObject: function (gr, matchType) {
    return {
      sys_id: gr.getUniqueValue(),
      number: gr.getValue("number"),
      title: gr.getValue("short_description"),
      workaround: gr.getValue("workaround"),
      matchType: matchType,
    }
  },

  _deduplicate: function (matches) {
    var seen = {}
    var unique = []
    for (var i = 0; i < matches.length; i++) {
      if (!seen[matches[i].sys_id]) {
        seen[matches[i].sys_id] = true
        unique.push(matches[i])
      }
    }
    return unique
  },

  type: "KEDBSearch",
}
```

## Problem Resolution (ES5)

### Resolve Problem

```javascript
// Resolve problem with fix (ES5 ONLY!)
function resolveProblem(problemSysId, resolutionData) {
  var problem = new GlideRecord("problem")
  if (!problem.get(problemSysId)) {
    return { success: false, message: "Problem not found" }
  }

  // Validate
  if (!resolutionData.fixNotes) {
    return { success: false, message: "Fix notes required" }
  }

  // Update problem
  problem.setValue("state", 5) // Resolved
  problem.setValue("fix_notes", resolutionData.fixNotes)
  problem.setValue("resolution_code", resolutionData.resolutionCode)
  problem.setValue("resolved_at", new GlideDateTime())
  problem.setValue("resolved_by", gs.getUserID())

  // Link to change if permanent fix deployed
  if (resolutionData.changeRequest) {
    problem.setValue("rfc", resolutionData.changeRequest)
  }

  problem.update()

  // Update related Known Error if exists
  if (problem.known_error) {
    var ke = new GlideRecord("known_error")
    if (ke.get(problem.getValue("known_error"))) {
      ke.setValue("state", "closed")
      ke.setValue("u_permanent_fix", resolutionData.fixNotes)
      ke.update()
    }
  }

  // Notify incident owners
  notifyLinkedIncidents(problemSysId, "Problem resolved: " + problem.getValue("number"))

  return {
    success: true,
    number: problem.getValue("number"),
  }
}

function notifyLinkedIncidents(problemSysId, message) {
  var incident = new GlideRecord("incident")
  incident.addQuery("problem_id", problemSysId)
  incident.addQuery("active", true)
  incident.query()

  while (incident.next()) {
    incident.work_notes = message
    incident.update()
  }
}
```

## MCP Tool Integration

### Available Tools

| Tool                              | Purpose                         |
| --------------------------------- | ------------------------------- |
| `snow_query_table`                | Query problems and known errors |
| `snow_find_artifact`              | Find problem records            |
| `snow_execute_script_with_output` | Test problem scripts            |
| `snow_create_business_rule`       | Create problem automation       |

### Example Workflow

```javascript
// 1. Find open problems
await snow_query_table({
  table: "problem",
  query: "active=true",
  fields: "number,short_description,state,assignment_group",
})

// 2. Search KEDB
await snow_query_table({
  table: "known_error",
  query: "state=published^short_descriptionLIKEemail",
  fields: "number,short_description,workaround",
})

// 3. Find recurring incidents for proactive problems
await snow_execute_script_with_output({
  script: `
        var patterns = identifyProactiveProblems();
        gs.info('Patterns found: ' + patterns.length);
    `,
})
```

## Best Practices

1. **Incident Linking** - Link all related incidents
2. **Root Cause Focus** - Find actual cause, not symptoms
3. **5 Whys Technique** - Drill down to root cause
4. **Known Errors** - Document workarounds
5. **Permanent Fixes** - Link to change requests
6. **Metrics** - Track problem resolution time
7. **Proactive** - Identify patterns before escalation
8. **ES5 Only** - No modern JavaScript syntax
