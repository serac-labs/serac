---
name: document-management
description: Handle ServiceNow attachments from both sides — the six /api/now/attachment tools that move file bytes in and out of the agent, and GlideSysAttachment for copying between records — plus document generation from sys_report_template, PDFs, dms_document versioning, and attachment access checks.
license: Apache-2.0
compatibility: Designed for Serac and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_query_table
  - snow_execute_script
  - snow_artifact_manage
  - snow_upload_attachment
  - snow_attach_file
  - snow_file_upload
  - snow_get_attachments
  - snow_file_download
  - snow_delete_attachment
  - snow_acl_explain
---

# Document Management for ServiceNow

Document Management handles attachments, templates, and document generation.

## Document Architecture

```
Record
    ├── Attachments (sys_attachment)
    │   └── Attachment Data (sys_attachment_doc)
    ├── Generated Documents
    └── Document Templates
```

## Key Tables

| Table                 | Purpose             |
| --------------------- | ------------------- |
| `sys_attachment`      | Attachment metadata |
| `sys_attachment_doc`  | Attachment content  |
| `sys_report_template` | Report templates    |
| `dms_document`        | Document records    |

## Attachments (ES5)

### Upload Attachment

```javascript
// Attach file to record (ES5 ONLY!)
function attachFile(tableName, recordSysId, fileName, contentType, content) {
  var attachment = new GlideSysAttachment()

  // Content can be base64 encoded string
  var attachmentSysId = attachment.write(tableName, recordSysId, fileName, contentType, content)

  return attachmentSysId
}

// Example
var base64Content = "SGVsbG8gV29ybGQh" // Base64 encoded
attachFile("incident", incidentSysId, "notes.txt", "text/plain", base64Content)
```

### Read Attachment

```javascript
// Read attachment content (ES5 ONLY!)
function getAttachmentContent(attachmentSysId) {
  var attachment = new GlideSysAttachment()
  var content = attachment.getContent(attachmentSysId)
  return content
}

// Get attachment as base64
function getAttachmentBase64(attachmentSysId) {
  var attachment = new GlideSysAttachment()
  var bytes = attachment.getBytes(attachmentSysId)

  // Convert to base64
  var base64 = GlideBase64.encode(bytes)
  return base64
}
```

### List Attachments

```javascript
// Get all attachments for record (ES5 ONLY!)
function getRecordAttachments(tableName, recordSysId) {
  var attachments = []

  var gr = new GlideRecord("sys_attachment")
  gr.addQuery("table_name", tableName)
  gr.addQuery("table_sys_id", recordSysId)
  gr.query()

  while (gr.next()) {
    attachments.push({
      sys_id: gr.getUniqueValue(),
      file_name: gr.getValue("file_name"),
      content_type: gr.getValue("content_type"),
      size_bytes: gr.getValue("size_bytes"),
      created_on: gr.getValue("sys_created_on"),
      created_by: gr.sys_created_by.getDisplayValue(),
    })
  }

  return attachments
}
```

### Copy Attachments

```javascript
// Copy attachments between records (ES5 ONLY!)
function copyAttachments(sourceTable, sourceSysId, targetTable, targetSysId) {
  var attachment = new GlideSysAttachment()
  attachment.copy(sourceTable, sourceSysId, targetTable, targetSysId)
}

// Copy specific attachment
function copyOneAttachment(attachmentSysId, targetTable, targetSysId) {
  var source = new GlideRecord("sys_attachment")
  if (!source.get(attachmentSysId)) {
    return null
  }

  var attachment = new GlideSysAttachment()
  var content = attachment.getBytes(attachmentSysId)

  return attachment.write(
    targetTable,
    targetSysId,
    source.getValue("file_name"),
    source.getValue("content_type"),
    content,
  )
}
```

## Document Templates (ES5)

### Create Document Template

```javascript
// Create document template (ES5 ONLY!)
var template = new GlideRecord("sys_report_template")
template.initialize()

template.setValue("name", "Incident Summary Report")
template.setValue("table", "incident")
template.setValue("description", "Summary report for incident resolution")

// Template content with placeholders
template.setValue(
  "template",
  "<html>\n" +
    "<head><title>Incident Summary</title></head>\n" +
    "<body>\n" +
    "<h1>Incident Summary Report</h1>\n" +
    "<h2>${number}</h2>\n" +
    "<p><strong>Description:</strong> ${short_description}</p>\n" +
    "<p><strong>Caller:</strong> ${caller_id.name}</p>\n" +
    "<p><strong>Priority:</strong> ${priority}</p>\n" +
    "<p><strong>State:</strong> ${state}</p>\n" +
    "<p><strong>Resolution:</strong> ${close_notes}</p>\n" +
    "<p><strong>Resolved By:</strong> ${resolved_by.name}</p>\n" +
    "<p><strong>Resolved On:</strong> ${resolved_at}</p>\n" +
    "</body>\n" +
    "</html>",
)

template.insert()
```

### Generate Document from Template

```javascript
// Generate document from template (ES5 ONLY!)
function generateDocumentFromTemplate(templateName, recordSysId) {
  // Get template
  var template = new GlideRecord("sys_report_template")
  if (!template.get("name", templateName)) {
    return null
  }

  // Get record
  var tableName = template.getValue("table")
  var gr = new GlideRecord(tableName)
  if (!gr.get(recordSysId)) {
    return null
  }

  // Process template
  var content = template.getValue("template")
  content = processTemplateVariables(content, gr)

  return content
}

function processTemplateVariables(template, gr) {
  // Replace ${field} and ${field.property} patterns
  var pattern = /\$\{([^}]+)\}/g
  var match

  while ((match = pattern.exec(template)) !== null) {
    var fieldPath = match[1]
    var value = getFieldValue(gr, fieldPath)
    template = template.replace(match[0], value)
  }

  return template
}

function getFieldValue(gr, fieldPath) {
  var parts = fieldPath.split(".")
  var value = gr

  for (var i = 0; i < parts.length; i++) {
    if (!value) return ""

    if (i < parts.length - 1) {
      // Reference field - get referenced record
      value = value[parts[i]].getRefRecord()
    } else {
      // Final field
      if (value.isValidField && value.isValidField(parts[i])) {
        value = value[parts[i]].getDisplayValue() || value.getValue(parts[i])
      } else {
        value = ""
      }
    }
  }

  return value || ""
}
```

## PDF Generation (ES5)

### Generate PDF

```javascript
// Generate PDF from HTML (ES5 ONLY!)
function generatePDF(htmlContent, fileName) {
  try {
    var pdfCreator = new sn_pdfgeneratorutils.PDFGenerationAPI()
    var pdfBytes = pdfCreator.convertToPDF(htmlContent)

    // Return as base64
    return {
      success: true,
      content: GlideBase64.encode(pdfBytes),
      fileName: fileName || "document.pdf",
    }
  } catch (e) {
    gs.error("PDF generation failed: " + e.message)
    return {
      success: false,
      error: e.message,
    }
  }
}

// Generate and attach PDF to record
function generateAndAttachPDF(templateName, recordSysId, fileName) {
  // Generate HTML from template
  var html = generateDocumentFromTemplate(templateName, recordSysId)
  if (!html) {
    return { success: false, error: "Template generation failed" }
  }

  // Convert to PDF
  var pdf = generatePDF(html, fileName)
  if (!pdf.success) {
    return pdf
  }

  // Get table name from template
  var template = new GlideRecord("sys_report_template")
  template.get("name", templateName)
  var tableName = template.getValue("table")

  // Attach PDF
  var attachmentSysId = attachFile(tableName, recordSysId, fileName, "application/pdf", pdf.content)

  return {
    success: true,
    attachment_sys_id: attachmentSysId,
  }
}
```

## Document Workflow (ES5)

### Document Approval

```javascript
// Create document for approval (ES5 ONLY!)
function submitDocumentForApproval(documentSysId, approvers) {
  var doc = new GlideRecord("dms_document")
  if (!doc.get(documentSysId)) {
    return { success: false, message: "Document not found" }
  }

  // Update state
  doc.setValue("state", "pending_approval")
  doc.update()

  // Create approval records
  for (var i = 0; i < approvers.length; i++) {
    var approval = new GlideRecord("sysapproval_approver")
    approval.initialize()
    approval.setValue("sysapproval", documentSysId)
    approval.setValue("approver", approvers[i])
    approval.setValue("state", "requested")
    approval.insert()
  }

  // Notify approvers
  gs.eventQueue("document.approval.requested", doc, approvers.join(","), "")

  return { success: true }
}
```

### Version Control

```javascript
// Create new document version (ES5 ONLY!)
function createDocumentVersion(documentSysId, newContent, changeNotes) {
  var doc = new GlideRecord("dms_document")
  if (!doc.get(documentSysId)) {
    return null
  }

  // Get current version
  var currentVersion = parseInt(doc.getValue("version"), 10) || 1
  var newVersion = currentVersion + 1

  // Archive current version
  var archive = new GlideRecord("dms_document_version")
  archive.initialize()
  archive.setValue("document", documentSysId)
  archive.setValue("version", currentVersion)
  archive.setValue("content", doc.getValue("content"))
  archive.setValue("created_by", gs.getUserID())
  archive.insert()

  // Update document with new version
  doc.setValue("version", newVersion)
  doc.setValue("content", newContent)
  doc.work_notes = "Version " + newVersion + ": " + changeNotes
  doc.update()

  return {
    document_sys_id: documentSysId,
    version: newVersion,
  }
}

// Get document version history
function getDocumentVersions(documentSysId) {
  var versions = []

  var version = new GlideRecord("dms_document_version")
  version.addQuery("document", documentSysId)
  version.orderByDesc("version")
  version.query()

  while (version.next()) {
    versions.push({
      version: version.getValue("version"),
      created_on: version.getValue("sys_created_on"),
      created_by: version.sys_created_by.getDisplayValue(),
    })
  }

  return versions
}
```

## Attachment Security (ES5)

### Check Attachment Access

```javascript
// Check if user can access attachment (ES5 ONLY!)
function canAccessAttachment(attachmentSysId) {
  var attachment = new GlideRecord("sys_attachment")
  if (!attachment.get(attachmentSysId)) {
    return false
  }

  // Check access to parent record
  var parentTable = attachment.getValue("table_name")
  var parentSysId = attachment.getValue("table_sys_id")

  var parent = new GlideRecord(parentTable)
  return parent.get(parentSysId) // Returns false if no read access
}
```

## Moving files in and out: the attachment tools

Everything above this line is the script side. It can copy an attachment from one record to another and
read what is already there, and it can do neither of the two things people usually want: **get a file the
agent is holding into a record, or get a file out of the instance and into the agent.** A background
script has no access to the agent's filesystem and cannot return megabytes of bytes to it. Six tools go
over `/api/now/attachment` instead.

| Tool                     | Direction | Takes                                        |
| ------------------------ | --------- | -------------------------------------------- |
| `snow_upload_attachment` | in        | base64 in `content`                          |
| `snow_file_upload`       | in        | base64 in `file_data` — same endpoint, different parameter names |
| `snow_attach_file`       | in        | a **local path**, read and posted multipart  |
| `snow_get_attachments`   | out       | `table_name` + `table_sys_id`, returns metadata only |
| `snow_file_download`     | out       | `attachment_sys_id`, returns base64 + content type |
| `snow_delete_attachment` | —         | `attachment_sys_id`, deletes permanently     |

### base64 or a path

`snow_upload_attachment` and `snow_file_upload` hit the same endpoint with the same semantics; they differ
only in what the parameters are called (`content`/`table_sys_id` versus `file_data`/`record_sys_id`).
Neither reads a file — you hand them bytes you already have.

`snow_attach_file` is the one that reads from disk. It stats the file first and refuses above
`max_size_mb`, which **defaults to 25** — a client-side guard, not the instance's. The instance has its own
limit in `com.glide.attachment.max_size` (MB, 1024 by default but very often lowered), and
`glide.attachment.extensions` restricts which suffixes are accepted at all. A file inside your 25 MB and
outside the instance's limit fails at the API with a 400, not at the guard.

Base64 inflates by a third, so a 24 MB file is a 32 MB request body. If you are pushing anything large,
prefer `snow_attach_file` — multipart sends the bytes as they are.

### Reading a file back

`snow_get_attachments` returns metadata only: `sys_id`, `file_name`, `size_bytes`, `content_type`. Two
calls to get content, always:

```javascript
const list = await snow_get_attachments({ table_name: "incident", table_sys_id: incSysId })
const shot = list.attachments.find((a) => a.content_type.indexOf("image/") === 0)
const file = await snow_file_download({ attachment_sys_id: shot.sys_id })  // base64 + content_type
```

There is no "download every attachment on this record" call. Loop the list yourself, and check
`size_bytes` before you do — the response carries the whole file as base64 in the tool result.

### When the table restricts attachments

Attachment access is not the parent record's ACL. It is resolved through `sys_attachment`, and three
things gate it independently:

- **`glide.attachment.role`** — an instance property naming a role required to attach at all.
- **Table-level attachment control.** A table can be marked so that only users with a named role may
  attach or read; `sys_security_acl` rows on `sys_attachment` with the parent table as their condition
  are the usual mechanism.
- **The parent record's own read ACL.** Losing read on the incident loses its attachments too.

The failure shape is worth recognising because it is misleading. `sys_attachment` is a table like any
other, so a caller who cannot read it gets an **empty list rather than an error** — `snow_get_attachments`
returning `[]` on a record that visibly has attachments in the UI is a permissions answer, not an empty
record. Read failures on a single attachment tend to surface as not-found rather than forbidden, because
the platform does not confirm that a sys_id you cannot see exists. So "attachment not found" straight
after a successful listing on the same record is a permissions difference between the two reads, not a
deleted file. Check with `snow_acl_explain` against `sys_attachment` before assuming the file is gone.

`snow_delete_attachment` is a hard delete of the `sys_attachment` row and its `sys_attachment_doc`
chunks. There is no recycle bin and it is not captured in an update set — it is data, not configuration.

## MCP Tool Integration

### Available Tools

| Tool                     | Purpose                                                |
| ------------------------ | ------------------------------------------------------ |
| `snow_query_table`       | Query attachments and templates                        |
| `snow_execute_script`    | Test document scripts                                  |
| `snow_artifact_manage`   | Find artifacts (`action: "find"`, `type` required)     |
| `snow_get_attachments`   | List what is attached to a record                      |
| `snow_file_download`     | Fetch one attachment's bytes                           |
| `snow_attach_file`       | Attach a local file (multipart)                        |
| `snow_upload_attachment` | Attach base64 content                                  |
| `snow_file_upload`       | Attach base64 content (alternative parameter names)    |
| `snow_delete_attachment` | Delete an attachment permanently                       |

### Example Workflow

```javascript
// 1. Get record attachments
await snow_query_table({
  table: "sys_attachment",
  query: "table_name=incident^table_sys_id=inc_sys_id",
  fields: "file_name,content_type,size_bytes,sys_created_on",
})

// 2. Generate document
await snow_execute_script({
  script: `
        var html = generateDocumentFromTemplate('Incident Summary', 'inc_sys_id');
        gs.info('Generated: ' + (html ? 'success' : 'failed'));
    `,
})

// 3. Find document templates
await snow_query_table({
  table: "sys_report_template",
  query: "table=incident",
  fields: "name,description,table",
})
```

## Best Practices

1. **File Types** - Restrict allowed types
2. **Size Limits** - Set max file sizes
3. **Virus Scanning** - Scan uploads
4. **Access Control** - Inherit from parent
5. **Version Control** - Track changes
6. **Cleanup** - Remove orphaned files
7. **Templates** - Use for consistency
8. **ES5 Only** - No modern JavaScript syntax
