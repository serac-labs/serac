# Security

## Reporting a vulnerability

Do not open a public issue. Use the GitHub Security Advisory
["Report a Vulnerability"](https://github.com/serac-labs/serac/security/advisories/new) form on this
repository.

You will get a response indicating the next steps. After the initial reply we will keep you informed of
progress towards a fix, and may ask for more detail.

We do not accept bulk AI-generated security reports. A report that shows no evidence anyone ran the code
will be closed.

## Threat model

This repository ships an MCP server that holds ServiceNow credentials and performs authenticated operations
on ServiceNow instances on behalf of a model. Treat it as software with production database access, because
that is what it is.

### The credentials are the crown jewels

`servicenow-mcp-stdio` reads `SNOW_INSTANCE`, `SNOW_CLIENT_ID` and `SNOW_CLIENT_SECRET` (or basic-auth
equivalents) from its environment, and caches the resulting OAuth token in process. Anything that can read
that process's environment, or drive its stdin, can act on your instance with those credentials. Give the
OAuth user the least privilege that lets it do the job.

### The server enforces nothing that ServiceNow does not

There is no permission layer here that a user cannot get past — authorization is ServiceNow's ACL evaluation
on the credentials you supplied. `sn-roles.manifest.json` records the minimum role each tool needs, which is
documentation for planning least-privilege access, not an enforcement mechanism. If the account can write to
`sys_script`, so can any tool call made with it.

Some tools execute server-side JavaScript on the instance (`shared/scripted-exec.ts`). That is a deliberate
capability, not an oversight, and it is as powerful as a background script in the UI. Point it at a
sub-production instance until you trust what is driving it.

### The HTTP transport does not authenticate its callers

`createHttpApp()` takes a `resolveContext` function supplied by the host. Validating the caller's
`Authorization` header, mapping it to a tenant, and decrypting that tenant's ServiceNow credentials are the
host's job. Standing the transport up with a resolver that trusts its input publishes an unauthenticated
proxy onto every instance it can reach.

Tenant isolation, on the other hand, is this codebase's responsibility. One HTTP process serves many
customers, so every cache and session store is keyed by `tenantId`, and a request that cannot be placed in a
tenant is refused rather than pooled into a shared bucket (`shared/tenant-scope.ts`). **A defect that lets
one tenant observe another's data or credentials is a vulnerability in this repository — report it.**

### What the model decides to do is not a sandbox escape

The MCP protocol lets a model call tools. Which tools it calls is decided by the client and the human
driving it. There is no sandbox here and none is claimed: tool descriptions, deferred tool loading and the
update-set guard are guardrails that keep a well-behaved agent honest, not a boundary against a hostile one.
If you need isolation, isolate the credentials.

### Out of scope

| Category                                 | Why                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------- |
| An agent calling a destructive tool      | The tools do what they say; the client decides which to call        |
| ServiceNow's own ACL or scope behaviour  | Report those to ServiceNow                                          |
| An unauthenticated HTTP deployment       | The host supplies `resolveContext`; see above                       |
| Credentials with more rights than needed | Provisioning is the operator's choice                               |
| Skill guide content                      | Skills are documentation. Bad advice is a bug — open a normal issue |

## In scope, and taken seriously

- Cross-tenant leakage of data, credentials, tokens or cached state in the HTTP transport
- Credentials, tokens or instance URLs written to logs, error messages, or MCP tool output
- A tool that acts outside its stated scope — writes when it claims to read, touches records outside the
  arguments it was given
- Anything that lets a crafted ServiceNow response cause execution on the client side
