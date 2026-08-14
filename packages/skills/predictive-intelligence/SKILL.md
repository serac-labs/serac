---
name: predictive-intelligence
description: Use ServiceNow Predictive Intelligence — sn_ml.ClassificationPredictor for auto-categorization, SimilarityPredictor for related records, ClusteringPredictor, model training/retraining, and prediction-feedback accuracy tracking.
license: Apache-2.0
compatibility: Designed for Serac and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_query_table
  - snow_execute_script
  - snow_ml_predict
  - snow_list_pi_solutions
  - snow_train_pi_solution
---

# Predictive Intelligence for ServiceNow

Predictive Intelligence uses machine learning to automate categorization, routing, and recommendations.

## PI Capabilities

| Capability         | Use Case                         |
| ------------------ | -------------------------------- |
| **Classification** | Auto-categorize incidents, cases |
| **Similarity**     | Find similar records             |
| **Clustering**     | Group related items              |
| **Regression**     | Predict numeric values           |
| **Recommendation** | Suggest next actions             |

## Key Tables

| Table                      | Purpose                 |
| -------------------------- | ----------------------- |
| `ml_solution`              | ML solution definitions |
| `ml_solution_definition`   | Solution configuration  |
| `ml_capability_definition` | Capability settings     |
| `ml_model`                 | Trained models          |
| `ml_prediction_result`     | Prediction results      |

## Classification (ES5)

### Configure Classification Solution

```javascript
// Create classification solution (ES5 ONLY!)
// Note: Usually done via UI, shown for understanding

var solution = new GlideRecord("ml_solution")
solution.initialize()

solution.setValue("name", "Incident Category Classifier")
solution.setValue("label", "Incident Category Classifier")
solution.setValue("table", "incident")
solution.setValue("active", true)

// Capability type
solution.setValue("capability", "classification")

// Target field to predict
solution.setValue("target_field", "category")

// Input fields for training
solution.setValue("input_fields", "short_description,description")

solution.insert()
```

### Get Classification Prediction

```javascript
// Get classification prediction for record (ES5 ONLY!)
function getClassificationPrediction(tableName, recordSysId, solutionName) {
  var predictor = new sn_ml.ClassificationPredictor(solutionName)

  var gr = new GlideRecord(tableName)
  if (!gr.get(recordSysId)) {
    return null
  }

  try {
    var result = predictor.predict(gr)

    return {
      predicted_value: result.getPredictedValue(),
      confidence: result.getConfidence(),
      top_predictions: result.getTopPredictions(5),
    }
  } catch (e) {
    gs.error("Prediction failed: " + e.message)
    return null
  }
}
```

### Apply Prediction to Record

```javascript
// Auto-apply classification prediction (ES5 ONLY!)
// Business Rule: before, insert, incident

;(function executeRule(current, previous) {
  // Skip if already categorized
  if (current.category) {
    return
  }

  var solutionName = "incident_category_classifier"

  try {
    var predictor = new sn_ml.ClassificationPredictor(solutionName)
    var result = predictor.predict(current)

    // Only apply if confidence is high enough
    if (result.getConfidence() >= 0.8) {
      current.category = result.getPredictedValue()
      current.work_notes =
        "Category auto-assigned by Predictive Intelligence " +
        "(Confidence: " +
        Math.round(result.getConfidence() * 100) +
        "%)"
    }
  } catch (e) {
    gs.warn("Classification prediction failed: " + e.message)
  }
})(current, previous)
```

## Similarity (ES5)

### Find Similar Records

```javascript
// Find similar incidents (ES5 ONLY!)
function findSimilarIncidents(incidentSysId, maxResults) {
  maxResults = maxResults || 5

  var incident = new GlideRecord("incident")
  if (!incident.get(incidentSysId)) {
    return []
  }

  try {
    var similarity = new sn_ml.SimilarityPredictor("incident_similarity")
    var results = similarity.findSimilar(incident, maxResults)

    var similar = []
    for (var i = 0; i < results.length; i++) {
      var match = results[i]
      similar.push({
        sys_id: match.getRecordSysId(),
        similarity_score: match.getSimilarityScore(),
        record: match.getRecord(),
      })
    }

    return similar
  } catch (e) {
    gs.error("Similarity search failed: " + e.message)
    return []
  }
}
```

### Similar Record Widget

```javascript
// Widget Server Script for similar records (ES5 ONLY!)
;(function () {
  if (!input || !input.table || !input.sys_id) {
    data.similar = []
    return
  }

  var solutionName = input.table + "_similarity"

  try {
    var gr = new GlideRecord(input.table)
    if (!gr.get(input.sys_id)) {
      data.similar = []
      return
    }

    var similarity = new sn_ml.SimilarityPredictor(solutionName)
    var results = similarity.findSimilar(gr, 5)

    data.similar = []
    for (var i = 0; i < results.length; i++) {
      var match = results[i]
      var record = match.getRecord()

      data.similar.push({
        sys_id: match.getRecordSysId(),
        score: Math.round(match.getSimilarityScore() * 100),
        number: record.getValue("number"),
        short_description: record.getValue("short_description"),
        state: record.state.getDisplayValue(),
      })
    }
  } catch (e) {
    data.error = "Similarity search unavailable"
    data.similar = []
  }
})()
```

## Clustering (ES5)

### Get Cluster Assignment

```javascript
// Get cluster for record (ES5 ONLY!)
function getClusterAssignment(tableName, recordSysId, solutionName) {
  var gr = new GlideRecord(tableName)
  if (!gr.get(recordSysId)) {
    return null
  }

  try {
    var clustering = new sn_ml.ClusteringPredictor(solutionName)
    var result = clustering.predict(gr)

    return {
      cluster_id: result.getClusterId(),
      cluster_label: result.getClusterLabel(),
      confidence: result.getConfidence(),
    }
  } catch (e) {
    gs.error("Clustering failed: " + e.message)
    return null
  }
}
```

### Analyze Clusters

```javascript
// Get cluster statistics (ES5 ONLY!)
function getClusterStats(solutionName) {
  var stats = []

  var cluster = new GlideRecord("ml_cluster")
  cluster.addQuery("solution.name", solutionName)
  cluster.query()

  while (cluster.next()) {
    stats.push({
      cluster_id: cluster.getValue("cluster_id"),
      label: cluster.getValue("label"),
      size: parseInt(cluster.getValue("record_count"), 10),
      keywords: cluster.getValue("keywords"),
    })
  }

  return stats
}
```

## Training Models (ES5)

### Trigger Model Training

```javascript
// Trigger retraining of ML solution (ES5 ONLY!)
function retrainSolution(solutionName) {
  var solution = new GlideRecord("ml_solution")
  if (!solution.get("name", solutionName)) {
    gs.error("Solution not found: " + solutionName)
    return false
  }

  try {
    // Queue training job
    var trainer = new sn_ml.MLTrainer()
    trainer.train(solution.getUniqueValue())

    gs.info("Training queued for solution: " + solutionName)
    return true
  } catch (e) {
    gs.error("Training failed: " + e.message)
    return false
  }
}
```

### Check Training Status

```javascript
// Check model training status (ES5 ONLY!)
function getTrainingStatus(solutionName) {
  var model = new GlideRecord("ml_model")
  model.addQuery("solution.name", solutionName)
  model.orderByDesc("sys_created_on")
  model.setLimit(1)
  model.query()

  if (model.next()) {
    return {
      model_id: model.getUniqueValue(),
      status: model.getValue("state"),
      accuracy: model.getValue("accuracy"),
      trained_on: model.getValue("sys_created_on"),
      record_count: model.getValue("training_record_count"),
    }
  }

  return null
}
```

## Prediction Results (ES5)

### Store Prediction Feedback

```javascript
// Record prediction feedback for model improvement (ES5 ONLY!)
function recordPredictionFeedback(predictionSysId, wasCorrect, actualValue) {
  var prediction = new GlideRecord("ml_prediction_result")
  if (!prediction.get(predictionSysId)) {
    return false
  }

  prediction.setValue("feedback", wasCorrect ? "correct" : "incorrect")
  prediction.setValue("actual_value", actualValue)
  prediction.setValue("feedback_date", new GlideDateTime())
  prediction.setValue("feedback_user", gs.getUserID())

  prediction.update()

  return true
}
```

### Analyze Prediction Accuracy

```javascript
// Get prediction accuracy stats (ES5 ONLY!)
function getPredictionAccuracy(solutionName, days) {
  days = days || 30

  var startDate = new GlideDateTime()
  startDate.addDaysLocalTime(-days)

  var ga = new GlideAggregate("ml_prediction_result")
  ga.addQuery("solution.name", solutionName)
  ga.addQuery("sys_created_on", ">=", startDate)
  ga.addNotNullQuery("feedback")
  ga.addAggregate("COUNT")
  ga.groupBy("feedback")
  ga.query()

  var stats = { correct: 0, incorrect: 0 }

  while (ga.next()) {
    var feedback = ga.getValue("feedback")
    var count = parseInt(ga.getAggregate("COUNT"), 10)
    stats[feedback] = count
  }

  var total = stats.correct + stats.incorrect
  stats.accuracy = total > 0 ? Math.round((stats.correct / total) * 100) : 0
  stats.total = total

  return stats
}
```

## MCP Tool Integration

### Available Tools

| Tool                       | Purpose                                    |
| -------------------------- | ------------------------------------------ |
| `snow_query_table`         | Query ML tables                            |
| `snow_execute_script`      | Test predictions                           |
| `snow_ml_predict`          | Run a prediction against a trained model   |
| `snow_list_pi_solutions`   | List Predictive Intelligence solutions     |
| `snow_train_pi_solution`   | Train / retrain a solution                 |

### Example Workflow

```javascript
// 1. Query ML solutions
await snow_query_table({
  table: "ml_solution",
  query: "active=true",
  fields: "name,table,capability,target_field",
})

// 2. Check model status
await snow_query_table({
  table: "ml_model",
  query: "solution.active=true",
  fields: "solution,state,accuracy,sys_created_on",
})

// 3. Test prediction
await snow_execute_script({
  script: `
        var result = getClassificationPrediction('incident', 'inc_sys_id', 'incident_classifier');
        gs.info(JSON.stringify(result));
    `,
})
```

## Best Practices

1. **Quality Data** - Clean training data is essential
2. **Feature Selection** - Choose relevant input fields
3. **Confidence Thresholds** - Only apply high-confidence predictions
4. **Feedback Loop** - Collect user feedback
5. **Regular Retraining** - Update models periodically
6. **Monitor Accuracy** - Track prediction performance
7. **Fallback** - Have manual process when prediction fails
8. **ES5 Only** - No modern JavaScript syntax
