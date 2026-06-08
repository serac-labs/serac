---
name: rest-integration
description: Make outbound REST calls from ServiceNow with sn_ws.RESTMessageV2 — basic/bearer/OAuth/API-key auth, error handling by status code, response parsing, sys_rest_message records, and retry with exponential backoff.
version: 1.0.0
tools:
  - snow_create_rest_message
  - snow_test_rest_connection
  - snow_test_web_service
  - snow_execute_script_with_output
---

# REST Integration Patterns for ServiceNow

ServiceNow provides RESTMessageV2 for outbound REST API calls and the REST API for inbound requests.

## Outbound REST (Calling External APIs)

### Basic GET Request

```javascript
var request = new sn_ws.RESTMessageV2()
request.setEndpoint("https://api.example.com/users")
request.setHttpMethod("GET")
request.setRequestHeader("Accept", "application/json")

var response = request.execute()
var httpStatus = response.getStatusCode()
var body = response.getBody()

if (httpStatus == 200) {
  var data = JSON.parse(body)
  gs.info("Found " + data.length + " users")
}
```

### POST Request with JSON Body

```javascript
var request = new sn_ws.RESTMessageV2()
request.setEndpoint("https://api.example.com/incidents")
request.setHttpMethod("POST")
request.setRequestHeader("Content-Type", "application/json")
request.setRequestHeader("Accept", "application/json")

var payload = {
  title: "New Incident",
  description: "Created from ServiceNow",
  priority: "high",
}
request.setRequestBody(JSON.stringify(payload))

var response = request.execute()
```

### Using REST Message Records

Create a REST Message record for reusable integrations:

```javascript
// Using predefined REST Message from sys_rest_message
var request = new sn_ws.RESTMessageV2("External API", "Create User")

// Set variable substitutions defined in the REST Message
request.setStringParameter("user_name", userName)
request.setStringParameter("email", email)

var response = request.execute()
```

## Authentication Methods

### Basic Authentication

```javascript
var request = new sn_ws.RESTMessageV2()
request.setEndpoint("https://api.example.com/data")
request.setHttpMethod("GET")
request.setBasicAuth("username", "password")
```

### Bearer Token

```javascript
var request = new sn_ws.RESTMessageV2()
request.setEndpoint("https://api.example.com/data")
request.setHttpMethod("GET")
request.setRequestHeader("Authorization", "Bearer " + token)
```

### OAuth 2.0 (Using OAuth Profile)

```javascript
var request = new sn_ws.RESTMessageV2()
request.setEndpoint("https://api.example.com/data")
request.setHttpMethod("GET")
request.setAuthenticationProfile("oauth2", "My OAuth Profile")
```

### API Key

```javascript
var request = new sn_ws.RESTMessageV2()
request.setEndpoint("https://api.example.com/data")
request.setHttpMethod("GET")
request.setRequestHeader("X-API-Key", apiKey)
// Or as query parameter
request.setQueryParameter("api_key", apiKey)
```

## Error Handling

```javascript
try {
  var request = new sn_ws.RESTMessageV2()
  request.setEndpoint("https://api.example.com/data")
  request.setHttpMethod("GET")
  request.setHttpTimeout(10000) // 10 second timeout

  var response = request.execute()
  var httpStatus = response.getStatusCode()

  if (httpStatus == 200) {
    var body = response.getBody()
    var data = JSON.parse(body)
    // Process successful response
  } else if (httpStatus == 401) {
    gs.error("Authentication failed")
  } else if (httpStatus == 404) {
    gs.error("Resource not found")
  } else if (httpStatus >= 500) {
    gs.error("Server error: " + httpStatus)
  } else {
    gs.error("Unexpected status: " + httpStatus)
  }
} catch (ex) {
  gs.error("REST Exception: " + ex.message)
}
```

## Response Handling

### Parse JSON Response

```javascript
var body = response.getBody()
var data = JSON.parse(body)

// Access nested data
var userName = data.user.name
var items = data.items || []
```

### Handle Arrays

```javascript
var body = response.getBody()
var users = JSON.parse(body)

for (var i = 0; i < users.length; i++) {
  var user = users[i]
  gs.info("User: " + user.name + " (" + user.email + ")")
}
```

### Response Headers

```javascript
var contentType = response.getHeader("Content-Type")
var rateLimitRemaining = response.getHeader("X-RateLimit-Remaining")
```

## MCP Tools for REST

```javascript
// Create REST Message record
snow_create_rest_message({
  name: "External API",
  endpoint: "https://api.example.com",
  authentication: "basic", // or "oauth2", "api_key"
  methods: [
    {
      name: "Get Users",
      http_method: "GET",
      endpoint: "/users",
    },
    {
      name: "Create User",
      http_method: "POST",
      endpoint: "/users",
      content_type: "application/json",
    },
  ],
})

// Test REST connection
snow_test_rest_connection({
  endpoint: "https://api.example.com/health",
})
```

## Best Practices

1. **Use REST Message records** - Centralized configuration, easier maintenance
2. **Set timeouts** - Prevent hanging scripts with `setHttpTimeout()`
3. **Handle all status codes** - Not just 200
4. **Log failures** - Use `gs.error()` for debugging
5. **Use Async for slow APIs** - Don't block business rules
6. **Store credentials securely** - Use Connection & Credential Aliases
7. **Implement retry logic** - For transient failures
8. **Rate limit awareness** - Check response headers, implement backoff

## Retry Pattern

```javascript
function callApiWithRetry(endpoint, maxRetries) {
  var retries = 0
  var delay = 1000 // Start with 1 second

  while (retries < maxRetries) {
    try {
      var request = new sn_ws.RESTMessageV2()
      request.setEndpoint(endpoint)
      request.setHttpMethod("GET")

      var response = request.execute()

      if (response.getStatusCode() == 200) {
        return JSON.parse(response.getBody())
      }

      if (response.getStatusCode() >= 500) {
        // Server error - retry
        retries++
        gs.sleep(delay)
        delay = delay * 2 // Exponential backoff
        continue
      }

      // Client error - don't retry
      throw new Error("Client error: " + response.getStatusCode())
    } catch (ex) {
      retries++
      if (retries >= maxRetries) {
        throw ex
      }
      gs.sleep(delay)
      delay = delay * 2
    }
  }
}
```
