/**
 * Retrieval eval for `ToolSearch.search`.
 *
 * Every tool but the two meta tools is deferred, so `tool_search` is the only
 * path a model has to the other 445. A tool the ranking never surfaces might
 * as well not be installed — and the ranking is a hand-tuned pile of substring
 * bonuses that until now nothing measured.
 *
 * The scoring is pure and deterministic (no LLM, no network), so this is a
 * real gate rather than an approximation: it scores the shipped ranker against
 * a fixed set of realistically-phrased requests and fails when recall drops.
 *
 * The index comes from `toolRegistry` through `buildToolIndex` — the same call
 * both transports make at bootstrap — so this scores the catalog a session
 * actually searches, rather than the catalog `tools.json` advertises. Those
 * were different sets when this suite landed: nine published tools were
 * missing from `STATIC_TOOL_MODULES` or from a domain index, so the registry
 * held 429 against the manifest's 437 (#307, fixed; the two lists are now
 * pinned to each other by registry-manifest-parity.test.ts). Keep reading the
 * registry anyway — it is the set a session can reach, and scoring anything
 * else would count unreachable tools as findable.
 *
 * One deliberate deviation from a session: `search()` is called with the whole
 * catalog as its limit instead of the default 20, so MRR is not truncated at
 * 1/20. The @k slices are identical either way.
 *
 * CURRENT SCORE (445 tools, 101 queries): recall@1 0.267, recall@5 0.505,
 * recall@20 0.663, MRR 0.384. Two thirds of realistic requests do reach the
 * right tool eventually, but a quarter of them put `snow_sp_theme_manage`
 * first — its keywords contain "theme"/"theming", and the word-level rules
 * match substrings for any query word longer than two characters, so every
 * request containing the word "the" scores it +31. Issue #298 has the
 * diagnosis; fixing the ranking is deliberately not part of this suite.
 */

import { describe, test, expect, afterAll } from "@jest/globals"
import { ToolSearch, buildToolIndex } from "../tool-search"
import { toolRegistry } from "../tool-registry"
import { EVAL_QUERIES } from "./tool-search-eval.queries"

/**
 * Floors, not targets.
 *
 * `search()` sorts by score alone and the sort is stable, so tools on equal
 * scores come back in index order — which means part of the measurement is
 * array position, not ranking. Scoring the same catalog in 24 different
 * orders (production, reversed, by id, 20 shuffles) spans recall@1
 * 0.248-0.297, recall@5 0.465-0.515, recall@20 0.653-0.693, MRR 0.368-0.397.
 * These floors sit under the bottom of that band, so adding a tool that lands
 * in a tied cluster cannot fail an unrelated PR. The gap to the measured score
 * is tie noise, not slack.
 *
 * Raise them when the ranking improves. Lowering one to make a change pass is
 * the failure mode this file exists to prevent: it means the change made
 * retrieval worse, and the number is the argument against it.
 */
const MIN_RECALL_AT_1 = 0.24
const MIN_RECALL_AT_5 = 0.45
const MIN_RECALL_AT_20 = 0.63
const MIN_MRR = 0.35

await toolRegistry.initialize()

const index = buildToolIndex(
  toolRegistry.getToolDefinitions(),
  (name) => toolRegistry.getTool(name)?.domain || "unknown",
  true,
)

afterAll(() => ToolSearch.clearIndex())

describe("tool_search retrieval", () => {
  test("every query has an answer the server can actually return", () => {
    const catalog = new Set(index.map((entry) => entry.id))
    const unanswerable = EVAL_QUERIES.filter((entry) => !entry.expected.some((name) => catalog.has(name)))

    // A target that is not in the index is not a retrieval miss — no ranking
    // change could ever surface it — so it must fail loudly here instead of
    // sitting in the score as if the ranker were at fault.
    expect(unanswerable.map((entry) => entry.query)).toEqual([])
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
