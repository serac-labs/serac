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

<h3 align="center">The terminal-native AI agent for ServiceNow developers and consultants.</h3>

<p align="center">
  Your terminal &bull; your keys (BYOK, 20+ providers) &bull; every instance &bull; 429 ServiceNow MCP tools
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@serac-labs/core"><img alt="npm" src="https://img.shields.io/npm/v/@serac-labs/core?style=for-the-badge&logo=npm&logoColor=white&color=CB3837" /></a>&nbsp;
  <a href="https://www.npmjs.com/package/@serac-labs/core"><img alt="Downloads" src="https://img.shields.io/npm/dw/@serac-labs/core?style=for-the-badge&logo=npm&logoColor=white&label=downloads&color=CB3837" /></a>&nbsp;
  <a href="https://github.com/serac-labs/serac/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/serac-labs/serac?style=for-the-badge&logo=github&color=yellow" /></a>&nbsp;
  <a href="https://github.com/serac-labs/serac"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" /></a>&nbsp;
  <a href="https://github.com/serac-labs/serac/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue?style=for-the-badge" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> &bull;
  <a href="README.zh.md">简体中文</a> &bull;
  <a href="README.zht.md">繁體中文</a> &bull;
  <a href="README.ko.md">한국어</a> &bull;
  <a href="README.de.md">Deutsch</a> &bull;
  <a href="README.es.md">Español</a> &bull;
  <a href="README.fr.md">Français</a> &bull;
  <a href="README.it.md">Italiano</a> &bull;
  <a href="README.da.md">Dansk</a> &bull;
  <a href="README.ja.md">日本語</a> &bull;
  <a href="README.pl.md">Polski</a> &bull;
  <a href="README.ru.md">Русский</a> &bull;
  <a href="README.ar.md">العربية</a> &bull;
  <a href="README.no.md">Norsk</a> &bull;
  <a href="README.br.md">Português (Brasil)</a>
</p>

<br>

Serac is a terminal-native AI development agent purpose-built for **ServiceNow**. It brings 429 ServiceNow MCP tools, 55 bundled domain skills (including Blast Radius impact analysis), and 20+ AI providers into your own terminal — your editor, your keys (BYOK), and any instance you connect to. It's built for ServiceNow developers and the consultants who work across many client instances. Serac extends the open-source [opencode](https://github.com/anomalyco/opencode) agent with a deep ServiceNow domain layer.

<br>

<table>
<tr>
<td width="33%" valign="top">

**ServiceNow-Native**<br>
<sub>429 MCP tools and 55 domain skills (including Blast Radius impact analysis) purpose-built for ServiceNow development, deployment, and automation.</sub>

</td>
<td width="33%" valign="top">

**Any AI Provider**<br>
<sub>Works with 20+ providers: Anthropic, OpenAI, Google, AWS Bedrock, Azure, Groq, and many more.</sub>

</td>
<td width="33%" valign="top">

**Multi-Agent**<br>
<sub>Built-in build &amp; plan agents with configurable permissions, custom agents, and subagent orchestration.</sub>

</td>
</tr>
<tr>
<td width="33%" valign="top">

**Terminal-First**<br>
<sub>Beautiful TUI built with SolidJS + opentui.</sub>

</td>
<td width="33%" valign="top">

**MCP Ecosystem**<br>
<sub>Connect any MCP server via stdio, SSE, or HTTP. Extend with the full MCP ecosystem.</sub>

</td>
<td width="33%" valign="top">

**Open Source**<br>
<sub>Apache License 2.0. Fully transparent. Built on opencode.</sub>

</td>
</tr>
</table>

<br>

## Getting Started

### Install

```bash
curl -fsSL https://serac.build/install | bash
```

<details>
<summary><b>More installation methods</b></summary>
<br>

```bash
# npm / bun / pnpm / yarn
npm i -g @serac-labs/serac@latest

# Homebrew (macOS & Linux — recommended, always up to date)
brew install serac-labs/tap/serac

# Windows
scoop install serac
choco install serac

# Arch Linux
paru -S serac-bin
```

> [!TIP]
> Remove versions older than 0.1.x before installing.

</details>

### Quick Start

```bash
serac
```

On first launch, Serac prompts you to configure an AI provider. You can also pre-configure in `serac.jsonc`:

```jsonc
{
  "$schema": "https://serac.build/config.json",
  "provider": {
    "anthropic": {},
    "openai": {},
  },
}
```

<br>

## Supported AI Providers

Serac is not coupled to any single AI provider. Use whichever model works best for you.

<table>
<tr>
<td><b>Anthropic</b></td>
<td><b>OpenAI</b></td>
<td><b>Google</b></td>
<td><b>AWS Bedrock</b></td>
</tr>
<tr>
<td><sub>Claude 4.5/4.6 Opus, Sonnet, Haiku</sub></td>
<td><sub>GPT-5, GPT-4, o-series reasoning</sub></td>
<td><sub>Gemini 2.5 Pro, Flash + Vertex AI</sub></td>
<td><sub>All models, cross-region support</sub></td>
</tr>
<tr><td colspan="4">&nbsp;</td></tr>
<tr>
<td><b>Azure</b></td>
<td><b>GitHub Copilot</b></td>
<td><b>Mistral</b></td>
<td><b>Groq</b></td>
</tr>
<tr>
<td><sub>OpenAI + Cognitive Services</sub></td>
<td><sub>GPT-5 via Copilot enterprise</sub></td>
<td><sub>Large, Medium, Small</sub></td>
<td><sub>Ultra-fast inference</sub></td>
</tr>
<tr><td colspan="4">&nbsp;</td></tr>
<tr>
<td><b>xAI</b></td>
<td><b>OpenRouter</b></td>
<td><b>GitLab AI</b></td>
<td><b>+ 10 more</b></td>
</tr>
<tr>
<td><sub>Grok models</sub></td>
<td><sub>100+ models, single API</sub></td>
<td><sub>Native GitLab integration</sub></td>
<td><sub>Cohere, Perplexity, DeepInfra, Cerebras, Together AI, Vercel, ...</sub></td>
</tr>
</table>

<br>

## Agents

Switch between agents with `Tab`:

| Agent       | Description                                                                   |
| :---------- | :---------------------------------------------------------------------------- |
| **build**   | Default agent with full tool access for development work                      |
| **plan**    | Read-only agent for analysis and exploration — denies edits, asks before bash |
| **general** | Subagent for complex multi-step tasks — invoke with `@general`                |

Custom agents can be configured in `serac.jsonc` with per-agent model selection, permissions, and temperature controls. Learn more about [agents](https://serac.build/docs/agents).

<br>

## Built-in Tools

19+ tools out of the box:

```
 File Operations    Shell              Web                 Dev
 ───────────────    ─────              ───                 ───
 read               bash (streaming,   webfetch            plan (enter/exit)
 write              pty support)       websearch           task management
 edit                                  codesearch          LSP (experimental)
 glob                                                      skill invocation
 grep
 ls
 apply_patch
```

<br>

## ServiceNow MCP Integration

The core of Serac — **429 MCP tools** purpose-built for ServiceNow.

<table>
<tr>
<td width="33%" valign="top">

**Operations**

- Query any table
- CMDB search
- User management
- Operational metrics

</td>
<td width="33%" valign="top">

**Development**

- Script Includes
- Business Rules
- Client Scripts
- UI Policies & Actions

</td>
<td width="33%" valign="top">

**Automation**

- Flow Designer
- Scheduled Jobs
- Approval Workflows
- Event Management

</td>
</tr>
<tr>
<td width="33%" valign="top">

**Deployment**

- Widget deploy & preview
- Update Set lifecycle
- Artifact validation
- Rollback support

</td>
<td width="33%" valign="top">

**Security**

- ACL management
- Domain Separation
- Compliance auditing
- Vulnerability scanning

</td>
<td width="33%" valign="top">

**Analysis**

- Reporting & Dashboards
- KPI management
- Performance Analytics
- Data quality checks

</td>
</tr>
</table>

Connect to your instance:

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

<br>

## 54 Bundled Skills

Deep domain knowledge for ServiceNow development, organized by category:

| Category        | Skills                                                                            |
| :-------------- | :-------------------------------------------------------------------------------- |
| **Development** | GlideRecord patterns, Script Includes, Business Rules, Client Scripts, UI Builder |
| **Integration** | REST integration, Integration Hub, Transform Maps, Import/Export                  |
| **Automation**  | Flow Designer, Approval Workflows, Scheduled Jobs, Change Management              |
| **Security**    | ACL patterns, Domain Separation, Instance Security, GRC Compliance                |
| **ITSM**        | Incident, Problem, Change, Request, SLA Management                                |
| **Platform**    | CMDB, Discovery, Performance Analytics, Virtual Agent, Agent Workspace            |
| **Quality**     | ATF Testing, Code Review, Widget Coherence, ES5 Compliance                        |
| **Analysis**    | Blast Radius (configuration dependency & impact analysis)                         |

<br>

## Extend with MCP & Plugins

<table>
<tr>
<td width="50%" valign="top">

**MCP Servers**

Connect any MCP-compatible server via stdio, SSE, or streamable HTTP with OAuth support:

```jsonc
{
  "mcp": {
    "context7": {
      "type": "remote",
      "url": "https://mcp.context7.com/mcp",
    },
    "custom-tools": {
      "type": "local",
      "command": ["node", "./server.js"],
    },
  },
}
```

</td>
<td width="50%" valign="top">

**Plugins**

Extend with npm packages or local plugins that add tools, auth providers, event hooks, and config hooks:

```jsonc
{
  "plugin": ["my-serac-plugin", "file://./local-plugin"],
}
```

</td>
</tr>
</table>

<br>

## Headless / Server Mode

Run Serac as a headless API server for CI/CD pipelines, remote control, or web UI access:

```bash
serac serve              # Start API server on port 4096
serac serve --port 8080  # Custom port
serac web                # Start server + open web interface
serac attach http://host:4096  # Attach TUI to remote server
```

<br>

## Permission System

Fine-grained control over what agents can do, with glob pattern matching and env file protection by default:

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

<details>
<summary><b>Installation directory priority</b></summary>
<br>

The install script respects the following priority order:

1. `$SERAC_INSTALL_DIR` — Custom installation directory
2. `$XDG_BIN_DIR` — XDG Base Directory Specification compliant path
3. `$HOME/bin` — Standard user binary directory
4. `$HOME/.serac/bin` — Default fallback

</details>

<br>

## Documentation

For full configuration reference, provider setup guides, and advanced usage:

**[serac.build/docs](https://serac.build/docs)**

<br>

## Contributing

We welcome bug fixes, new provider support, LSP/formatter additions, and documentation improvements. Read our [contributing guide](./CONTRIBUTING.md) before submitting a pull request.

<br>

## FAQ

<details>
<summary><b>What is Serac?</b></summary>
<br>

Serac is an autonomous ServiceNow development agent. It connects AI models to your ServiceNow instance through MCP tools, giving you an intelligent assistant that can develop widgets, query tables, deploy artifacts, manage update sets, and automate tasks — all from your terminal.

</details>

<details>
<summary><b>How is this different from other coding agents?</b></summary>
<br>

Serac is purpose-built for ServiceNow:

- **Open source** — Apache License 2.0, fully transparent (built on the MIT-licensed [opencode](https://github.com/anomalyco/opencode))
- **ServiceNow-native** — 429 MCP tools and 55 domain skills (including Blast Radius impact analysis) designed for ServiceNow
- **Provider-agnostic** — Works with 20+ AI providers, not locked to one vendor
- **Built-in LSP** — Language server support for intelligent code assistance
- **Terminal-first** — A TUI built by terminal enthusiasts with SolidJS + opentui
- **Client/server architecture** — Remote control, headless mode, and web UI
- **Plugin ecosystem** — Extend with npm packages or local plugins

</details>

<details>
<summary><b>Can I use my own AI provider / API key?</b></summary>
<br>

Yes. Serac supports 20+ providers out of the box. Configure your preferred provider in `serac.jsonc` or through the interactive setup on first launch. You can even switch providers mid-session.

</details>

<details>
<summary><b>Does this work with my existing ServiceNow instance?</b></summary>
<br>

Yes. Serac connects to any ServiceNow instance via OAuth2 or basic authentication. Configure your instance URL and credentials in the MCP server configuration, and Serac will have access to all 429 ServiceNow tools.

</details>

<br>

---

## Disclaimer

Serac is an independent, open-source project and is **not affiliated with, endorsed by, or sponsored by ServiceNow, Inc.** ServiceNow is a registered trademark of ServiceNow, Inc.

This tool requires a valid ServiceNow subscription and uses your own credentials to interact with your ServiceNow instance. Some features (including Flow Designer automation) use undocumented ServiceNow APIs that may change without notice.

Licensed under the [Apache License 2.0](LICENSE) — see also [`NOTICE`](NOTICE) for third-party attributions (built on the MIT-licensed [opencode](https://github.com/anomalyco/opencode)).

---

<p align="center">
  <b>Join our community</b><br><br>
  <a href="https://serac.build"><img alt="Website" src="https://img.shields.io/badge/Website-snow--flow.dev-0ea5e9?style=for-the-badge&logo=safari&logoColor=white" /></a>
</p>

<p align="center">
  If you are building a project that uses "serac" in its name, please note in your README that it is not built by or affiliated with the Serac team.
</p>
