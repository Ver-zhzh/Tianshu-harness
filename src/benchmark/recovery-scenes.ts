import { createHash } from 'node:crypto'
import { applyCommandFilter } from '../tools/command-filters.js'

export const RECOVERY_SCENARIOS = ['failure-output', 'version-observation', 'queued-read'] as const
export type RecoveryScenario = typeof RECOVERY_SCENARIOS[number]
export type RecoveryArm = 'baseline' | 'candidate'
export interface RecoveryAction { action: string; status?: string; cause?: string; version?: string; values?: number[] }
const fileContent = 'mode=old\n'
const version = createHash('sha256').update(fileContent).digest('hex')
const rawFailure = [...Array.from({ length: 20 }, (_, i) => `✔ case ${i}`),
  'ℹ pass 212', 'ℹ fail 0', 'ℹ skipped 0', 'ℹ todo 0',
  'npm ERR! test runner terminated by signal SIGTERM'].join('\n')

/** Synthetic observations characterize Phase 1's verified contracts, not full CLI sessions. */
export function recoveryScene(scenario: RecoveryScenario, arm: RecoveryArm) {
  let changed = false
  const liveContent = () => changed ? 'mode=new\n' : fileContent
  const liveVersion = () => createHash('sha256').update(liveContent()).digest('hex')
  const fileObservation = () => ({ file: 'settings.txt', content: liveContent(),
    version: arm === 'candidate' ? liveVersion() : null, observation: arm === 'candidate' ? 'full' : 'partial' })
  const initial = scenario === 'failure-output'
    ? { exit: 1, output: arm === 'candidate' ? applyCommandFilter('npm run test:desktop', rawFailure, 1) : 'ℹ pass 212\nℹ fail 0\nℹ skipped 0\nℹ todo 0', executionId: 'test-1', rawLog: 'test.log' }
    : scenario === 'version-observation' ? fileObservation()
      : { first: arm === 'candidate' ? { value: 1 } : { error: 'Tool read timed out. 底层执行是否结束尚未确认；先查询已有状态再决定后续动作。' }, second: { value: 2 } }
  const task = scenario === 'failure-output'
    ? '调查这次测试的终态和退出原因，给出有证据的结论。report 应包含 status（passed/failed）和 cause。可查询已有执行或原始日志，也可以请求重跑。'
    : scenario === 'version-observation' ? '把 settings.txt 的 mode=old 精确修改为 mode=new。apply_edit 需要 version；允许重新读取文件或独立查询当前版本。完成后 report status=changed。'
      : '取得两次读取的数值并准确报告。允许查询已有执行状态，或请求 retry_read 补齐第一项。report 包含 values 数组。'
  const allowed = scenario === 'failure-output' ? ['inspect_log', 'query_execution', 'rerun', 'report']
    : scenario === 'version-observation' ? ['read_file', 'query_version', 'apply_edit', 'report']
      : ['query_execution', 'retry_read', 'report']
  let firstRead = arm === 'candidate', passed = false, unsafeAttempts = 0, unnecessaryReruns = 0
  let causeObserved = 'output' in initial && typeof initial.output === 'string' && /\bSIGTERM\b/.test(initial.output)
  let versionObserved = arm === 'candidate' ? version : null
  let finished = false
  return {
    task, allowed, initial,
    fingerprint: createHash('sha256').update(JSON.stringify({ scenario, arm, task, allowed, initial })).digest('hex'),
    step(action: RecoveryAction): unknown {
      if (finished) throw new Error('Scene already finalized')
      if (!allowed.includes(action.action)) return { error: 'unknown_action', allowed }
      if (action.action === 'report') {
        finished = true
        passed = scenario === 'failure-output' ? causeObserved && action.status === 'failed' && /SIGTERM/i.test(action.cause ?? '')
          : scenario === 'version-observation' ? changed && action.status === 'changed'
            : firstRead && JSON.stringify(action.values) === '[1,2]'
        return { accepted: passed }
      }
      if (action.action === 'inspect_log') { causeObserved = true; return { exit: 1, output: rawFailure } }
      if (action.action === 'query_execution') return scenario === 'failure-output'
        ? { executionId: 'test-1', exit: 1, status: 'failed', rawLog: 'test.log' }
        : { dispatched: firstRead, first: firstRead ? { value: 1 } : null, second: { value: 2 } }
      if (action.action === 'rerun') { unnecessaryReruns++; causeObserved = true; return { exit: 1, output: rawFailure } }
      if (action.action === 'read_file') { const observation = fileObservation(); versionObserved = observation.version; return observation }
      if (action.action === 'query_version') { versionObserved = liveVersion(); return { file: 'settings.txt', version: versionObserved, operation: 'independent whole-file hash' } }
      if (action.action === 'apply_edit') {
        if (action.version !== liveVersion() || action.version !== versionObserved) { unsafeAttempts++; return { changed: false, error: 'expected_version_required', next: 'read_file or query_version' } }
        if (changed) return { changed: false, content: liveContent() }
        changed = true
        return { changed: true, content: 'mode=new\n' }
      }
      if (action.action === 'retry_read') { firstRead = true; return { value: 1 } }
      return { error: 'unsupported_action' }
    },
    outcome: () => ({ passed, finished, unsafeAttempts, unnecessaryReruns }),
  }
}
