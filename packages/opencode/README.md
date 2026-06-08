<p align="center">
<pre align="center">
███████╗███████╗██████╗  █████╗  ██████╗
██╔════╝██╔════╝██╔══██╗██╔══██╗██╔════╝
███████╗█████╗  ██████╔╝███████║██║     
╚════██║██╔══╝  ██╔══██╗██╔══██║██║     
███████║███████╗██║  ██║██║  ██║╚██████╗
╚══════╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝
</pre>
</p>

<h3 align="center">Serac</h3>

<p align="center">The autonomous ServiceNow development agent.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@serac-labs/core"><img alt="npm" src="https://img.shields.io/npm/v/@serac-labs/core?style=for-the-badge&logo=npm&logoColor=white&color=CB3837" /></a>&nbsp;
  <a href="https://github.com/serac-labs/serac/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue?style=for-the-badge" /></a>
</p>

---

## Install

```bash
npm i -g @serac-labs/serac@latest
```

<details>
<summary><b>More installation methods</b></summary>
<br>

```bash
bun i -g @serac-labs/serac@latest                              # Bun
pnpm i -g @serac-labs/serac@latest                             # pnpm
yarn global add @serac-labs/serac@latest                       # Yarn
curl -fsSL https://serac.build/install | bash            # Install script
brew install serac-labs/tap/serac                      # macOS / Linux
scoop install serac                                    # Windows
```

</details>

## Quick Start

```bash
serac
```

That's it. Serac will prompt you to configure an AI provider on first launch.

Or pre-configure in `serac.jsonc`:

```jsonc
{
  "$schema": "https://serac.build/config.json",
  "provider": {
    "anthropic": {},
  },
}
```

## Why Serac?

<table>
<tr>
<td width="50%" valign="top">

**ServiceNow-Native**<br>
<sub>200+ MCP tools and 54 domain skills built for ServiceNow development, deployment, and automation.</sub>

</td>
<td width="50%" valign="top">

**Any AI Provider**<br>
<sub>20+ providers: Anthropic, OpenAI, Google, AWS Bedrock, Azure, Groq, xAI, OpenRouter, and more.</sub>

</td>
</tr>
<tr>
<td width="50%" valign="top">

**Multi-Agent**<br>
<sub>Built-in build &amp; plan agents. Custom agents with per-agent models, permissions, and temperature.</sub>

</td>
<td width="50%" valign="top">

**Extensible**<br>
<sub>MCP ecosystem support (stdio, SSE, HTTP). Plugin system via npm or local packages.</sub>

</td>
</tr>
</table>

## Supported Providers

<table>
<tr>
<td><b>Anthropic</b></td>
<td><b>OpenAI</b></td>
<td><b>Google</b></td>
<td><b>AWS Bedrock</b></td>
</tr>
<tr>
<td><sub>Claude 4.5/4.6</sub></td>
<td><sub>GPT-5, GPT-4, o-series</sub></td>
<td><sub>Gemini 2.5 + Vertex AI</sub></td>
<td><sub>All models, cross-region</sub></td>
</tr>
<tr><td colspan="4">&nbsp;</td></tr>
<tr>
<td><b>Azure</b></td>
<td><b>Mistral</b></td>
<td><b>Groq</b></td>
<td><b>+ 13 more</b></td>
</tr>
<tr>
<td><sub>OpenAI + Cognitive Services</sub></td>
<td><sub>Large, Medium, Small</sub></td>
<td><sub>Ultra-fast inference</sub></td>
<td><sub>xAI, OpenRouter, Copilot, Cohere, Perplexity, ...</sub></td>
</tr>
</table>

## Built-in Tools

```
 File Operations    Shell              Web                 Dev
 ───────────────    ─────              ───                 ───
 read               bash (streaming,   webfetch            plan (enter/exit)
 write              pty support)       websearch           task management
 edit                                  codesearch          LSP (experimental)
 glob                                                      skill invocation
 grep, ls
 apply_patch
```

## ServiceNow MCP Tools

Connect to your ServiceNow instance and access **200+ tools**:

<table>
<tr>
<td valign="top"><sub><b>Operations</b> — Query tables, CMDB, users, metrics</sub></td>
<td valign="top"><sub><b>Development</b> — Script Includes, Business Rules, Client Scripts, UI Policies</sub></td>
</tr>
<tr>
<td valign="top"><sub><b>Deployment</b> — Widgets, Update Sets, validation, rollback</sub></td>
<td valign="top"><sub><b>Automation</b> — Flow Designer, Scheduled Jobs, Approvals, Events</sub></td>
</tr>
<tr>
<td valign="top"><sub><b>Security</b> — ACLs, Domain Separation, compliance, scanning</sub></td>
<td valign="top"><sub><b>Analysis</b> — Reporting, Dashboards, KPIs, Performance Analytics</sub></td>
</tr>
</table>

```jsonc
{
  "mcp": {
    "servicenow": {
      "type": "local",
      "command": ["serac", "mcp", "start"],
      "environment": {
        "SERVICENOW_INSTANCE_URL": "https://your-instance.service-now.com",
        "SERVICENOW_CLIENT_ID": "...",
        "SERVICENOW_CLIENT_SECRET": "...",
      },
    },
  },
}
```

## Agents

| Agent       | Description                                                   |
| :---------- | :------------------------------------------------------------ |
| **build**   | Full access agent for development work                        |
| **plan**    | Read-only agent for analysis — denies edits, asks before bash |
| **general** | Subagent for complex multi-step tasks (`@general`)            |

## CLI

```bash
serac                        # Start TUI
serac serve                  # Headless API server (port 4096)
serac web                    # Server + web interface
serac attach <url>           # Attach to remote server
serac auth                   # Configure authentication
serac models                 # List available models
serac stats                  # Usage statistics
serac export                 # Export session data
serac pr                     # Pull request automation
```

## Configuration

Config is loaded from (in priority order):

| Priority | Source                                 |
| :------- | :------------------------------------- |
| 1        | Remote/well-known organization configs |
| 2        | Global config (`~/.serac/`)        |
| 3        | `SERAC_CONFIG` env variable        |
| 4        | Project config (`serac.jsonc`)     |
| 5        | `SERAC_CONFIG_CONTENT` inline      |

<details>
<summary><b>MCP servers</b></summary>
<br>

```jsonc
{
  "mcp": {
    "my-server": { "type": "local", "command": ["node", "./server.js"] },
    "remote": { "type": "remote", "url": "https://example.com/mcp" },
  },
}
```

Supports stdio, SSE, and streamable HTTP with OAuth.

</details>

<details>
<summary><b>Plugins</b></summary>
<br>

```jsonc
{
  "plugin": ["my-serac-plugin", "file://./local-plugin"],
}
```

</details>

<details>
<summary><b>Permissions</b></summary>
<br>

```jsonc
{
  "permission": {
    "bash": "ask",
    "write": "allow",
    "read": "allow",
    "external_directory": "deny",
  },
}
```

Glob patterns, per-agent rulesets, and env file protection included.

</details>

## Links

- [Documentation](https://serac.build/docs) — Full configuration reference and guides
- [GitHub](https://github.com/serac-labs/serac) — Source code and issues
- [Contributing](https://github.com/serac-labs/serac/blob/main/CONTRIBUTING.md) — How to contribute

## License

Apache 2.0 — see [LICENSE](https://github.com/serac-labs/serac/blob/main/LICENSE) and [NOTICE](https://github.com/serac-labs/serac/blob/main/NOTICE). Built on the MIT-licensed [opencode](https://github.com/anomalyco/opencode) project.
