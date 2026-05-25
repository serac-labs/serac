---
name: snow-flow-commands
description: Serac CLI reference — interactive TUI startup, SPARC modes (orchestrator/coder/researcher/TDD), swarm coordination strategies, agent spawning, memory operations, and ServiceNow auth configuration.
license: Apache-2.0
compatibility: Designed for Snow-Code CLI
metadata:
  author: groeimetai
  version: "1.0.0"
  category: platform
tools: []
---

# Serac CLI Commands

Serac provides a powerful CLI for ServiceNow development orchestration.

## Core Commands

### Starting Serac

```bash
# Start interactive TUI
snow-flow

# Start with specific model
snow-flow --model claude-sonnet
snow-flow --model claude-opus
snow-flow --model gpt-4

# Resume previous session
snow-flow --resume
snow-flow --continue
```

### System Status

```bash
# Check system status
snow-flow status

# Real-time monitoring
snow-flow monitor

# Version info
snow-flow --version
```

## SPARC Modes

SPARC (Specification, Pseudocode, Architecture, Refinement, Completion) modes provide structured development workflows.

### Available Modes

| Mode             | Command                | Purpose                    |
| ---------------- | ---------------------- | -------------------------- |
| **Orchestrator** | `sparc`                | Multi-agent coordination   |
| **Coder**        | `sparc run coder`      | Direct implementation      |
| **Researcher**   | `sparc run researcher` | Investigation and analysis |
| **TDD**          | `sparc tdd`            | Test-driven development    |

### Usage

```bash
# Orchestrator mode (default)
snow-flow sparc "Create incident dashboard widget"

# Specific mode
snow-flow sparc run coder "Implement auto-assignment business rule"
snow-flow sparc run researcher "Analyze current incident workflow"

# Test-driven development
snow-flow sparc tdd "Add SLA breach notification"
```

## Agent Management

### Spawning Agents

```bash
# Spawn specialized agent
snow-flow agent spawn developer
snow-flow agent spawn researcher
snow-flow agent spawn reviewer

# List active agents
snow-flow agent list

# Agent status
snow-flow agent status <agent-id>
```

### Agent Types

| Type         | Purpose                      |
| ------------ | ---------------------------- |
| `developer`  | ServiceNow artifact creation |
| `researcher` | Investigation and analysis   |
| `reviewer`   | Code review and validation   |
| `tester`     | Testing and QA               |

## Swarm Coordination

Multi-agent swarms for complex tasks.

```bash
# Start swarm with objective
snow-flow swarm "Build HR portal with self-service features"

# Swarm options
snow-flow swarm "objective" --strategy parallel
snow-flow swarm "objective" --strategy sequential
snow-flow swarm "objective" --mode development
snow-flow swarm "objective" --monitor
```

### Swarm Strategies

| Strategy     | Description                |
| ------------ | -------------------------- |
| `parallel`   | Agents work simultaneously |
| `sequential` | Agents work in order       |
| `adaptive`   | Dynamic coordination       |

## Task Management

```bash
# Create task
snow-flow task create "Implement feature X"

# List tasks
snow-flow task list

# Task status
snow-flow task status <task-id>

# Orchestrate complex task
snow-flow task orchestrate "Multi-step implementation"
```

## Memory Operations

Persistent memory across sessions.

```bash
# Store data
snow-flow memory store <key> <data>

# Retrieve data
snow-flow memory get <key>

# List all keys
snow-flow memory list

# Search memory
snow-flow memory search <query>

# Clear memory
snow-flow memory clear
```

## Configuration

```bash
# Configure ServiceNow instance
snow-flow config instance <url>

# Set credentials
snow-flow config auth

# View configuration
snow-flow config show

# Reset configuration
snow-flow config reset
```

## Authentication

```bash
# Authenticate with ServiceNow
snow-flow auth servicenow

# Authenticate with enterprise services
snow-flow auth enterprise

# Check auth status
snow-flow auth status

# Logout
snow-flow auth logout
```

## Environment Variables

| Variable                | Purpose                 |
| ----------------------- | ----------------------- |
| `SNOWCODE_MODEL`        | Default AI model        |
| `SNOWCODE_DEBUG_TOKENS` | Enable token debugging  |
| `SNOWCODE_LOG_LEVEL`    | Logging verbosity       |
| `SERVICENOW_INSTANCE`   | ServiceNow instance URL |

## Common Workflows

### Starting Development Session

```bash
# 1. Start snow-flow
snow-flow

# 2. In TUI, create Update Set first
# 3. Develop features
# 4. Complete Update Set when done
```

### Debugging Token Usage

```bash
# Enable token debugging
SNOWCODE_DEBUG_TOKENS=true snow-flow

# Check debug output
cat .snow-code/token-debug/debug-*.jsonl | jq .
```

### Multi-Agent Development

```bash
# Start swarm for complex feature
snow-flow swarm "Build customer portal" --strategy parallel --monitor

# Monitor progress
snow-flow monitor
```

## TUI Shortcuts

Inside the interactive TUI:

| Key       | Action                   |
| --------- | ------------------------ |
| `Ctrl+C`  | Cancel current operation |
| `Ctrl+D`  | Exit                     |
| `Tab`     | Autocomplete             |
| `Up/Down` | Navigate history         |
| `/help`   | Show help                |
| `/clear`  | Clear screen             |
| `/debug`  | Toggle debug mode        |

## Best Practices

1. **Always start with Update Set** - Track all changes
2. **Use SPARC modes** - Structured development
3. **Monitor tokens** - Watch context usage
4. **Persist memory** - Save important data
5. **Use swarms** - For complex multi-part tasks
