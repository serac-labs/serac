---
name: scheduled-jobs
description: Create ServiceNow scheduled jobs on sysauto_script — daily/weekly cron patterns, batch processing with time/runtime limits, conditional execution, error notifications, and metrics recording.
license: Apache-2.0
compatibility: Designed for Snow-Code and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_schedule_job
  - snow_find_artifact
  - snow_edit_artifact
  - snow_execute_script_with_output
---

# Scheduled Jobs for ServiceNow

Scheduled Jobs automate recurring tasks, batch processing, and maintenance operations.

## Job Types

| Type                           | Table              | Purpose                    |
| ------------------------------ | ------------------ | -------------------------- |
| **Scheduled Script Execution** | sysauto_script     | Run custom scripts         |
| **Report Scheduler**           | sysauto_report     | Generate and email reports |
| **Table Cleaner**              | sys_auto_flush     | Delete old records         |
| **LDAP Refresh**               | ldap_server_config | Sync LDAP data             |
| **Discovery**                  | discovery_schedule | Network discovery          |

## Scheduled Script Execution (ES5)

### Basic Scheduled Job

```javascript
// Table: sysauto_script
// Name: Close Stale Incidents
// Run: Daily at 2:00 AM

// Script (ES5 ONLY!):
;(function executeScheduledJob() {
  var LOG_PREFIX = "[CloseStaleIncidents] "
  var closedCount = 0

  // Find incidents inactive for 30 days
  var staleDate = new GlideDateTime()
  staleDate.addDaysLocalTime(-30)

  var gr = new GlideRecord("incident")
  gr.addQuery("state", "IN", "1,2,3") // New, In Progress, On Hold
  gr.addQuery("sys_updated_on", "<", staleDate)
  gr.addQuery("active", true)
  gr.query()

  gs.info(LOG_PREFIX + "Found " + gr.getRowCount() + " stale incidents")

  while (gr.next()) {
    gr.state = 7 // Closed
    gr.close_code = "Closed/Resolved by Caller"
    gr.close_notes = "Auto-closed due to 30 days of inactivity"
    gr.update()
    closedCount++
  }

  gs.info(LOG_PREFIX + "Closed " + closedCount + " stale incidents")
})()
```

### Scheduled Job with Error Handling (ES5)

```javascript
// Name: Sync User Data
// Run: Every 6 hours

;(function executeScheduledJob() {
  var LOG_PREFIX = "[SyncUserData] "
  var stats = {
    processed: 0,
    updated: 0,
    errors: 0,
  }

  try {
    // Get users needing sync
    var gr = new GlideRecord("sys_user")
    gr.addQuery("u_needs_sync", true)
    gr.addQuery("active", true)
    gr.setLimit(1000) // Process in batches
    gr.query()

    while (gr.next()) {
      stats.processed++
      try {
        var updated = syncUserFromSource(gr)
        if (updated) {
          stats.updated++
        }
      } catch (e) {
        stats.errors++
        gs.error(LOG_PREFIX + "Error syncing user " + gr.user_name + ": " + e.message)
      }
    }

    gs.info(LOG_PREFIX + "Sync complete: " + JSON.stringify(stats))

    // Send summary email if errors
    if (stats.errors > 0) {
      sendErrorSummary(stats)
    }
  } catch (e) {
    gs.error(LOG_PREFIX + "Job failed: " + e.message)
    notifyAdmins("User sync job failed: " + e.message)
  }

  function syncUserFromSource(userGr) {
    // Sync logic here
    userGr.u_needs_sync = false
    userGr.u_last_sync = new GlideDateTime()
    return userGr.update()
  }

  function sendErrorSummary(stats) {
    gs.eventQueue("user.sync.errors", null, JSON.stringify(stats), "")
  }

  function notifyAdmins(message) {
    gs.eventQueue("system.job.failure", null, message, "")
  }
})()
```

### Batch Processing Job (ES5)

```javascript
// Name: Process Large Dataset
// Run: Weekly on Sunday at 1:00 AM

;(function executeScheduledJob() {
  var LOG_PREFIX = "[BatchProcessor] "
  var BATCH_SIZE = 500
  var MAX_RUNTIME = 3600000 // 1 hour in ms
  var startTime = new Date().getTime()

  var processed = 0
  var hasMore = true

  while (hasMore && !isTimeExceeded()) {
    hasMore = processBatch()
  }

  if (hasMore) {
    gs.warn(LOG_PREFIX + "Job stopped due to time limit. Processed: " + processed)
    // Re-queue for next run
    queueContinuation()
  } else {
    gs.info(LOG_PREFIX + "Job complete. Total processed: " + processed)
  }

  function processBatch() {
    var gr = new GlideRecord("u_large_table")
    gr.addQuery("u_processed", false)
    gr.setLimit(BATCH_SIZE)
    gr.query()

    if (!gr.hasNext()) {
      return false
    }

    while (gr.next()) {
      processRecord(gr)
      processed++
    }

    return true
  }

  function processRecord(gr) {
    // Processing logic
    gr.u_processed = true
    gr.u_processed_date = new GlideDateTime()
    gr.update()
  }

  function isTimeExceeded() {
    var elapsed = new Date().getTime() - startTime
    return elapsed > MAX_RUNTIME
  }

  function queueContinuation() {
    // Queue another run
    var job = new GlideRecord("sysauto_script")
    if (job.get("name", "Process Large Dataset - Continuation")) {
      job.next_action = new GlideDateTime()
      job.update()
    }
  }
})()
```

## Schedule Configuration

### Run Frequencies

| Frequency         | Cron            | Example        |
| ----------------- | --------------- | -------------- |
| Every 5 minutes   | `0 */5 * * * ?` | Health checks  |
| Hourly            | `0 0 * * * ?`   | Data sync      |
| Daily at midnight | `0 0 0 * * ?`   | Cleanup        |
| Weekly Sunday     | `0 0 0 ? * SUN` | Reports        |
| Monthly 1st       | `0 0 0 1 * ?`   | Billing        |
| Custom            | Various         | Specific needs |

### Create Scheduled Job (ES5)

```javascript
// Create scheduled job programmatically (ES5 ONLY!)
var job = new GlideRecord("sysauto_script")
job.initialize()
job.setValue("name", "Nightly Cleanup")
job.setValue("active", true)

// Schedule: Daily at 2:00 AM
job.setValue("run_type", "daily")
job.setValue("run_time", "02:00:00")
// Or use explicit schedule
job.setValue("run_dayofweek", "daily")

// Script
job.setValue(
  "script",
  "(function executeScheduledJob() {\n" +
    '    var gr = new GlideRecord("sys_audit_delete");\n' +
    '    gr.addQuery("sys_created_on", "<", gs.daysAgo(90));\n' +
    "    gr.deleteMultiple();\n" +
    '    gs.info("Cleanup complete");\n' +
    "})();",
)

// Run as system
job.setValue("run_as", "") // Empty = System

job.insert()
```

### Conditional Execution

```javascript
// Job that checks conditions before running (ES5 ONLY!)
;(function executeScheduledJob() {
  var LOG_PREFIX = "[ConditionalJob] "

  // Check if job should run
  if (!shouldRun()) {
    gs.info(LOG_PREFIX + "Skipping execution - conditions not met")
    return
  }

  // Execute main logic
  executeMainTask()

  function shouldRun() {
    // Check business hours
    var now = new GlideDateTime()
    var hour = parseInt(now.getLocalTime().getByFormat("HH"), 10)

    // Only run outside business hours (before 6am or after 8pm)
    if (hour >= 6 && hour < 20) {
      return false
    }

    // Check for active change freeze
    var freeze = new GlideRecord("change_request")
    freeze.addQuery("type", "freeze")
    freeze.addQuery("state", "implement")
    freeze.query()

    if (freeze.hasNext()) {
      gs.info(LOG_PREFIX + "Change freeze active")
      return false
    }

    return true
  }

  function executeMainTask() {
    // Main job logic here
    gs.info(LOG_PREFIX + "Executing main task")
  }
})()
```

## Job Monitoring

### Check Job Status (ES5)

```javascript
// Query scheduled job history (ES5 ONLY!)
var history = new GlideRecord("sys_trigger")
history.addQuery("name", "CONTAINS", "Nightly Cleanup")
history.orderByDesc("sys_created_on")
history.setLimit(10)
history.query()

while (history.next()) {
  gs.info(
    "Job: " +
      history.getValue("name") +
      " | State: " +
      history.getValue("state") +
      " | Next: " +
      history.getValue("next_action"),
  )
}
```

### Job with Metrics (ES5)

```javascript
// Job that records performance metrics (ES5 ONLY!)
;(function executeScheduledJob() {
  var LOG_PREFIX = "[MetricsJob] "
  var startTime = new Date().getTime()
  var metrics = {
    startTime: new GlideDateTime().getDisplayValue(),
    recordsProcessed: 0,
    errors: 0,
  }

  try {
    // Main processing
    var gr = new GlideRecord("incident")
    gr.addQuery("active", true)
    gr.query()

    while (gr.next()) {
      processRecord(gr)
      metrics.recordsProcessed++
    }
  } catch (e) {
    metrics.errors++
    gs.error(LOG_PREFIX + "Error: " + e.message)
  } finally {
    // Record metrics
    metrics.endTime = new GlideDateTime().getDisplayValue()
    metrics.duration = (new Date().getTime() - startTime) / 1000
    recordMetrics(metrics)
  }

  function processRecord(gr) {
    // Processing logic
  }

  function recordMetrics(metrics) {
    var metricsRecord = new GlideRecord("u_job_metrics")
    metricsRecord.initialize()
    metricsRecord.setValue("u_job_name", "MetricsJob")
    metricsRecord.setValue("u_start_time", metrics.startTime)
    metricsRecord.setValue("u_end_time", metrics.endTime)
    metricsRecord.setValue("u_duration", metrics.duration)
    metricsRecord.setValue("u_records_processed", metrics.recordsProcessed)
    metricsRecord.setValue("u_errors", metrics.errors)
    metricsRecord.insert()

    gs.info(LOG_PREFIX + "Metrics: " + JSON.stringify(metrics))
  }
})()
```

## MCP Tool Integration

### Available Tools

| Tool                              | Purpose                  |
| --------------------------------- | ------------------------ |
| `snow_schedule_job`               | Create scheduled job     |
| `snow_find_artifact`              | Find existing jobs       |
| `snow_execute_script_with_output` | Test job script          |
| `snow_get_logs`                   | Check job execution logs |

### Example Workflow

```javascript
// 1. Create scheduled job
await snow_schedule_job({
  name: "Daily Report Generator",
  run_type: "daily",
  run_time: "06:00:00",
  script: "/* report generation script */",
  active: true,
})

// 2. Test the script
await snow_execute_script_with_output({
  script: "/* test job script */",
})

// 3. Check logs
await snow_get_logs({
  filter: 'message CONTAINS "Daily Report"',
  limit: 50,
})
```

## Best Practices

1. **Logging** - Comprehensive logging for debugging
2. **Error Handling** - Try-catch with notifications
3. **Batching** - Process large datasets in batches
4. **Time Limits** - Check runtime to prevent timeouts
5. **Off-Peak** - Schedule during low-usage periods
6. **Idempotent** - Safe to run multiple times
7. **Monitoring** - Record metrics and status
8. **ES5 Only** - No modern JavaScript syntax
