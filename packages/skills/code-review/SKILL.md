---
name: code-review
description: Review ServiceNow server-side scripts for ES5 violations, ACL/injection/XSS issues, N+1 queries, missing setLimit/error handling, hard-coded sys_ids, and business-rule recursion risks.
license: Apache-2.0
compatibility: Designed for Serac and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_artifact_manage
  - snow_execute_script
---

# ServiceNow Code Review Checklist

Use this checklist when reviewing ServiceNow server-side code (Business Rules, Script Includes, Scheduled Jobs, etc.).

## 1. ES5 Compliance (CRITICAL)

```javascript
// CHECK FOR THESE ES6+ VIOLATIONS:
const x = 5;           // ❌ Use var
let items = [];        // ❌ Use var
() => {}               // ❌ Use function()
`template ${var}`      // ❌ Use 'string ' + var
for (x of arr)         // ❌ Use traditional for loop
{a, b} = obj           // ❌ Use obj.a, obj.b
```

**Action:** Flag ALL ES6+ syntax as CRITICAL errors.

## 2. Security Issues

### 2.1 SQL/GlideRecord Injection

```javascript
// ❌ DANGEROUS - User input directly in query
gr.addEncodedQuery(userInput)
gr.addQuery("field", userInput) // OK if validated

// ✅ SAFE - Validate and sanitize
var safeInput = new GlideSysAttachment().cleanFileName(userInput)
gr.addQuery("field", safeInput)
```

### 2.2 Cross-Site Scripting (XSS)

```javascript
// ❌ DANGEROUS - Unescaped output
gs.addInfoMessage(userInput)

// ✅ SAFE - Escape HTML
gs.addInfoMessage(GlideStringUtil.escapeHTML(userInput))
```

### 2.3 Access Control

```javascript
// ❌ MISSING - No ACL check
var gr = new GlideRecord("sys_user")
gr.get(userProvidedSysId)

// ✅ SAFE - Check permissions
var gr = new GlideRecord("sys_user")
if (gr.get(userProvidedSysId) && gr.canRead()) {
  // Process record
}
```

### 2.4 Sensitive Data Exposure

```javascript
// ❌ DANGEROUS - Logging sensitive data
gs.info("Password: " + password)
gs.info("API Key: " + apiKey)

// ✅ SAFE - Never log credentials
gs.info("Authentication attempt for user: " + username)
```

## 3. Performance Issues

### 3.1 Queries in Loops

```javascript
// ❌ SLOW - N+1 query problem
for (var i = 0; i < userIds.length; i++) {
  var gr = new GlideRecord("sys_user")
  gr.get(userIds[i]) // Query for each user!
}

// ✅ FAST - Single query
var gr = new GlideRecord("sys_user")
gr.addQuery("sys_id", "IN", userIds.join(","))
gr.query()
while (gr.next()) {}
```

### 3.2 Missing setLimit()

```javascript
// ❌ SLOW - Could return millions of records
var gr = new GlideRecord("incident")
gr.query()

// ✅ FAST - Limit results
var gr = new GlideRecord("incident")
gr.setLimit(1000)
gr.query()
```

### 3.3 Unnecessary Queries

```javascript
// ❌ WASTEFUL - Query just to check existence
var gr = new GlideRecord("incident")
gr.addQuery("number", incNumber)
gr.query()
if (gr.getRowCount() > 0) {
}

// ✅ EFFICIENT - Use get() for single record
var gr = new GlideRecord("incident")
if (gr.get("number", incNumber)) {
}
```

### 3.4 GlideRecord vs GlideAggregate

```javascript
// ❌ SLOW - Counting with loop
var count = 0
var gr = new GlideRecord("incident")
gr.addQuery("active", true)
gr.query()
while (gr.next()) count++

// ✅ FAST - Use GlideAggregate
var ga = new GlideAggregate("incident")
ga.addQuery("active", true)
ga.addAggregate("COUNT")
ga.query()
var count = ga.next() ? ga.getAggregate("COUNT") : 0
```

## 4. Code Quality Issues

### 4.1 Hard-coded sys_ids

```javascript
// ❌ BAD - Hard-coded sys_id (breaks across instances)
var assignmentGroup = "681ccaf9c0a8016400b98a06818d57c7"

// ✅ GOOD - Use property or lookup
var assignmentGroup = gs.getProperty("my.default.assignment.group")
// OR
var gr = new GlideRecord("sys_user_group")
if (gr.get("name", "Service Desk")) {
  var assignmentGroup = gr.getUniqueValue()
}
```

### 4.2 Magic Numbers/Strings

```javascript
// ❌ BAD - Magic numbers
if (current.state == 6) {
}
if (current.priority == 1) {
}

// ✅ GOOD - Named constants or comments
var STATE_RESOLVED = 6
var PRIORITY_CRITICAL = 1
if (current.state == STATE_RESOLVED) {
}
```

### 4.3 Missing Error Handling

```javascript
// ❌ BAD - No error handling
var response = request.execute()
var data = JSON.parse(response.getBody())

// ✅ GOOD - Proper error handling
try {
  var response = request.execute()
  var status = response.getStatusCode()
  if (status != 200) {
    gs.error("API call failed: " + status)
    return null
  }
  var data = JSON.parse(response.getBody())
} catch (e) {
  gs.error("Exception: " + e.message)
  return null
}
```

### 4.4 Proper Logging

```javascript
// ❌ BAD - No context in logs
gs.info("Error occurred")

// ✅ GOOD - Contextual logging
gs.info("[MyScriptInclude.process] Processing incident: " + current.number + ", user: " + gs.getUserName())
```

## 5. Business Rule Specific

### 5.1 Recursion Prevention

```javascript
// ❌ DANGEROUS - Can cause infinite loop
current.update() // In a Before rule

// ✅ SAFE - Use workflow control
current.setWorkflow(false)
current.update()
current.setWorkflow(true)
```

### 5.2 Appropriate Rule Type

```javascript
// ❌ WRONG - Heavy processing in Before rule
// Before rules should be fast!

// ✅ RIGHT - Use Async for heavy operations
// Move integrations and heavy processing to Async rules
```

## 6. Review Output Format

When reviewing code, structure your feedback as:

```markdown
## Code Review Summary

### Critical Issues (Must Fix)

1. [SECURITY] Description...
2. [ES5] Description...

### Performance Issues (Should Fix)

1. [PERF] Description...

### Code Quality (Nice to Have)

1. [QUALITY] Description...

### Positive Observations

- Good use of...
- Well-structured...
```

## 7. Severity Levels

| Level        | Action                     | Examples                                   |
| ------------ | -------------------------- | ------------------------------------------ |
| **CRITICAL** | Must fix before deployment | Security vulnerabilities, ES6 syntax       |
| **HIGH**     | Should fix                 | Performance issues, missing error handling |
| **MEDIUM**   | Recommend fixing           | Code quality, hard-coded values            |
| **LOW**      | Consider fixing            | Style, minor improvements                  |
