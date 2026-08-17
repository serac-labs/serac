# @serac-labs/skills

The bundled ServiceNow skill guides. One directory per skill, each holding a
single `SKILL.md` with YAML frontmatter (`name`, `description`, and the
`snow_*` tools the skill expects to be available).

Skills and the ServiceNow MCP server are the two things this repository ships.
The layout here is a contract, not an implementation detail.

## Consuming them

**As files.** `skillsRoot()` returns the directory that holds the skill
directories:

```ts
import { skillsRoot } from "@serac-labs/skills/root"
```

This is the path anything with a real filesystem should use. The Serac Portal
reads the tree directly out of a checkout, keying on "top-level directory
containing a `SKILL.md`" — which is why `src/`, `script/` and `test/` are
deliberately not skill-shaped, and why no skill directory may be renamed
without changing the portal first.

**As an embedded string map.** `BUNDLED_SKILLS` maps a path relative to the
skills root (`incident-management/SKILL.md`) to that file's contents:

```ts
import { BUNDLED_SKILLS } from "@serac-labs/skills"
```

This exists for consumers with no source filesystem alongside them — a bundled
single file, a `bun build --compile` binary, a serverless deploy. It is
generated: do not edit `src/embedded.ts` by hand.

## After changing a skill

```
bun packages/skills/script/generate-embedded.ts
```

`--check` verifies the checked-in module matches the tree without writing, and
`bun test` asserts the same thing. That gate is not decorative: before it
existed, the shipped binary carried 55 of 58 skills and three Fluent skills
never reached a single user, because the generator lived in `/tmp` and nothing
compared its output to reality.

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

[gfi]: https://github.com/serac-labs/serac/labels/good%20first%20issue
[contrib]: ../../CONTRIBUTING.md
