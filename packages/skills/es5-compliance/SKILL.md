---
name: es5-compliance
description: Enforce ES5-only syntax for ServiceNow server-side scripts (Rhino engine) — convert const/let, arrow functions, template literals, destructuring, for-of, and async/await to ES5 equivalents.
license: Apache-2.0
compatibility: Designed for Snow-Code and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_execute_script
  - snow_convert_es6_to_es5
---

# ES5 Compliance for ServiceNow

ServiceNow runs on Mozilla Rhino engine which only supports ES5 JavaScript (2009 standard). All server-side scripts MUST use ES5 syntax.

## Forbidden Syntax (WILL CAUSE SyntaxError)

| ES6+ Syntax           | ES5 Alternative                        |
| --------------------- | -------------------------------------- |
| `const x = 5`         | `var x = 5`                            |
| `let items = []`      | `var items = []`                       |
| `() => {}`            | `function() {}`                        |
| `` `Hello ${name}` `` | `'Hello ' + name`                      |
| `for (x of arr)`      | `for (var i = 0; i < arr.length; i++)` |
| `{a, b} = obj`        | `var a = obj.a; var b = obj.b;`        |
| `[a, b] = arr`        | `var a = arr[0]; var b = arr[1];`      |
| `...spread`           | Use `Array.prototype.slice.call()`     |
| `class MyClass {}`    | Use constructor functions              |
| `async/await`         | Use GlideRecord callbacks              |
| `Promise`             | Use GlideRecord with callbacks         |

## Common Patterns

### Variable Declarations

```javascript
// WRONG - ES6
const MAX_RETRIES = 3
let currentUser = gs.getUser()

// CORRECT - ES5
var MAX_RETRIES = 3
var currentUser = gs.getUser()
```

### Functions

```javascript
// WRONG - Arrow functions
var active = incidents.filter((inc) => inc.active)
var process = () => {
  return "done"
}

// CORRECT - ES5 functions
var active = []
for (var i = 0; i < incidents.length; i++) {
  if (incidents[i].active) {
    active.push(incidents[i])
  }
}
var process = function () {
  return "done"
}
```

### String Concatenation

```javascript
// WRONG - Template literals
var message = `Incident ${number} assigned to ${user}`

// CORRECT - String concatenation
var message = "Incident " + number + " assigned to " + user
```

### Loops

```javascript
// WRONG - for...of
for (var item of items) {
  gs.info(item)
}

// CORRECT - Traditional for loop
for (var i = 0; i < items.length; i++) {
  gs.info(items[i])
}
```

### Default Parameters

```javascript
// WRONG - Default parameters
function process(incident, priority = 3) {
  // ...
}

// CORRECT - Manual defaults
function process(incident, priority) {
  if (typeof priority === "undefined") {
    priority = 3
  }
  // ...
}
```

## Automatic Validation

Before deploying any server-side script:

1. Check for `const`/`let` declarations - convert to `var`
2. Check for arrow functions `=>` - convert to `function()`
3. Check for template literals `` ` `` - convert to string concatenation
4. Check for destructuring `{a, b}` - convert to explicit property access
5. Check for `for...of` loops - convert to index-based loops

## Exception: Client Scripts

Client-side scripts (Client Scripts, UI Policies) run in the browser and MAY support ES6+ depending on user's browser. However, for maximum compatibility, ES5 is still recommended.
