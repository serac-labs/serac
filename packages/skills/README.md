# @serac-labs/skills

The bundled ServiceNow skill guides: 57 directories of plain markdown that teach an agent to
work on a ServiceNow instance like a practitioner — which update set to be in, why a Business
Rule fires twice, what ES5-only really rules out. Part of [Serac](https://serac.build).

```bash
npm install @serac-labs/skills
```

They pair with [`@serac-labs/servicenow-mcp`](https://www.npmjs.com/package/@serac-labs/servicenow-mcp):
the MCP server gives a model the ability to change an instance, the skills give it the judgement
to do so without breaking one.

## What a skill is

One directory, one `SKILL.md`, YAML frontmatter and then prose:

```yaml
---
name: es5-compliance
description: Enforce ES5-only syntax for ServiceNow server-side scripts (Rhino engine) — …
tools:
  - snow_execute_script
  - snow_convert_es6_to_es5
---
```

The directory name and the frontmatter `name` always match, and `tools:` only ever names tools
the MCP server really has — `bun test` in this repo fails on either.

Nothing loads a skill automatically. A host decides which ones to put in front of the model,
usually by matching the task; putting all 57 in a prompt is not the intended use. They are worth
reading on their own, agent or no agent.

## Consuming them

**As files.** `skillsRoot()` returns the directory that holds the skill directories:

```ts
import { skillsRoot } from "@serac-labs/skills/root"
import { readFileSync } from "node:fs"
import { join } from "node:path"

readFileSync(join(skillsRoot(), "es5-compliance", "SKILL.md"), "utf8")
```

This is the path anything with a real filesystem should use, and the markdown ships in the npm
tarball for exactly that reason. Skills are keyed by "top-level directory containing a
`SKILL.md`" — which is why `dist/` is not skill-shaped, and why no skill directory can be renamed
without breaking every consumer that reads the tree.

**As an embedded string map.** `BUNDLED_SKILLS` maps a path relative to the skills root
(`incident-management/SKILL.md`) to that file's contents:

```ts
import { BUNDLED_SKILLS } from "@serac-labs/skills"
```

This exists for consumers with no source filesystem alongside them — a bundled single file, a
`bun build --compile` binary, a serverless deploy. It costs a few hundred KB of string literals
at import time, so import `@serac-labs/skills/root` instead if you only need the path.

## Requirements

Node 20+ or Bun 1.2+. ESM only — there is no CommonJS `require` entrypoint.

## Working on them

The skills are edited in [the repo](https://github.com/serac-labs/serac/tree/main/packages/skills),
not in `node_modules`. After adding, renaming or deleting one, regenerate the embedded map:

```bash
bun run --cwd packages/skills generate        # writes src/embedded.ts
bun run --cwd packages/skills generate:check  # drift gate, no write
```

`bun test` asserts the same thing. That gate is not decorative: before it existed the shipped
binary carried 55 of 58 skills and three Fluent skills never reached a single user, because the
generator lived in `/tmp` and nothing compared its output to reality.

## Links

- [`@serac-labs/servicenow-mcp`](https://www.npmjs.com/package/@serac-labs/servicenow-mcp) — the 437 `snow_*` tools these guides drive
- [Serac](https://serac.build) — the product they were written for
- [Issues](https://github.com/serac-labs/serac/issues)
- [Source](https://github.com/serac-labs/serac/tree/main/packages/skills)

Apache-2.0
