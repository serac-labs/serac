---
name: instance-security
description: Harden a ServiceNow instance — password complexity, session timeout, MFA enforcement, input sanitization for XSS/injection, security properties, syslog events, and security health checks.
license: Apache-2.0
compatibility: Designed for Snow-Code and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_property_manage
  - snow_execute_script
  - snow_query_table
---

# Instance Security for ServiceNow

Instance Security covers authentication, authorization, and security hardening.

## Security Layers

```
Network Security
    ↓
Authentication (SSO, MFA)
    ↓
Session Management
    ↓
Authorization (ACLs, Roles)
    ↓
Data Protection
    ↓
Audit & Logging
```

## Key Tables

| Table              | Purpose           |
| ------------------ | ----------------- |
| `sys_user`         | User accounts     |
| `sys_user_role`    | Roles             |
| `sys_security_acl` | Access controls   |
| `sysevent_log`     | Security events   |
| `sys_properties`   | Security settings |

## Authentication Security (ES5)

### Password Policy Configuration

```javascript
// Check password strength (ES5 ONLY!)
function validatePasswordStrength(password) {
  var issues = []

  // Minimum length
  var minLength = parseInt(gs.getProperty("glide.security.password.min_length", "8"), 10)
  if (password.length < minLength) {
    issues.push("Password must be at least " + minLength + " characters")
  }

  // Complexity requirements
  if (!/[A-Z]/.test(password)) {
    issues.push("Password must contain uppercase letter")
  }
  if (!/[a-z]/.test(password)) {
    issues.push("Password must contain lowercase letter")
  }
  if (!/[0-9]/.test(password)) {
    issues.push("Password must contain number")
  }
  if (!/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
    issues.push("Password must contain special character")
  }

  return {
    valid: issues.length === 0,
    issues: issues,
  }
}
```

### Session Security

```javascript
// Check session validity (ES5 ONLY!)
function isSessionSecure() {
  var session = gs.getSession()

  // Check session age
  var maxAge = parseInt(gs.getProperty("glide.security.session.timeout", "60"), 10)
  var sessionAge = session.getSessionAge() / 60000 // Convert to minutes

  if (sessionAge > maxAge) {
    return { valid: false, reason: "Session expired" }
  }

  // Check for session fixation
  var clientIP = gs.getSession().getClientIP()
  var originalIP = session.getValue("original_ip")

  if (originalIP && clientIP !== originalIP) {
    return { valid: false, reason: "IP address changed" }
  }

  return { valid: true }
}

// Force re-authentication
function requireReauthentication(reason) {
  gs.getSession().invalidate()
  gs.addErrorMessage(reason)
  // Redirect to login
  response.sendRedirect("/login.do")
}
```

## MFA Implementation (ES5)

### Check MFA Status

```javascript
// Check if user has MFA enabled (ES5 ONLY!)
function hasMFAEnabled(userSysId) {
  var user = new GlideRecord("sys_user")
  if (!user.get(userSysId)) {
    return false
  }

  // Check MFA settings
  var mfa = new GlideRecord("sys_user_mfa")
  mfa.addQuery("user", userSysId)
  mfa.addQuery("active", true)
  mfa.query()

  return mfa.hasNext()
}

// Enforce MFA for sensitive operations
function requireMFA(operation) {
  var userId = gs.getUserID()

  if (!hasMFAEnabled(userId)) {
    gs.addErrorMessage("MFA required for " + operation)
    return false
  }

  // Check if MFA verified this session
  var session = gs.getSession()
  var mfaVerified = session.getValue("mfa_verified")

  if (mfaVerified !== "true") {
    // Trigger MFA challenge
    gs.eventQueue("user.mfa.challenge", null, userId, operation)
    return false
  }

  return true
}
```

## Input Validation (ES5)

### XSS Prevention

```javascript
// Sanitize user input (ES5 ONLY!)
function sanitizeInput(input) {
  if (!input) return ""

  // Encode HTML entities
  var sanitized = input
    .toString()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")

  return sanitized
}

// Validate and sanitize before storage
function validateUserInput(tableName, fieldName, value) {
  // Check field type
  var dict = new GlideRecord("sys_dictionary")
  dict.addQuery("name", tableName)
  dict.addQuery("element", fieldName)
  dict.query()

  if (!dict.next()) {
    return { valid: false, error: "Field not found" }
  }

  var fieldType = dict.getValue("internal_type")

  // Validate based on type
  if (fieldType === "string" || fieldType === "html") {
    // Check for script injection
    if (/<script/i.test(value)) {
      return { valid: false, error: "Script tags not allowed" }
    }
    // Check for event handlers
    if (/on\w+\s*=/i.test(value)) {
      return { valid: false, error: "Event handlers not allowed" }
    }
  }

  return { valid: true, sanitized: sanitizeInput(value) }
}
```

### SQL Injection Prevention

```javascript
// Safe query building (ES5 ONLY!)
// NEVER concatenate user input directly into queries

// BAD - Vulnerable to injection
// gr.addEncodedQuery('name=' + userInput);

// GOOD - Use parameterized queries
function safeQuery(tableName, fieldName, value) {
  var gr = new GlideRecord(tableName)

  // GlideRecord methods handle escaping
  gr.addQuery(fieldName, value)
  gr.query()

  return gr
}

// For encoded queries, validate input
function safeEncodedQuery(tableName, userQuery) {
  // Whitelist allowed fields
  var allowedFields = ["number", "short_description", "state", "priority"]

  // Parse and validate query
  var parts = userQuery.split("^")
  var safeQuery = []

  for (var i = 0; i < parts.length; i++) {
    var part = parts[i]
    var match = part.match(/^(\w+)(=|!=|LIKE|CONTAINS)(.+)$/)

    if (match) {
      var field = match[1]
      if (allowedFields.indexOf(field) !== -1) {
        safeQuery.push(part)
      }
    }
  }

  var gr = new GlideRecord(tableName)
  if (safeQuery.length > 0) {
    gr.addEncodedQuery(safeQuery.join("^"))
  }
  gr.query()

  return gr
}
```

## Security Properties (ES5)

### Key Security Settings

```javascript
// Get security-related properties (ES5 ONLY!)
function getSecuritySettings() {
  return {
    // Session settings
    session_timeout: gs.getProperty("glide.security.session.timeout"),
    session_cookie_secure: gs.getProperty("glide.security.session.cookie.secure"),

    // Password settings
    password_min_length: gs.getProperty("glide.security.password.min_length"),
    password_history: gs.getProperty("glide.security.password.history"),
    password_expiry: gs.getProperty("glide.security.password.expiry"),

    // Login settings
    max_failed_logins: gs.getProperty("glide.security.password.max_failed_logins"),
    lockout_duration: gs.getProperty("glide.security.password.lockout_duration"),

    // General security
    csrf_protection: gs.getProperty("glide.security.csrf.strict_validation"),
    xss_protection: gs.getProperty("glide.security.xss.strict"),
  }
}

// Update security property
function setSecurityProperty(name, value, requireRestart) {
  gs.setProperty(name, value)

  if (requireRestart) {
    gs.warn("Security property changed: " + name + ". Restart may be required.")
  }

  // Log security change
  gs.eventQueue("security.property.changed", null, name, value)
}
```

## Security Auditing (ES5)

### Log Security Events

```javascript
// Log security event (ES5 ONLY!)
function logSecurityEvent(eventType, details) {
  var log = new GlideRecord("syslog")
  log.initialize()

  log.setValue("level", "warning")
  log.setValue("source", "Security")
  log.setValue("message", eventType + ": " + JSON.stringify(details))

  log.insert()

  // Also queue for security monitoring
  gs.eventQueue("security.event", null, eventType, JSON.stringify(details))
}

// Track failed login attempts
function trackFailedLogin(username, ipAddress) {
  logSecurityEvent("failed_login", {
    username: username,
    ip: ipAddress,
    timestamp: new GlideDateTime().getDisplayValue(),
  })

  // Check for brute force
  var recentFailures = countRecentFailures(username, 5) // Last 5 minutes
  var maxFailures = parseInt(gs.getProperty("glide.security.password.max_failed_logins", "5"), 10)

  if (recentFailures >= maxFailures) {
    lockAccount(username)
    logSecurityEvent("account_locked", {
      username: username,
      reason: "Too many failed login attempts",
      failures: recentFailures,
    })
  }
}
```

### Security Health Check

```javascript
// Check instance security health (ES5 ONLY!)
function securityHealthCheck() {
  var issues = []

  // Check for default admin password
  var admin = new GlideRecord("sys_user")
  if (admin.get("user_name", "admin")) {
    if (admin.getValue("password") === gs.getProperty("glide.security.default.admin.password")) {
      issues.push({ severity: "critical", issue: "Default admin password not changed" })
    }
  }

  // Check session timeout
  var timeout = parseInt(gs.getProperty("glide.security.session.timeout", "0"), 10)
  if (timeout === 0 || timeout > 60) {
    issues.push({ severity: "high", issue: "Session timeout too long or disabled" })
  }

  // Check password policy
  var minLength = parseInt(gs.getProperty("glide.security.password.min_length", "0"), 10)
  if (minLength < 12) {
    issues.push({ severity: "medium", issue: "Password minimum length less than 12" })
  }

  // Check HTTPS enforcement
  if (gs.getProperty("glide.security.session.cookie.secure") !== "true") {
    issues.push({ severity: "high", issue: "Secure cookies not enforced" })
  }

  return {
    healthy: issues.length === 0,
    issues: issues,
  }
}
```

## MCP Tool Integration

### Available Tools

| Tool                                | Purpose                   |
| ----------------------------------- | ------------------------- |
| `snow_property_manage` (action=get) | Check security properties |
| `snow_execute_script`               | Test security scripts     |
| `snow_query_table`                  | Review ACLs               |

### Example Workflow

```javascript
// 1. Check security properties
await snow_property_manage({
  action: "get",
  name: "glide.security.session.timeout",
})

// 2. Run security health check
await snow_execute_script({
  script: `
        var health = securityHealthCheck();
        gs.info(JSON.stringify(health));
    `,
})

// 3. Review access controls
await snow_query_table({
  table: "sys_security_acl",
  query: "active=true^admin_overrides=true",
  fields: "name,operation,type,script",
})
```

## Best Practices

1. **Strong Passwords** - Enforce complexity
2. **MFA** - Enable for privileged users
3. **Session Timeout** - 15-30 minutes
4. **Input Validation** - Sanitize everything
5. **Least Privilege** - Minimal roles
6. **Audit Logging** - Log security events
7. **Regular Reviews** - Security assessments
8. **ES5 Only** - No modern JavaScript syntax
