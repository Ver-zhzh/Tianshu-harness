import { classifyVerificationIntent, nativeVerificationStartIntent, type VerificationExecutionIntent } from './verification-intent.js'
import { createVerificationRecorder } from './verification-recorder.js'
export { createVerificationRecorder } from './verification-recorder.js'
import type { VerificationMetadata } from '../tools/types.js'

export interface CourseExecutionCallbacks {
  onRepairDisposition?: (file: string) => void
  onMutationFacts?: (facts: import('./mutation-facts.js').MutationFact[]) => void
  onToolExecutionStart?: () => void
  onVerificationExecutionStart?: (intent: VerificationExecutionIntent) => number | void
  onVerificationExecutionSettled?: (sequence: number, result: VerificationMetadata) => void
}

export function courseExecutionCallbacks(deps: CourseExecutionCallbacks): CourseExecutionCallbacks {
  return { onRepairDisposition: deps.onRepairDisposition, onMutationFacts: deps.onMutationFacts, onToolExecutionStart: deps.onToolExecutionStart, onVerificationExecutionStart: deps.onVerificationExecutionStart,
    onVerificationExecutionSettled: deps.onVerificationExecutionSettled }
}

/** Only the actual, approved execution boundary may call this. */
export function beginCourseToolExecution(
  deps: CourseExecutionCallbacks & Parameters<typeof createVerificationRecorder>[0] & { cwd: string },
  name: string, input: Record<string, unknown>,
) {
  deps.onToolExecutionStart?.()
  const intent = name === 'run_tests' && (input.action ?? 'run') !== 'run' ? null : name === 'bash' ? typeof input.command === 'string' ? classifyVerificationIntent(input.command, deps.cwd) : null
    : nativeVerificationStartIntent(name, deps.cwd)
  const sequences = new Map<string, number | void>()
  // This closure preserves the launch version through background completion.
  const recorder = createVerificationRecorder({ ...deps, onRecorded: verification => {
    const sequence = verification.executionId ? sequences.get(verification.executionId) : undefined
    if (typeof sequence === 'number') deps.onVerificationExecutionSettled?.(sequence, verification)
  } })
  return Object.assign(recorder, { started(executionId: string) {
    if (sequences.has(executionId)) return
    sequences.set(executionId, intent && intent.purpose !== 'none' ? deps.onVerificationExecutionStart?.(intent) : undefined)
  } })
}
