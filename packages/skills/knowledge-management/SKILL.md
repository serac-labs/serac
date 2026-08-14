---
name: knowledge-management
description: Build ServiceNow Knowledge Management — kb_knowledge articles, draft/review/published workflow, kb_category placement, full-text search with snippets, article templates, and kb_feedback rating rollup.
license: Apache-2.0
compatibility: Designed for Snow-Code and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_knowledge_article_manage
  - snow_query_table
  - snow_artifact_manage
---

# Knowledge Management for ServiceNow

Knowledge Management enables creating, organizing, and sharing knowledge articles.

## Knowledge Architecture

```
Knowledge Base (kb_knowledge_base)
    ├── Category (kb_category)
    │   ├── Article (kb_knowledge)
    │   │   ├── Feedback (kb_feedback)
    │   │   └── Use (kb_use)
    │   └── Article
    └── Category
        └── Article
```

## Key Tables

| Table               | Purpose                    |
| ------------------- | -------------------------- |
| `kb_knowledge_base` | Knowledge base definitions |
| `kb_knowledge`      | Knowledge articles         |
| `kb_category`       | Article categories         |
| `kb_feedback`       | User feedback on articles  |
| `kb_use`            | Article usage tracking     |

## Creating Articles (ES5)

### Create Knowledge Article

```javascript
// Create KB article (ES5 ONLY!)
var article = new GlideRecord("kb_knowledge")
article.initialize()

// Basic info
article.setValue("short_description", "How to Reset Your Password")
article.setValue("kb_knowledge_base", getKnowledgeBaseSysId("IT Knowledge"))
article.setValue("kb_category", getCategorySysId("Self-Service"))

// Content
article.setValue(
  "text",
  "<h2>Password Reset Instructions</h2>" +
    "<p>Follow these steps to reset your password:</p>" +
    "<ol>" +
    "<li>Go to the Self-Service Portal</li>" +
    '<li>Click "Forgot Password"</li>' +
    "<li>Enter your email address</li>" +
    "<li>Check your email for reset link</li>" +
    "<li>Create a new password</li>" +
    "</ol>" +
    "<h3>Password Requirements</h3>" +
    "<ul>" +
    "<li>Minimum 12 characters</li>" +
    "<li>At least one uppercase letter</li>" +
    "<li>At least one number</li>" +
    "<li>At least one special character</li>" +
    "</ul>",
)

// Metadata
article.setValue("author", gs.getUserID())
article.setValue("article_type", "text") // text, wiki, html

// Workflow state
article.setValue("workflow_state", "draft")

article.insert()
```

### Article with Attachments

```javascript
// Create article and add attachment (ES5 ONLY!)
var article = new GlideRecord("kb_knowledge")
article.initialize()
article.setValue("short_description", "VPN Setup Guide")
article.setValue("kb_knowledge_base", kbSysId)
article.setValue("text", "<p>See attached PDF for detailed instructions.</p>")
var articleSysId = article.insert()

// Add attachment
var attachment = new GlideSysAttachment()
attachment.copy("kb_knowledge", templateArticleSysId, "kb_knowledge", articleSysId)
```

## Article Workflow

### Workflow States

| State         | Description       | Next States      |
| ------------- | ----------------- | ---------------- |
| **draft**     | Initial creation  | review           |
| **review**    | Awaiting approval | published, draft |
| **published** | Visible to users  | retired          |
| **retired**   | No longer visible | published        |
| **outdated**  | Needs update      | draft            |

### Submit for Review (ES5)

```javascript
// Submit article for review (ES5 ONLY!)
function submitForReview(articleSysId) {
  var article = new GlideRecord("kb_knowledge")
  if (article.get(articleSysId)) {
    // Validate required fields
    if (!article.getValue("short_description")) {
      gs.addErrorMessage("Short description is required")
      return false
    }
    if (!article.getValue("text")) {
      gs.addErrorMessage("Article content is required")
      return false
    }

    // Change state
    article.setValue("workflow_state", "review")
    article.update()

    // Notify reviewers
    gs.eventQueue("kb.article.review", article, "", "")

    return true
  }
  return false
}
```

### Publish Article (ES5)

```javascript
// Publish approved article (ES5 ONLY!)
function publishArticle(articleSysId) {
  var article = new GlideRecord("kb_knowledge")
  if (article.get(articleSysId)) {
    // Only publish from review state
    if (article.getValue("workflow_state") !== "review") {
      gs.addErrorMessage("Article must be in review state")
      return false
    }

    // Set publish date
    article.setValue("workflow_state", "published")
    article.setValue("published", new GlideDateTime())

    // Set expiration if configured
    var kb = article.kb_knowledge_base.getRefRecord()
    var expirationDays = parseInt(kb.getValue("article_expiration_days"), 10)
    if (expirationDays > 0) {
      var expDate = new GlideDateTime()
      expDate.addDaysLocalTime(expirationDays)
      article.setValue("valid_to", expDate)
    }

    article.update()

    return true
  }
  return false
}
```

## Knowledge Search (ES5)

### Search Articles

```javascript
// Search knowledge articles (ES5 ONLY!)
var KnowledgeSearch = Class.create()
KnowledgeSearch.prototype = {
  initialize: function () {},

  /**
   * Search knowledge articles
   * @param {string} query - Search query
   * @param {object} options - Search options
   */
  search: function (query, options) {
    options = options || {}
    var results = []

    var gr = new GlideRecord("kb_knowledge")

    // Only published articles
    gr.addQuery("workflow_state", "published")
    gr.addQuery("active", true)

    // Valid date range
    var now = new GlideDateTime()
    gr.addNullQuery("valid_to").addOrCondition("valid_to", ">", now)

    // Search in title and body
    var qc = gr.addQuery("short_description", "CONTAINS", query)
    qc.addOrCondition("text", "CONTAINS", query)

    // Filter by knowledge base
    if (options.knowledgeBase) {
      gr.addQuery("kb_knowledge_base", options.knowledgeBase)
    }

    // Filter by category
    if (options.category) {
      gr.addQuery("kb_category", options.category)
    }

    // Limit results
    gr.setLimit(options.limit || 10)

    // Order by views/rating
    gr.orderByDesc("sys_view_count")

    gr.query()

    while (gr.next()) {
      results.push({
        sys_id: gr.getUniqueValue(),
        number: gr.getValue("number"),
        title: gr.getValue("short_description"),
        category: gr.kb_category.getDisplayValue(),
        views: gr.getValue("sys_view_count"),
        rating: gr.getValue("rating"),
        snippet: this._getSnippet(gr.getValue("text"), query),
      })
    }

    return results
  },

  _getSnippet: function (text, query) {
    // Strip HTML
    var plainText = text.replace(/<[^>]*>/g, "")

    // Find query position
    var lowerText = plainText.toLowerCase()
    var lowerQuery = query.toLowerCase()
    var pos = lowerText.indexOf(lowerQuery)

    if (pos === -1) {
      return plainText.substring(0, 200) + "..."
    }

    // Extract context around match
    var start = Math.max(0, pos - 50)
    var end = Math.min(plainText.length, pos + query.length + 150)

    var snippet = ""
    if (start > 0) snippet += "..."
    snippet += plainText.substring(start, end)
    if (end < plainText.length) snippet += "..."

    return snippet
  },

  type: "KnowledgeSearch",
}
```

## Article Templates (ES5)

### Create Article from Template

```javascript
// Create article from template (ES5 ONLY!)
function createFromTemplate(templateName, data) {
  // Get template
  var template = new GlideRecord("kb_template")
  template.addQuery("name", templateName)
  template.query()

  if (!template.next()) {
    gs.error("Template not found: " + templateName)
    return null
  }

  // Create article
  var article = new GlideRecord("kb_knowledge")
  article.initialize()

  // Copy template fields
  article.setValue("kb_knowledge_base", template.getValue("kb_knowledge_base"))
  article.setValue("kb_category", template.getValue("kb_category"))
  article.setValue("article_type", template.getValue("article_type"))

  // Process template text with data
  var text = template.getValue("text")
  for (var key in data) {
    if (data.hasOwnProperty(key)) {
      var pattern = new RegExp("\\{\\{" + key + "\\}\\}", "g")
      text = text.replace(pattern, data[key])
    }
  }

  article.setValue("text", text)
  article.setValue("short_description", data.title || "New Article")
  article.setValue("workflow_state", "draft")

  return article.insert()
}

// Usage
var articleId = createFromTemplate("Troubleshooting Guide", {
  title: "Outlook Not Connecting",
  problem: "Outlook shows disconnected",
  solution: "Check network connection and restart Outlook",
  steps: "<ol><li>Close Outlook</li><li>Check WiFi</li><li>Reopen Outlook</li></ol>",
})
```

## Feedback & Ratings (ES5)

### Record Article Feedback

```javascript
// Record user feedback (ES5 ONLY!)
function recordFeedback(articleSysId, rating, comments) {
  var feedback = new GlideRecord("kb_feedback")
  feedback.initialize()
  feedback.setValue("article", articleSysId)
  feedback.setValue("user", gs.getUserID())
  feedback.setValue("rating", rating) // 1-5
  feedback.setValue("comments", comments)
  feedback.setValue("useful", rating >= 4 ? "yes" : "no")
  feedback.insert()

  // Update article rating
  updateArticleRating(articleSysId)
}

function updateArticleRating(articleSysId) {
  var ga = new GlideAggregate("kb_feedback")
  ga.addQuery("article", articleSysId)
  ga.addAggregate("AVG", "rating")
  ga.addAggregate("COUNT")
  ga.query()

  if (ga.next()) {
    var avgRating = parseFloat(ga.getAggregate("AVG", "rating"))
    var count = parseInt(ga.getAggregate("COUNT"), 10)

    var article = new GlideRecord("kb_knowledge")
    if (article.get(articleSysId)) {
      article.setValue("rating", Math.round(avgRating * 10) / 10)
      article.setValue("u_feedback_count", count)
      article.update()
    }
  }
}
```

## MCP Tool Integration

### Available Tools

| Tool                                          | Purpose               |
| --------------------------------------------- | --------------------- |
| `snow_knowledge_article_manage` (action='search') | Search knowledge base |
| `snow_query_table`                            | Query kb_knowledge    |
| `snow_artifact_manage` (action='find')        | Find articles         |
| `snow_execute_script`                         | Test KB scripts       |

### Example Workflow

```javascript
// 1. Search for existing articles
await snow_knowledge_article_manage({
  action: "search",
  query: "password reset",
  limit: 5,
})

// 2. Create new article
await snow_execute_script({
  script: `
        var article = new GlideRecord('kb_knowledge');
        article.initialize();
        article.setValue('short_description', 'New Article');
        article.setValue('text', '<p>Content here</p>');
        article.setValue('workflow_state', 'draft');
        gs.info('Created: ' + article.insert());
    `,
})

// 3. Find articles needing review
await snow_query_table({
  table: "kb_knowledge",
  query: "workflow_state=review",
  fields: "number,short_description,author,sys_created_on",
})
```

## Best Practices

1. **Clear Titles** - Descriptive, searchable titles
2. **Structured Content** - Use headings and lists
3. **Keywords** - Add relevant keywords
4. **Categories** - Proper categorization
5. **Review Process** - Quality control workflow
6. **Expiration** - Set article validity dates
7. **Feedback** - Enable user ratings
8. **ES5 Only** - No modern JavaScript syntax
