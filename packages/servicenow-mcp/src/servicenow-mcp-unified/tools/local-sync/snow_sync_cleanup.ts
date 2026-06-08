/**
 * snow_sync_cleanup - Clean up local sync files
 *
 * Removes local artifact files after successful sync, with optional retention policies.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"
import * as fs from "fs/promises"
import * as path from "path"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_sync_cleanup",
  // Stdio-only: deletes a hard-coded `/tmp/serac-artifacts` directory.
  // In HTTP multi-tenant context that would wipe artifacts of every tenant.
  transports: ["stdio"],
  description: "Clean up local artifact files after sync with retention policies",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "local-sync",
  use_cases: ["cleanup", "maintenance", "local-development"],
  complexity: "beginner",
  frequency: "low",

  // Permission enforcement
  // Classification: WRITE - Write operation based on name pattern
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      sys_id: { type: "string", description: "Artifact sys_id to clean up" },
      cleanup_all: { type: "boolean", description: "Clean up all synced artifacts", default: false },
      keep_backup: { type: "boolean", description: "Keep backup before deletion", default: true },
      max_age_days: { type: "number", description: "Clean files older than N days (0 = all)", default: 0 },
    },
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { sys_id, cleanup_all = false, keep_backup = true, max_age_days = 0 } = args

  try {
    const syncDir = path.join("/tmp", "serac-artifacts")

    // Verify sync directory exists
    try {
      await fs.access(syncDir)
    } catch {
      return createSuccessResult({ message: "No artifacts to clean up", cleaned: 0 })
    }

    let cleanedCount = 0
    let backupPaths: string[] = []

    if (cleanup_all) {
      // Clean all artifacts
      const cleaned = await cleanupAllArtifacts(syncDir, keep_backup, max_age_days)
      cleanedCount = cleaned.count
      backupPaths = cleaned.backups
    } else if (sys_id) {
      // Clean specific artifact
      const cleaned = await cleanupArtifact(syncDir, sys_id, keep_backup)
      cleanedCount = cleaned.count
      backupPaths = cleaned.backups
    } else {
      return createErrorResult("Either sys_id or cleanup_all must be specified")
    }

    return createSuccessResult(
      {
        cleaned: true,
        artifacts_cleaned: cleanedCount,
        backup_created: keep_backup,
        backup_paths: backupPaths,
      },
      { sys_id, cleanup_all },
    )
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

async function cleanupArtifact(syncDir: string, sysId: string, keepBackup: boolean): Promise<any> {
  let count = 0
  const backups: string[] = []

  // Find artifact directory
  const categories = await fs.readdir(syncDir)

  for (const category of categories) {
    const categoryPath = path.join(syncDir, category)
    const stat = await fs.stat(categoryPath)

    if (!stat.isDirectory()) continue

    const artifacts = await fs.readdir(categoryPath)

    for (const artifact of artifacts) {
      const artifactPath = path.join(categoryPath, artifact)
      const metaPath = path.join(artifactPath, ".metadata.json")

      try {
        const metadata = JSON.parse(await fs.readFile(metaPath, "utf-8"))

        if (metadata.sys_id === sysId) {
          if (keepBackup) {
            const backupPath = await createBackup(artifactPath, sysId)
            backups.push(backupPath)
          }

          await fs.rm(artifactPath, { recursive: true, force: true })
          count++
        }
      } catch {
        // Skip if metadata doesn't exist or is invalid
      }
    }
  }

  return { count, backups }
}

async function cleanupAllArtifacts(syncDir: string, keepBackup: boolean, maxAgeDays: number): Promise<any> {
  let count = 0
  const backups: string[] = []
  const cutoffTime = maxAgeDays > 0 ? Date.now() - maxAgeDays * 24 * 60 * 60 * 1000 : 0

  const categories = await fs.readdir(syncDir)

  for (const category of categories) {
    const categoryPath = path.join(syncDir, category)
    const stat = await fs.stat(categoryPath)

    if (!stat.isDirectory()) continue

    const artifacts = await fs.readdir(categoryPath)

    for (const artifact of artifacts) {
      const artifactPath = path.join(categoryPath, artifact)
      const artifactStat = await fs.stat(artifactPath)

      // Check age if maxAgeDays specified
      if (maxAgeDays > 0 && artifactStat.mtimeMs > cutoffTime) {
        continue
      }

      try {
        const metaPath = path.join(artifactPath, ".metadata.json")
        const metadata = JSON.parse(await fs.readFile(metaPath, "utf-8"))

        if (keepBackup) {
          const backupPath = await createBackup(artifactPath, metadata.sys_id)
          backups.push(backupPath)
        }

        await fs.rm(artifactPath, { recursive: true, force: true })
        count++
      } catch {
        // Skip if metadata doesn't exist or is invalid
      }
    }
  }

  return { count, backups }
}

async function createBackup(artifactPath: string, sysId: string): Promise<string> {
  const backupDir = path.join("/tmp", "snow-flow-backups")
  await fs.mkdir(backupDir, { recursive: true })

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const backupPath = path.join(backupDir, `${sysId}_${timestamp}`)

  // Copy directory recursively
  await copyDir(artifactPath, backupPath)

  return backupPath
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)

    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath)
    } else {
      await fs.copyFile(srcPath, destPath)
    }
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
