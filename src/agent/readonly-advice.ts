export type ReadonlyAdviceMode = 'off' | 'shadow' | 'active'
export function readonlyAdviceMode(env = process.env): ReadonlyAdviceMode {
  return env.RIVET_READONLY_ADVICE_EXPERIMENT === '1' ? 'active'
    : env.RIVET_READONLY_ADVICE_EXPERIMENT === 'shadow' ? 'shadow' : 'off'
}
export interface ReadonlyAdviceFacts {
  explicitReadonly?: boolean
  modifiedFiles?: number
  verificationDebt?: boolean
  pendingObligations?: boolean
  history: ReadonlyArray<{ tool: string; status: string; bashActivity?: string }>
}
const READ_OBSERVATIONS = new Set(['read_file', 'grep', 'glob', 'web_fetch', 'web_search', 'repo_map', 'repo_graph',
  'inspect_project', 'semantic_search', 'lsp_goto_definition', 'lsp_find_references', 'file_info', 'recall', 'recall_capsule'])
const FACT_TASKS = new Set(['code_explanation', 'usage_question', 'codebase_overview', 'review_audit'])
/** Readonly permission alone does not rule out an explicit request to run tests. */
export function readonlyFactTask(explicitReadonly: boolean | undefined, kinds?: readonly string[]): boolean | undefined {
  if (explicitReadonly === undefined || !kinds?.length) return undefined
  return explicitReadonly && kinds.every(kind => FACT_TASKS.has(kind))
}

/** Missing facts keep the existing advice. This policy never changes a gate. */
export function readonlyAdviceDecision(facts: ReadonlyAdviceFacts): 'eligible' | 'unknown' | 'not_readonly' | 'verification_pending' | 'modified' {
  if (facts.explicitReadonly === undefined || facts.modifiedFiles === undefined || facts.verificationDebt === undefined
    || facts.pendingObligations === undefined || !Number.isFinite(facts.modifiedFiles)) return 'unknown'
  if (facts.verificationDebt || facts.pendingObligations) return 'verification_pending'
  if (facts.modifiedFiles !== 0) return 'modified'
  if (!facts.explicitReadonly || !facts.history.length || !facts.history.every(h => h.status === 'success'
    && (READ_OBSERVATIONS.has(h.tool) || h.tool === 'bash' && h.bashActivity === 'readonly'))) return 'not_readonly'
  return 'eligible'
}
