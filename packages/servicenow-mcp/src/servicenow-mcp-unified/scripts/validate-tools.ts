#!/usr/bin/env ts-node
/**
 * Tool Registry Validation Script
 *
 * Validates that all 400+ tools can be discovered and registered correctly.
 */

import { toolRegistry } from "../shared/tool-registry.js"

async function main() {
  console.log("=".repeat(80))
  console.log("ServiceNow MCP Unified - Tool Registry Validation")
  console.log("=".repeat(80))
  console.log("")

  try {
    // Initialize the tool registry with auto-discovery
    console.log("🔍 Starting tool discovery...")
    const discoveryResult = await toolRegistry.initialize()

    console.log("")
    console.log("📊 Discovery Results:")
    console.log("─".repeat(80))
    console.log(`  Total Domains Found:     ${discoveryResult.domains.length}`)
    console.log(`  Tools Discovered:        ${discoveryResult.toolsFound}`)
    console.log(`  Tools Registered:        ${discoveryResult.toolsRegistered}`)
    console.log(`  Registration Failures:   ${discoveryResult.toolsFailed}`)
    console.log(`  Discovery Duration:      ${discoveryResult.duration}ms`)
    console.log("")

    // Get registry statistics
    const stats = toolRegistry.getStatistics()
    console.log("📈 Registry Statistics:")
    console.log("─".repeat(80))
    console.log(`  Total Tools:             ${stats.totalTools}`)
    console.log(`  Total Domains:           ${stats.totalDomains}`)
    console.log("")

    // Display tools by domain
    console.log("📦 Tools by Domain:")
    console.log("─".repeat(80))
    const sortedDomains = Object.entries(stats.toolsByDomain).sort(([, a], [, b]) => b - a)

    for (const [domain, count] of sortedDomains) {
      console.log(`  ${domain.padEnd(30)} ${count.toString().padStart(3)} tools`)
    }
    console.log("")

    // Check for errors
    if (discoveryResult.errors.length > 0) {
      console.log("❌ Registration Errors:")
      console.log("─".repeat(80))
      for (const error of discoveryResult.errors) {
        console.log(`  ${error.filePath}`)
        console.log(`     Error: ${error.error}`)
      }
      console.log("")
    }

    // Validation summary
    console.log("✅ Validation Summary:")
    console.log("─".repeat(80))

    const minToolCount = 400
    const actualToolCount = stats.totalTools
    const toolCountMatch = actualToolCount >= minToolCount

    console.log(`  Expected Tools (min):    ${minToolCount}`)
    console.log(`  Actual Tools:            ${actualToolCount}`)
    console.log(`  Count Match:             ${toolCountMatch ? "✅ YES" : "❌ NO"}`)
    console.log("")

    if (discoveryResult.toolsFailed > 0) {
      console.log("⚠️  Some tools failed to register. Please review errors above.")
      process.exit(1)
    }

    if (!toolCountMatch) {
      console.log(`⚠️  Tool count too low. Expected at least ${minToolCount} tools.`)
      process.exit(1)
    }

    console.log("🎉 All tools successfully validated!")
    console.log("")
    console.log("=".repeat(80))
  } catch (error: any) {
    console.error("")
    console.error("❌ Validation Failed:")
    console.error("─".repeat(80))
    console.error(`  ${error.message}`)
    console.error("")
    process.exit(1)
  }
}

main().catch((error) => {
  console.error("Fatal error:", error)
  process.exit(1)
})
