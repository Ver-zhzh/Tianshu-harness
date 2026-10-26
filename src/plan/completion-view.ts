import type { PlanDocument } from './plan-store.js'
import { planRevision } from './plan-revision.js'
import { readPlanClosures } from './continuity-records.js'
import { readPlanCompletionSummary } from './completion-summary.js'
/** One owner and one plan revision; never promotes another session's closure. */
export function withPlanCompletion(cwd: string, sessionId: string, plan: PlanDocument): PlanDocument {
  try {
    const closure = readPlanClosures({ cwd, sessionId }).filter(c => c.planRef === plan.path).at(-1)
    if (closure) return { ...plan, completion: { summary: closure.summary, revision: planRevision(plan.content) === closure.afterRevision ? 'current' : 'changed' } }
  } catch { /* historical text remains readable, with unknown version */ }
  const summary = readPlanCompletionSummary(plan.content)
  return summary ? { ...plan, completion: { summary, revision: 'unknown' } } : plan
}
