# @serac-labs/skills

The bundled ServiceNow skill guides: 57 directories of plain markdown that teach an agent to
work on a ServiceNow instance like a practitioner — which update set to be in, why a Business
Rule fires twice, what ES5-only really rules out. Part of [Serac](https://serac.build).

```bash
npm install @serac-labs/skills
```

That command does not work yet — nothing has been published under this name. The first release is
waiting on an npm trusted publisher that only a maintainer can create, so for now the guides come
from [the repo](https://github.com/serac-labs/serac/tree/main/packages/skills).

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
`SKILL.md`", which is why `dist/` is not skill-shaped. The Serac Portal reads that tree straight
out of a checkout and keys on the same rule, so renaming a skill directory is a breaking change:
change the portal first, rename second.

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

`bun test` also asserts that every tool named in frontmatter actually exists in
`@serac-labs/servicenow-mcp`, so a skill cannot promise the agent a tool the
server does not have.

## Writing a new skill

The MCP server covers more ServiceNow than these 57 guides do. The domains where
it has tools and no skill explains them are filed as issues labelled
[good first issue][gfi]; each one names the tools involved and the closest
existing skill. Pick one and say so in a comment before you start. For a domain
that is not on that list, open an issue first — the label means a maintainer
already agreed the guide is wanted, which is the whole point of it.

A skill is one directory holding one `SKILL.md`, and it opens with frontmatter
whose `name` is the directory name:

```yaml
---
name: on-call-rotations
description: One line. This is what an agent reads when deciding to load it.
tools:
  - snow_oncall_manage
---
```

Write for an agent that knows ServiceNow exists but has never worked in this
corner of it: the order operations have to happen in, the values the platform
actually accepts, and the mistake that costs an afternoon. Not a paraphrase of
each tool's input schema — the agent already has that. `es5-compliance` is a
short one to copy, `update-set-workflow` a slightly longer one.

Done looks like this:

- `bun run --cwd packages/skills generate` has been run and the resulting
  `src/embedded.ts` is part of the commit.
- `cd packages/skills && bun test` passes. A mistyped tool name and a stale
  `embedded.ts` both fail there rather than in front of a user.
- You ran the tools you wrote about against an instance, and the PR says what
  you saw. A free developer instance is enough — see [CONTRIBUTING][contrib].
- The PR links its issue with `Fixes #123`.

## Links

- [`@serac-labs/servicenow-mcp`](https://www.npmjs.com/package/@serac-labs/servicenow-mcp) — the 400+ `snow_*` tools these guides drive
- [Serac](https://serac.build) — the product they were written for
- [Issues](https://github.com/serac-labs/serac/issues)
- [Source](https://github.com/serac-labs/serac/tree/main/packages/skills)

Apache-2.0

[gfi]: https://github.com/serac-labs/serac/labels/good%20first%20issue
[contrib]: ../../CONTRIBUTING.md
