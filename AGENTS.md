# AGENTS.md

Conventions for this repository. It holds two packages: `packages/servicenow-mcp` (the MCP server) and
`packages/skills` (the skill guides). There is nothing else.

- The default branch is `main`.
- Run `bun typecheck` from the repo root; it runs `tsgo` across both packages via turbo.
- Run tests from a package directory (`cd packages/servicenow-mcp && bun test`), or `bun run test` from the
  root to run both through turbo. `bun test` at the root is blocked on purpose — see `bunfig.toml`.

## Commits and PR titles

Use conventional commit-style messages and PR titles: `type(scope): summary`.

Valid types are `feat`, `fix`, `docs`, `chore`, `refactor`, and `test`. Scopes are optional; use `mcp`,
`skills`, or `ci` when it helps.

Examples: `fix(mcp): keep tenant scope on cached discovery results`, `docs: update contributing guide`,
`chore(skills): add fluent brownfield migration guide`.

## Style guide

### General principles

- Keep things in one function unless composable or reusable.
- Do not extract single-use helpers preemptively. Inline the logic at the call site unless the helper is
  reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller.
- Avoid `try`/`catch` where possible. Prefer `.catch(...)`.
- Avoid the `any` type.
- Use Bun APIs when possible, like `Bun.file()`.
- Rely on type inference; avoid explicit type annotations or interfaces unless necessary for exports or
  clarity.
- Prefer functional array methods (`flatMap`, `filter`, `map`) over `for` loops; use type guards on `filter`
  to keep inference downstream.
- Add comments for non-obvious constraints and surprising behaviour, not for obvious assignments or control
  flow. A comment explaining why something is the way it is survives a rewrite; one restating the code does
  not.

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Imports

- Never alias imports. Do not use `import { foo as bar } from "..."`.
- Never use star imports. Do not use `import * as Foo from "..."`.
- Prefer dynamic imports for heavy modules only needed on selected code paths. Destructure the bindings near
  the top of the narrowest scope that needs them so they read like normal imports.

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control flow

Avoid `else`. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Complex logic

Make the main function read as the happy path and move supporting detail into small helpers below it.

```ts
// Good
export function loadThing(input: unknown) {
  const config = requireConfig(input)
  const metadata = readMetadata(input)
  return createThing({ config, metadata })
}

function requireConfig(input: unknown) {
  ...
}
```

Keep helpers close to the code they support, below the main export. Extract only when it names a real concept.

## Testing

- Avoid mocks as much as possible. Test the actual implementation; do not duplicate its logic into the test.
- A test that only asserts what the code already says is worse than no test — it locks in behaviour without
  checking it. Prefer tests that would have caught a failure that really happened.
- Tests live beside the code in `__tests__/` directories in the MCP package, and in `test/` in the skills
  package.

## MCP tools

- One tool per file, under `src/servicenow-mcp-unified/tools/<domain>/snow_<name>.ts`, exporting a
  `toolDefinition` and an `execute(args, context)`. The domain's `index.ts` re-exports those as the
  `snow_<name>_def` / `snow_<name>_exec` pair the package publishes.
- There is no central registry to edit: `script/generate-tools-json.ts` discovers tools by walking that
  directory and reading each file's `toolDefinition`. A file in the wrong shape is silently not a tool —
  which is why the generator refuses to write a manifest if any tool file fails to import, and reports what
  it skipped.
- After adding or changing a tool, run `bun run --cwd packages/servicenow-mcp generate:tools-json`.
  `tools.json` is fetched from `main` by the public docs site, so a stale manifest means the tool exists but
  nobody can see it.
- A new tool also has no entry in `sn-roles.manifest.json`, and that one cannot be regenerated in CI — it
  reads a live instance's ACLs. Add the tool's name to `AWAITING_PROBE` in
  `src/__tests__/sn-roles.test.ts`; the next `probe:sn-roles` run covers it and takes it back off.
- Every executor takes a `ServiceNowContext`. In the HTTP transport one process serves many customers, so
  anything cached must be keyed by `tenantId` — a request that cannot be placed in a tenant is refused, not
  pooled. See `src/servicenow-mcp-unified/shared/tenant-scope.ts`.

## Skills

- One directory per skill, holding a single `SKILL.md` with YAML frontmatter (`name`, `description`, and the
  `snow_*` tools it expects). The directory name and the frontmatter `name` must match.
- After any change run `bun run --cwd packages/skills generate` to refresh `src/embedded.ts`. `bun test`
  fails if it drifts, and fails if frontmatter names a tool the MCP server does not have.
- Skill directory names are a contract with consumers that read the tree from a checkout. Renaming one is a
  breaking change for them, not a refactor.
