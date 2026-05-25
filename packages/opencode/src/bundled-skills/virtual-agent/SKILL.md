---
name: virtual-agent
description: Build ServiceNow Virtual Agent — sys_cs_topic conversations, topic blocks (text/prompt/script/decision/handoff), NLU utterances and custom entities, quick replies, and KB/incident integration scripts.
license: Apache-2.0
compatibility: Designed for Snow-Code and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_va_topic_create
  - snow_va_nlu_train
  - snow_query_table
  - snow_find_artifact
---

# Virtual Agent for ServiceNow

Virtual Agent (VA) provides conversational AI capabilities for self-service through chat interfaces.

## Virtual Agent Architecture

### Topic Structure

```
Topic: Password Reset
├── NLU Model
│   ├── Utterances: "reset my password", "forgot password"
│   └── Entities: application_name
├── Topic Blocks (Flow)
│   ├── Greeting
│   ├── Ask for Application
│   ├── Verify User
│   ├── Process Reset
│   └── Confirmation
└── Variables
    ├── user_email
    └── application
```

### Key Tables

| Table                | Purpose                  |
| -------------------- | ------------------------ |
| `sys_cs_topic`       | Topic definitions        |
| `sys_cs_topic_block` | Conversation flow blocks |
| `sys_cs_intent`      | NLU intents              |
| `sys_cs_utterance`   | Training phrases         |
| `sys_cs_entity`      | Custom entities          |

## Topics

### Creating a Topic (ES5)

```javascript
// Create Password Reset topic
var topic = new GlideRecord("sys_cs_topic")
topic.initialize()
topic.setValue("name", "Password Reset")
topic.setValue("description", "Help users reset their passwords")
topic.setValue("active", true)

// NLU configuration
topic.setValue("goal", "I want to reset my password")
topic.setValue("nlu_enabled", true)

// Category
topic.setValue("category", "IT Support")

var topicSysId = topic.insert()
```

### Topic Variables

```javascript
// Add variable to topic
var variable = new GlideRecord("sys_cs_topic_variable")
variable.initialize()
variable.setValue("topic", topicSysId)
variable.setValue("name", "user_email")
variable.setValue("label", "Email Address")
variable.setValue("type", "string")
variable.setValue("mandatory", true)
variable.insert()
```

## Topic Blocks

### Block Types

| Type         | Purpose         | Example                    |
| ------------ | --------------- | -------------------------- |
| **Text**     | Display message | "I can help with that!"    |
| **Prompt**   | Ask question    | "What's your email?"       |
| **Script**   | Run server code | Lookup user, create ticket |
| **Decision** | Branching logic | If VIP then...             |
| **Link**     | External link   | Open portal page           |
| **Handoff**  | Agent transfer  | Connect to live agent      |

### Text Block

```javascript
// Greeting block
var block = new GlideRecord("sys_cs_topic_block")
block.initialize()
block.setValue("topic", topicSysId)
block.setValue("name", "greeting")
block.setValue("type", "text")
block.setValue("order", 100)
block.setValue("message", "Hello! I can help you reset your password. Let me gather some information.")
block.insert()
```

### Prompt Block

```javascript
// Ask for email
var promptBlock = new GlideRecord("sys_cs_topic_block")
promptBlock.initialize()
promptBlock.setValue("topic", topicSysId)
promptBlock.setValue("name", "ask_email")
promptBlock.setValue("type", "prompt")
promptBlock.setValue("order", 200)
promptBlock.setValue("message", "What is your email address?")
promptBlock.setValue("variable_name", "user_email")
promptBlock.setValue("validation_type", "email")
promptBlock.insert()
```

### Script Block (ES5)

```javascript
// Script block to verify user
var scriptBlock = new GlideRecord("sys_cs_topic_block")
scriptBlock.initialize()
scriptBlock.setValue("topic", topicSysId)
scriptBlock.setValue("name", "verify_user")
scriptBlock.setValue("type", "script")
scriptBlock.setValue("order", 300)

// Server-side script (ES5 only!)
scriptBlock.setValue(
  "script",
  "(function execute(inputs, outputs) {\n" +
    "    var email = inputs.user_email;\n" +
    '    var user = new GlideRecord("sys_user");\n' +
    '    user.addQuery("email", email);\n' +
    "    user.query();\n" +
    "    \n" +
    "    if (user.next()) {\n" +
    "        outputs.user_found = true;\n" +
    '        outputs.user_name = user.getValue("name");\n' +
    "        outputs.user_sys_id = user.getUniqueValue();\n" +
    "    } else {\n" +
    "        outputs.user_found = false;\n" +
    "    }\n" +
    "})(inputs, outputs);",
)
scriptBlock.insert()
```

### Decision Block

```javascript
// Decision based on user found
var decisionBlock = new GlideRecord("sys_cs_topic_block")
decisionBlock.initialize()
decisionBlock.setValue("topic", topicSysId)
decisionBlock.setValue("name", "check_user")
decisionBlock.setValue("type", "decision")
decisionBlock.setValue("order", 400)

// Decision branches configured separately
decisionBlock.insert()

// Add decision branches
var branch1 = new GlideRecord("sys_cs_topic_block_branch")
branch1.initialize()
branch1.setValue("block", decisionBlock.getUniqueValue())
branch1.setValue("condition", "user_found == true")
branch1.setValue("next_block", processResetBlockSysId)
branch1.insert()

var branch2 = new GlideRecord("sys_cs_topic_block_branch")
branch2.initialize()
branch2.setValue("block", decisionBlock.getUniqueValue())
branch2.setValue("condition", "user_found == false")
branch2.setValue("next_block", userNotFoundBlockSysId)
branch2.insert()
```

### Handoff Block

```javascript
// Transfer to live agent
var handoffBlock = new GlideRecord("sys_cs_topic_block")
handoffBlock.initialize()
handoffBlock.setValue("topic", topicSysId)
handoffBlock.setValue("name", "transfer_agent")
handoffBlock.setValue("type", "handoff")
handoffBlock.setValue("order", 900)
handoffBlock.setValue("message", "Let me connect you with a live agent who can help further.")
handoffBlock.setValue("queue", liveSupportQueueSysId)
handoffBlock.insert()
```

## NLU Training

### Adding Utterances

```javascript
// Add training utterances for intent
function addUtterance(topicId, text) {
  var utt = new GlideRecord("sys_cs_utterance")
  utt.initialize()
  utt.setValue("topic", topicId)
  utt.setValue("utterance", text)
  utt.insert()
}

// Training phrases for password reset
addUtterance(topicSysId, "reset my password")
addUtterance(topicSysId, "I forgot my password")
addUtterance(topicSysId, "change my password")
addUtterance(topicSysId, "password not working")
addUtterance(topicSysId, "can't log in")
addUtterance(topicSysId, "locked out of my account")
addUtterance(topicSysId, "need to reset password for @application")
```

### Custom Entities

```javascript
// Create custom entity for applications
var entity = new GlideRecord("sys_cs_entity")
entity.initialize()
entity.setValue("name", "application_name")
entity.setValue("description", "Enterprise application names")
entity.setValue("type", "list")
entity.insert()

// Add entity values
var values = ["SAP", "Salesforce", "Workday", "ServiceNow", "Email"]
for (var i = 0; i < values.length; i++) {
  var val = new GlideRecord("sys_cs_entity_value")
  val.initialize()
  val.setValue("entity", entity.getUniqueValue())
  val.setValue("value", values[i])
  val.setValue("synonyms", "") // comma-separated synonyms
  val.insert()
}
```

## Quick Replies

### Configuring Quick Replies

```javascript
// Add quick reply options to prompt
var promptWithReplies = new GlideRecord("sys_cs_topic_block")
promptWithReplies.initialize()
promptWithReplies.setValue("topic", topicSysId)
promptWithReplies.setValue("name", "select_application")
promptWithReplies.setValue("type", "prompt")
promptWithReplies.setValue("order", 150)
promptWithReplies.setValue("message", "Which application do you need to reset?")
promptWithReplies.setValue("variable_name", "application")
promptWithReplies.setValue(
  "quick_replies",
  JSON.stringify([
    { label: "Email", value: "email" },
    { label: "SAP", value: "sap" },
    { label: "ServiceNow", value: "servicenow" },
    { label: "Other", value: "other" },
  ]),
)
promptWithReplies.insert()
```

## Integration Actions

### Create Incident from VA (ES5)

```javascript
// Script block to create incident
var createIncidentScript =
  "(function execute(inputs, outputs) {\n" +
  '    var inc = new GlideRecord("incident");\n' +
  "    inc.initialize();\n" +
  '    inc.setValue("caller_id", inputs.user_sys_id);\n' +
  '    inc.setValue("short_description", "Password Reset Request: " + inputs.application);\n' +
  '    inc.setValue("description", "User requested password reset via Virtual Agent.");\n' +
  '    inc.setValue("category", "software");\n' +
  '    inc.setValue("subcategory", "password reset");\n' +
  '    inc.setValue("priority", 3);\n' +
  "    \n" +
  "    var sysId = inc.insert();\n" +
  "    \n" +
  '    outputs.incident_number = inc.getValue("number");\n' +
  "    outputs.incident_sys_id = sysId;\n" +
  "})(inputs, outputs);"
```

### Lookup Records (ES5)

```javascript
// Script to lookup knowledge articles
var lookupKBScript =
  "(function execute(inputs, outputs) {\n" +
  "    var query = inputs.user_question;\n" +
  "    var articles = [];\n" +
  "    \n" +
  '    var kb = new GlideRecord("kb_knowledge");\n' +
  '    kb.addQuery("workflow_state", "published");\n' +
  '    kb.addQuery("short_description", "CONTAINS", query);\n' +
  "    kb.setLimit(3);\n" +
  "    kb.query();\n" +
  "    \n" +
  "    while (kb.next()) {\n" +
  "        articles.push({\n" +
  '            number: kb.getValue("number"),\n' +
  '            title: kb.getValue("short_description"),\n' +
  "            sys_id: kb.getUniqueValue()\n" +
  "        });\n" +
  "    }\n" +
  "    \n" +
  "    outputs.articles = JSON.stringify(articles);\n" +
  "    outputs.article_count = articles.length;\n" +
  "})(inputs, outputs);"
```

## MCP Tool Integration

### Available VA Tools

| Tool                         | Purpose                  |
| ---------------------------- | ------------------------ |
| `snow_create_va_topic`       | Create topic             |
| `snow_create_va_topic_block` | Add conversation block   |
| `snow_discover_va_topics`    | Find topics              |
| `snow_send_va_message`       | Test conversation        |
| `snow_get_va_conversation`   | Get conversation history |
| `snow_handoff_to_agent`      | Transfer to agent        |

### Example Workflow

```javascript
// 1. Create topic
var topicId = await snow_create_va_topic({
  name: "IT Equipment Request",
  description: "Help users request new equipment",
  category: "IT Support",
})

// 2. Add greeting block
await snow_create_va_topic_block({
  topic: topicId,
  name: "greeting",
  type: "text",
  order: 100,
  message: "I can help you request new IT equipment!",
})

// 3. Add prompt block
await snow_create_va_topic_block({
  topic: topicId,
  name: "equipment_type",
  type: "prompt",
  order: 200,
  message: "What type of equipment do you need?",
  quick_replies: ["Laptop", "Monitor", "Keyboard", "Mouse"],
})

// 4. Test conversation
await snow_send_va_message({
  topic: topicId,
  message: "I need a new laptop",
})
```

## Best Practices

1. **Clear Intents** - One purpose per topic
2. **Rich Training** - Many varied utterances
3. **Graceful Fallback** - Handle unknown inputs
4. **Quick Replies** - Reduce typing
5. **Confirmation** - Verify before actions
6. **Handoff Path** - Always allow agent transfer
7. **Test Thoroughly** - Many conversation paths
8. **Persona** - Consistent friendly tone
