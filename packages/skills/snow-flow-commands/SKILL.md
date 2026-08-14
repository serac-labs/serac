---
name: snow-flow-commands
description: Serac CLI reference — interactive TUI startup, SPARC modes (orchestrator/coder/researcher/TDD), swarm coordination strategies, agent spawning, memory operations, and ServiceNow auth configuration.
license: Apache-2.0
compatibility: Designed for the Serac ServiceNow MCP
metadata:
  author: serac
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
serac

# Start with specific model
serac --model claude-sonnet
serac --model claude-opus
serac --model gpt-4

# Resume previous session
serac --resume
serac --continue
```

### System Status

```bash
# Check system status
serac status

# Real-time monitoring
serac monitor

# Version info
serac --version
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
serac sparc "Create incident dashboard widget"

# Specific mode
serac sparc run coder "Implement auto-assignment business rule"
serac sparc run researcher "Analyze current incident workflow"

# Test-driven development
serac sparc tdd "Add SLA breach notification"
```

## Agent Management

### Spawning Agents

```bash
# Spawn specialized agent
serac agent spawn developer
serac agent spawn researcher
serac agent spawn reviewer

# List active agents
serac agent list

# Agent status
serac agent status <agent-id>
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
serac swarm "Build HR portal with self-service features"

# Swarm options
serac swarm "objective" --strategy parallel
serac swarm "objective" --strategy sequential
serac swarm "objective" --mode development
serac swarm "objective" --monitor
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
serac task create "Implement feature X"

# List tasks
serac task list

# Task status
serac task status <task-id>

# Orchestrate complex task
serac task orchestrate "Multi-step implementation"
```

## Memory Operations

Persistent memory across sessions.

```bash
# Store data
serac memory store <key> <data>

# Retrieve data
serac memory get <key>

# List all keys
serac memory list

# Search memory
serac memory search <query>

# Clear memory
serac memory clear
```

## Configuration

```bash
# Configure ServiceNow instance
serac config instance <url>

# Set credentials
serac config auth

# View configuration
serac config show

# Reset configuration
serac config reset
```

## Authentication

```bash
# Authenticate with ServiceNow
serac auth servicenow

# Authenticate with enterprise services
serac auth enterprise

# Check auth status
serac auth status

# Logout
serac auth logout
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
# 1. Start serac
serac

# 2. In TUI, create Update Set first
# 3. Develop features
# 4. Complete Update Set when done
```

### Debugging Token Usage

```bash
# Enable token debugging
SNOWCODE_DEBUG_TOKENS=true serac

# Check debug output
cat .snow-code/token-debug/debug-*.jsonl | jq .
```

### Multi-Agent Development

```bash
# Start swarm for complex feature
serac swarm "Build customer portal" --strategy parallel --monitor

# Monitor progress
serac monitor
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
