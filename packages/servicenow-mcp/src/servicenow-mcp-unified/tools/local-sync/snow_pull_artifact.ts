/**
 * snow_pull_artifact - Pull artifact body fields as files
 *
 * Pull a ServiceNow artifact (widget, script include, UX page, flow) and
 * return its body fields as a {filename: content} map. Stdio callers can
 * also write the map to a local directory for editing with native CLI
 * tools; HTTP callers (portal chat) get the map inline and use the
 * sandbox `write` tool to drop files where they want.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"
import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_pull_artifact",
  // Always returns a {filename: content} map. On stdio it ALSO writes the
  // files to `output_dir` for native-tool editing; on HTTP `output_dir`
  // is rejected (would touch the shared filesystem) and the agent uses
  // the inline map plus the sandbox `write` tool instead.
  httpForbiddenArgs: ["output_dir"],
  description:
    "Pull a ServiceNow artifact and return its body fields as files. " +
    "On stdio also writes them to disk under output_dir; on HTTP returns " +
    "them inline so the caller can drop them into the portal sandbox via the native `write` tool.",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "local-sync",
  use_cases: ["local-development", "artifact-sync", "editing"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: WRITE — produces local files when run on stdio.
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      sys_id: {
        type: "string",
        description: "sys_id of artifact to pull",
      },
      table: {
        type: "string",
        description: "Table name (optional, will auto-detect if not provided)",
        enum: ["sp_widget", "sys_ux_page", "sys_hub_flow", "sys_script_include"],
      },
      output_dir: {
        type: "string",
        description:
          "[stdio only] Local directory to also write the files into. " +
          "Default: /tmp/serac-artifacts. Ignored on HTTP transport — " +
          "use the returned `files` map and the `write` tool to land them in the sandbox.",
      },
    },
    required: ["sys_id"],
  },
}

interface ArtifactFiles {
  [filename: string]: string
}

function buildFilesForArtifact(table: string, name: string, artifact: any): ArtifactFiles {
  const files: ArtifactFiles = {}

  if (table === "sp_widget") {
    if (artifact.template) files[`${name}.html`] = String(artifact.template)
    if (artifact.script) files[`${name}.server.js`] = String(artifact.script)
    if (artifact.client_script) files[`${name}.client.js`] = String(artifact.client_script)
    if (artifact.css) files[`${name}.css`] = String(artifact.css)
    if (artifact.option_schema) files[`${name}.options.json`] = String(artifact.option_schema)
  } else if (table === "sys_script_include") {
    files[`${name}.js`] = String(artifact.script || "")
  } else if (table === "sys_ux_page") {
    if (artifact.html) files[`${name}.html`] = String(artifact.html)
    if (artifact.client_script) files[`${name}.client.js`] = String(artifact.client_script)
  } else if (table === "sys_hub_flow") {
    // Flow definitions live in JSON; emit a single descriptor file.
    files[`${name}.flow.json`] = JSON.stringify(artifact, null, 2)
  }

  return files
}

function buildReadme(name: string, table: string, sysId: string, artifact: any, fileNames: string[]): string {
  return `# ${name}

**Type:** ${table}
**sys_id:** ${sysId}
**Description:** ${artifact.description || "No description"}

## Files

${fileNames.map((f) => `- ${f}`).join("\n")}

## Instructions

1. Edit the body files with the native editor / write tool.
2. Re-deploy with \`snow_artifact_manage action="update"\` (inline content).
`
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { sys_id, table } = args
  const isHttp = context.origin === "http"

  try {
    const client = await getAuthenticatedClient(context)

    let artifactTable: string = table
    if (!artifactTable) {
      artifactTable = await detectArtifactTable(client, sys_id)
    }

    const response = await client.get(`/api/now/table/${artifactTable}/${sys_id}`)
    if (!response.data || !response.data.result) {
      return createErrorResult(`Artifact not found: ${sys_id}`)
    }

    const artifact = response.data.result
    const artifactName: string = artifact.name || artifact.id || sys_id

    const files = buildFilesForArtifact(artifactTable, artifactName, artifact)
    const fileNames = Object.keys(files)
    const readme = buildReadme(artifactName, artifactTable, sys_id, artifact, fileNames)
    files["README.md"] = readme

    // Stdio convenience: also write the files to disk so existing CLI
    // workflows (open the dir in $EDITOR, run grep across body files,
    // …) keep working unchanged. HTTP callers always get the inline
    // map and skip the disk write.
    let writtenDir: string | undefined
    if (!isHttp) {
      const outputDir: string = args.output_dir || path.join(os.tmpdir(), "serac-artifacts")
      const artifactDir = path.join(outputDir, artifactTable, artifactName)
      await fs.mkdir(artifactDir, { recursive: true })
      for (const [filename, content] of Object.entries(files)) {
        await fs.writeFile(path.join(artifactDir, filename), content, "utf-8")
      }
      writtenDir = artifactDir
    }

    return createSuccessResult({
      sys_id,
      table: artifactTable,
      name: artifactName,
      files,
      ...(writtenDir ? { directory: writtenDir, fileNames: fileNames.concat("README.md") } : {}),
      transport: isHttp ? "http" : "stdio",
      hint: isHttp
        ? "Use the returned `files` map with the native `write` tool to drop them in the sandbox (e.g. write('artifacts/" +
          artifactName +
          "/" +
          (fileNames[0] ?? "README.md") +
          "', files['" +
          (fileNames[0] ?? "README.md") +
          "']))."
        : "Files written to " + writtenDir + ".",
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

async function detectArtifactTable(client: any, sys_id: string): Promise<string> {
  const tables = ["sp_widget", "sys_ux_page", "sys_hub_flow", "sys_script_include"]

  for (const table of tables) {
    try {
      const response = await client.get(`/api/now/table/${table}/${sys_id}`, {
        params: { sysparm_fields: "sys_id" },
      })
      if (response.data && response.data.result) {
        return table
      }
    } catch (e) {
      continue
    }
  }

  throw new Error(`Could not detect table for sys_id: ${sys_id}`)
}

export const version = "1.1.0"
export const author = "Serac SDK Migration"
