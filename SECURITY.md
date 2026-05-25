# Security

## Threat Model

### Overview

Serac is an AI-powered coding assistant that runs locally on your machine. It provides an agent system with access to powerful tools including shell execution, file operations, and web access.

### No Sandbox

Serac does **not** sandbox the agent. The permission system exists as a UX feature to help users stay aware of what actions the agent is taking - it prompts for confirmation before executing commands, writing files, etc. However, it is not designed to provide security isolation.

If you need true isolation, run Serac inside a Docker container or VM.

### Server Mode

Server mode is opt-in only. When enabled, set `SNOW_CODE_SERVER_PASSWORD` to require HTTP Basic Auth. Without this, the server runs unauthenticated (with a warning). It is the end user's responsibility to secure the server - any functionality it provides is not a vulnerability.

### Out of Scope

| Category                        | Rationale                                                               |
| ------------------------------- | ----------------------------------------------------------------------- |
| **Server access when opted-in** | If you enable server mode, API access is expected behavior              |
| **Sandbox escapes**             | The permission system is not a sandbox (see above)                      |
| **LLM provider data handling**  | Data sent to your configured LLM provider is governed by their policies |
| **MCP server behavior**         | External MCP servers you configure are outside our trust boundary       |
| **Malicious config files**      | Users control their own config; modifying it is not an attack vector    |

---

## Coordinated Vulnerability Disclosure

We appreciate your efforts to responsibly disclose your findings, and will make every effort to acknowledge your contributions.

### Reporting a Vulnerability

To report a security issue, please use the GitHub Security Advisory ["Report a Vulnerability"](https://github.com/groeimetai/snow-flow/security/advisories/new) tab.

Alternatively, email: **security@snow-flow.dev**

Please include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact assessment
- Any proof-of-concept code (non-destructive)

### Scope

The following components are in scope:

| Component             | Repository           |
| --------------------- | -------------------- |
| Serac CLI         | `packages/opencode/` |
| Serac Web UI      | `packages/app/`      |
| Serac Desktop App | `packages/desktop/`  |
| Serac Plugin SDK  | `packages/plugin/`   |
| Serac SDK         | `packages/sdk/`      |

### Response SLAs

| Severity | CVSS Score | Acknowledgment  | Fix Timeline |
| -------- | ---------- | --------------- | ------------ |
| Critical | 9.0 - 10.0 | 24 hours        | 48 hours     |
| High     | 7.0 - 8.9  | 48 hours        | 7 days       |
| Medium   | 4.0 - 6.9  | 5 business days | 30 days      |
| Low      | 0.1 - 3.9  | 5 business days | 90 days      |

### Safe Harbor

We consider security research conducted in accordance with this policy to be:

- Authorized and we will not pursue legal action against you
- Conducted in good faith to improve our security

To qualify:

- Do not access, modify, or delete data belonging to other users
- Do not publicly disclose the vulnerability before we have addressed it
- Stop testing and report immediately upon discovering sensitive data

### Acknowledgments

We maintain a security acknowledgments section for researchers who responsibly disclose vulnerabilities. Let us know if you would like to be credited.

### Escalation

If you do not receive an acknowledgment within 6 business days, you may send a follow-up email to security@snow-flow.dev.
