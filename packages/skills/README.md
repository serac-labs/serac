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
