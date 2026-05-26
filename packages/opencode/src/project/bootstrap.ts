import { Plugin } from "../plugin"
import { Share } from "../share/share"
import { Format } from "../format"
import { LSP } from "../lsp"
import { FileWatcher } from "../file/watcher"
import { File } from "../file"
import { Project } from "./project"
import { Bus } from "../bus"
import { Command } from "../command"
import { Instance } from "./instance"
import { Vcs } from "./vcs"
import { Log } from "@/util/log"
import { ShareNext } from "@/share/share-next"
import { Snapshot } from "../snapshot"
import { Truncate } from "../tool/truncation"
import path from "path"
import { AGENTS_TEMPLATE } from "./agents-template"
import INSTANCE_TEMPLATE from "./instance-template.txt"
import SKILLS_INDEX from "./skills-index.txt"
import REVIEWER_TEMPLATE from "./reviewer-template.txt"

/**
 * Ensures AGENTS.md exists in the project directory.
 * Creates it from template if it doesn't exist.
 */
async function ensureAgentsMd() {
  const agentsMdPath = path.join(Instance.directory, "AGENTS.md")

  try {
    const exists = await Bun.file(agentsMdPath).exists()
    if (!exists) {
      await Bun.write(agentsMdPath, AGENTS_TEMPLATE)
      Log.Default.info("created AGENTS.md", { path: agentsMdPath })
    }
  } catch (error) {
    Log.Default.warn("failed to create AGENTS.md", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Ensures INSTANCE.md exists in the project directory.
 * Creates it from template if it doesn't exist.
 * INSTANCE.md stores instance-specific knowledge that persists across sessions.
 */
async function ensureInstanceMd() {
  const instanceMdPath = path.join(Instance.directory, "INSTANCE.md")

  try {
    const exists = await Bun.file(instanceMdPath).exists()
    if (!exists) {
      await Bun.write(instanceMdPath, INSTANCE_TEMPLATE)
      Log.Default.info("created INSTANCE.md", { path: instanceMdPath })
    }
  } catch (error) {
    Log.Default.warn("failed to create INSTANCE.md", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Ensures SKILLS.md exists in the project directory.
 * Creates it from template if it doesn't exist.
 * SKILLS.md is the index of bundled skills, loaded by the agent on demand
 * via Skill({ skill: "name" }). It is intentionally separate from AGENTS.md
 * so the behavioral rules stay slim and the skill catalog can grow without
 * bloating every session's context window.
 */
async function ensureSkillsMd() {
  const skillsMdPath = path.join(Instance.directory, "SKILLS.md")

  try {
    const exists = await Bun.file(skillsMdPath).exists()
    if (!exists) {
      await Bun.write(skillsMdPath, SKILLS_INDEX)
      Log.Default.info("created SKILLS.md", { path: skillsMdPath })
    }
  } catch (error) {
    Log.Default.warn("failed to create SKILLS.md", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Ensures REVIEWER.md exists in the project directory.
 * Creates it from template if it doesn't exist.
 * REVIEWER.md is the code review protocol the agent runs on itself before
 * emitting any ServiceNow code artifact. It is intentionally lazy-loaded
 * (not auto-injected into every session) — AGENTS.md references it so the
 * agent loads it when the work moves from planning to emitting code.
 */
async function ensureReviewerMd() {
  const reviewerMdPath = path.join(Instance.directory, "REVIEWER.md")

  try {
    const exists = await Bun.file(reviewerMdPath).exists()
    if (!exists) {
      await Bun.write(reviewerMdPath, REVIEWER_TEMPLATE)
      Log.Default.info("created REVIEWER.md", { path: reviewerMdPath })
    }
  } catch (error) {
    Log.Default.warn("failed to create REVIEWER.md", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export async function InstanceBootstrap() {
  Log.Default.info("bootstrapping", { directory: Instance.directory })
  await Plugin.init()
  Share.init()
  ShareNext.init()
  Format.init()
  await LSP.init()
  FileWatcher.init()
  File.init()
  Vcs.init()
  Snapshot.init()
  Truncate.init()

  // Create AGENTS.md, INSTANCE.md, SKILLS.md, and REVIEWER.md if they don't exist
  await ensureAgentsMd()
  await ensureInstanceMd()
  await ensureSkillsMd()
  await ensureReviewerMd()

  bootstrapUnsub?.()
  bootstrapUnsub = Bus.subscribe(Command.Event.Executed, async (payload) => {
    if (payload.properties.name === Command.Default.INIT) {
      await Project.setInitialized(Instance.project.id)
    }
  })
}
let bootstrapUnsub: (() => void) | undefined
