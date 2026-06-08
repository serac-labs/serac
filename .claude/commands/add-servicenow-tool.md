Scaffold a new ServiceNow MCP tool in the unified server, following the existing pattern. You're filling in the skeleton — the agent still has to implement the actual ServiceNow logic.

## Input

`$ARGUMENTS`: the tool name, starting with `snow_` (e.g. `snow_bulk_update_records`). If missing, ask the user.

## Steps

1. **Read the playbook first.** `.claude/playbook.md` section "Type 1: new ServiceNow MCP tool" has the file structure, the minimum template, style rules, and registration steps. Don't skip this.

2. **Validate the tool name.**
   - Must start with `snow_`
   - Must be snake_case
   - Must not already exist. Check with: `find packages/servicenow-mcp/src/servicenow-mcp-unified/tools -name "$TOOL_NAME.ts"` or Glob equivalent. If it exists, stop and tell the user.

3. **Ask the user for the domain** if they didn't specify one in the issue or the tool name. Present the existing domains from `packages/servicenow-mcp/src/servicenow-mcp-unified/tools/` (directory listing) and ask which one fits. If none fit, ask whether a new domain should be created — but warn the user that new domains should typically be discussed in an issue first.

4. **Read the most similar existing tool in the target domain.** Not to copy, but to match the structure and any domain-specific conventions (some domains have shared helpers or patterns that aren't in the generic playbook).

5. **Ask the user for the minimum metadata** you need for a useful skeleton:
   - One-sentence description (what it does)
   - `permission`: read or write
   - `complexity`: basic, intermediate, advanced
   - `frequency`: low, medium, high
   - `use_cases`: 1–3 short tags
   - Input schema fields (at least: what are the required args?)

   Keep this short. Don't generate these values yourself — ask.

6. **Scaffold the file** at `packages/servicenow-mcp/src/servicenow-mcp-unified/tools/<domain>/<tool_name>.ts` using the minimum template from `.claude/playbook.md`. Fill in the values the user gave you in step 5. Put a clear `// TODO: implement` comment in the body of `execute` and don't try to write the ServiceNow logic — that's the user's job.

7. **Register it** by adding `export * from "./<tool_name>.js"` to `tools/<domain>/index.ts` (alphabetical order if the file uses alphabetical order). Read the file first to check the sort order.

8. **Run `/verify`** or at minimum `cd packages/opencode && bun typecheck` to confirm your scaffolded file compiles.

9. **Report to user.** Show:
   - The file you created (path, not full content)
   - The `index.ts` line you added
   - The `// TODO:` items the user needs to fill in
   - The next step (implement the logic, then `/verify`, then `/open-pr`)

## Safety gates

- **Never skip step 5 (ask the user for metadata).** If you invent tool descriptions or use_cases, you'll produce a tool that misleads the agent at runtime. Ask.
- **Don't implement the ServiceNow logic in the scaffold.** Leave `// TODO:` comments. The user knows what the tool should do; you're just wiring it up.
- **Don't add a test file unless the user asks for one.** The unified server has limited test coverage for tool files; adding one for a scaffolded tool without a clear test pattern would be noise.
- **Don't run `/open-pr` automatically.** The user needs to implement the logic first.
- **Style guide from `AGENTS.md`** applies to your scaffold: `const` not `let`, avoid `else` (early return), avoid `any`, single-word identifiers where possible, type inference over explicit annotations.

## Cross-references

- `.claude/playbook.md` — Type 1 section, has the file template
- `packages/servicenow-mcp/src/servicenow-mcp-unified/README.md` — unified server architecture
- `packages/servicenow-mcp/src/servicenow-mcp-unified/tools/automation/snow_execute_script.ts` — full working example

## Output format

```
Scaffolded snow_your_tool in <domain>/

Files:
  + packages/servicenow-mcp/src/servicenow-mcp-unified/tools/<domain>/snow_your_tool.ts
  M packages/servicenow-mcp/src/servicenow-mcp-unified/tools/<domain>/index.ts

TODOs for you to fill in:
  - execute() body — implement the ServiceNow logic
  - input schema properties — add any params beyond the required ones

Next: implement, then /verify, then /open-pr (with a linked issue).
```
