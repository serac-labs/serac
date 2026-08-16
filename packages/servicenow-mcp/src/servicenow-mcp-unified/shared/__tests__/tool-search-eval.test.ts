/**
 * Retrieval eval for `ToolSearch.search`.
 *
 * Every tool but the two meta tools is deferred, so `tool_search` is the only
 * path a model has to the other 435. A tool the ranking never surfaces might
 * as well not be installed — and the ranking is a hand-tuned pile of substring
 * bonuses that until now nothing measured.
 *
 * The scoring is pure and deterministic (no LLM, no network), so this is a
 * real gate rather than an approximation: it scores the shipped ranker against
 * a fixed set of realistically-phrased requests and fails when recall drops.
 *
 * The index is built from `tools.json` the way the transports build theirs —
 * same `extractKeywords`, same 200-char description truncation — so the score
 * is the score a session gets. Two deliberate deviations, neither of which can
 * move the numbers:
 *
 *   - `category` comes from the manifest group; the transports use the
 *     registry domain (the tool's directory). They differ for the ~20 tools
 *     that declare their own `subcategory`, but category only scores when the
 *     *entire* query is a substring of it, which no multi-word request is.
 *   - `search()` is called with the full catalog as its limit instead of the
 *     default 20, so MRR is not truncated at 1/20. The @k slices are identical
 *     either way.
 *
 * CURRENT SCORE (437 tools, 102 queries): recall@1 0.255, recall@5 0.480,
 * recall@20 0.667, MRR 0.370. Two thirds of realistic requests do reach the
 * right tool eventually, but a quarter of them put `snow_sp_theme_manage`
 * first — its keywords contain "theme"/"theming", and the word-level rules
 * match substrings for any query word longer than two characters, so every
 * request containing the word "the" scores it +31. See issue #295; fixing the
 * ranking is deliberately not part of this suite.
 */

import { describe, test, expect, afterAll } from "@jest/globals"
import * as path from "path"
import { ToolSearch, extractKeywords } from "../tool-search"
import { EVAL_QUERIES } from "./tool-search-eval.queries"

/**
 * Floors, not targets. They sit ~2 queries under the measured score so that
 * adding a tool that steals one rank does not fail an unrelated PR, while any
 * real degradation does.
 *
 * These may be raised when the ranking improves. Lowering one to make a change
 * pass is the failure mode this file exists to prevent: it means the change
 * made retrieval worse, and the number is the argument against it.
 */
const MIN_RECALL_AT_1 = 0.24
const MIN_RECALL_AT_5 = 0.46
const MIN_RECALL_AT_20 = 0.65
const MIN_MRR = 0.35

const manifest: { count: number; groups: { name: string; tools: { name: string; description: string }[] }[] } =
  await Bun.file(path.resolve(__dirname, "../../../..", "tools.json")).json()

const index = manifest.groups.flatMap((group) =>
  group.tools.map((tool) => ({
    id: tool.name,
    description: tool.description.substring(0, 200),
    category: group.name,
    keywords: extractKeywords(tool.name, tool.description),
    deferred: true,
  })),
)

afterAll(() => ToolSearch.clearIndex())

describe("tool_search retrieval", () => {
  test("the fixture points at tools that exist", () => {
    const catalog = new Set(index.map((entry) => entry.id))
    const unknown = EVAL_QUERIES.flatMap((entry) => entry.expected.filter((name) => !catalog.has(name)))

    // A renamed or deleted tool must fail loudly here rather than quietly
    // degrade the score below as if retrieval had regressed.
    expect(unknown).toEqual([])
    expect(index.length).toBe(manifest.count)
  })

  test("recall against realistic queries stays above the measured floor", () => {
    ToolSearch.clearIndex()
    ToolSearch.registerTools(index)

    const results = EVAL_QUERIES.map((entry) => {
      const ranked = ToolSearch.search(entry.query, index.length).map((tool) => tool.id)
      return {
        query: entry.query,
        expected: entry.expected,
        // 0-based position of the first acceptable tool, -1 when the ranking
        // never returns one at all.
        rank: ranked.findIndex((id) => entry.expected.includes(id)),
        top: ranked.slice(0, 3),
      }
    })

    const recallAt = (k: number) => results.filter((r) => r.rank >= 0 && r.rank < k).length / results.length
    const mrr = results.reduce((sum, r) => sum + (r.rank >= 0 ? 1 / (r.rank + 1) : 0), 0) / results.length

    // Printed before the assertions so a failing run still shows every number
    // and the queries behind it, not just the first metric that tripped.
    console.log(
      `\ntool_search retrieval — ${results.length} queries over ${index.length} tools\n` +
        `  recall@1  ${recallAt(1).toFixed(3)}  (floor ${MIN_RECALL_AT_1})\n` +
        `  recall@5  ${recallAt(5).toFixed(3)}  (floor ${MIN_RECALL_AT_5})\n` +
        `  recall@20 ${recallAt(20).toFixed(3)}  (floor ${MIN_RECALL_AT_20})\n` +
        `  MRR       ${mrr.toFixed(3)}  (floor ${MIN_MRR})`,
    )

    // Never-found (-1) sorts as worse than any real rank, so the head of this
    // list is the head of the problem.
    const sortable = (rank: number) => (rank < 0 ? Number.MAX_SAFE_INTEGER : rank)
    const worst = results.filter((r) => r.rank < 0 || r.rank >= 20).sort((a, b) => sortable(b.rank) - sortable(a.rank))
    console.log(
      `  ${worst.length} queries never reach their tool in the top 20; the first few:\n` +
        worst
          .slice(0, 10)
          .map((r) => `    "${r.query}" → want ${r.expected.join(" | ")}, got ${r.top.join(", ")}`)
          .join("\n"),
    )

    expect(recallAt(1)).toBeGreaterThanOrEqual(MIN_RECALL_AT_1)
    expect(recallAt(5)).toBeGreaterThanOrEqual(MIN_RECALL_AT_5)
    expect(recallAt(20)).toBeGreaterThanOrEqual(MIN_RECALL_AT_20)
    expect(mrr).toBeGreaterThanOrEqual(MIN_MRR)
  })
})
