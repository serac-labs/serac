/**
 * Minimal p-limit style concurrency helper.
 *
 * Used by the deep-search engine to parallelise many ServiceNow REST
 * queries without flooding the instance's token/rate budget. No external
 * dependency — we run a fixed pool of workers that pull from an internal
 * queue.
 */

export type Task<T> = () => Promise<T>

/**
 * Run tasks in parallel with a maximum of `limit` concurrent executions.
 * Returns results in the same order as the input tasks. Rejections are
 * converted to `null` entries so a single failing task never aborts the
 * whole batch — the caller inspects the returned array and handles nulls.
 */
export async function runWithLimit<T>(
  tasks: Task<T>[],
  limit: number,
): Promise<Array<T | null>> {
  if (tasks.length === 0) return []
  const size = Math.max(1, Math.min(limit, tasks.length))
  const results: Array<T | null> = new Array(tasks.length).fill(null)
  let cursor = 0

  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++
      if (idx >= tasks.length) return
      try {
        results[idx] = await tasks[idx]()
      } catch {
        results[idx] = null
      }
    }
  }

  const workers = Array.from({ length: size }, () => worker())
  await Promise.all(workers)
  return results
}
