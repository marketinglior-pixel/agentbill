// A suggested ceiling for a job, from the account's own finished jobs
// (2026-09-23). The console's task budgets view lists, per agent, the p50,
// p90 and max used_units of that agent's recent finished jobs, and a click
// puts one of them in the ceiling field, still editable. The interview asked
// for exactly this: "not to start calculating", and to "know in advance".
//
// This module is the arithmetic only, with no database, so the sample console
// (?demo=1) and the real one run the same code and the harness can import it.
// Which rows count as finished is decided where the rows are read: the SQL in
// src/routes/app.ts (loadHistory) for an account, and demoHistory beside it
// for the sample data. Both apply the same test, stated there.

/** How many of an agent's most recently updated finished jobs a suggestion reads. */
export const HISTORY_JOBS = 20
/** How many agents the suggestion lists, most recently active leading. */
export const HISTORY_AGENTS = 5

export type Pick = 'p50' | 'p90' | 'max'
export const PICKS: readonly Pick[] = ['p50', 'p90', 'max']

/** One finished job: the agent that spent under it, what it spent, when it last moved. */
export type HistoryJob = { agentId: string; usedUnits: number; updatedAt: Date }
export type AgentHistory = { agentId: string; jobs: number } & Record<Pick, number>

/**
 * Postgres's percentile_disc, in integers: the smallest value with at least
 * pct percent of the values at or below it. So every figure offered is one a
 * real job used, never an interpolation, and 90 percent of 20 jobs is the
 * 18th smallest. The rank is ceil(n * pct / 100), worked out in integers so
 * no floating-point product decides it; the harness holds it to Postgres's
 * own percentile_disc.
 */
export function percentileDisc(sortedAsc: readonly number[], pct: number): number {
  const n = sortedAsc.length
  if (n === 0) throw new Error('percentileDisc of no values')
  const rank = Math.max(1, Math.floor((n * pct + 99) / 100))
  return sortedAsc[Math.min(n, rank) - 1]
}

/**
 * Group finished jobs by agent, keep each agent's HISTORY_JOBS most recently
 * updated, and give p50, p90 and max of their used_units. Agents are ordered
 * by their most recent job, then by label, and only HISTORY_AGENTS are kept.
 * An agent with no job here gets no row, so the view has nothing to show.
 */
export function summarizeHistory(rows: readonly HistoryJob[]): AgentHistory[] {
  const byAgent = new Map<string, HistoryJob[]>()
  for (const r of rows) {
    const list = byAgent.get(r.agentId)
    if (list) list.push(r)
    else byAgent.set(r.agentId, [r])
  }
  const out: { h: AgentHistory; lastAt: number }[] = []
  for (const [agentId, list] of byAgent) {
    const recent = [...list].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).slice(0, HISTORY_JOBS)
    const used = recent.map((r) => Number(r.usedUnits)).sort((a, b) => a - b)
    out.push({
      h: { agentId, jobs: used.length, p50: percentileDisc(used, 50), p90: percentileDisc(used, 90), max: used[used.length - 1] },
      lastAt: recent[0].updatedAt.getTime(),
    })
  }
  out.sort((a, b) => b.lastAt - a.lastAt || (a.h.agentId < b.h.agentId ? -1 : a.h.agentId > b.h.agentId ? 1 : 0))
  return out.slice(0, HISTORY_AGENTS).map((x) => x.h)
}
