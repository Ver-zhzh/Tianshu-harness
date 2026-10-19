import { evidenceProcess } from '../workers/evidence-process.js'
import type { buildTestExecutionPlan, TestExecutionPlan } from './test-execution-plan.js'

export async function buildTestExecutionPlanAsync(deadline: number, signal: AbortSignal | undefined,
  ...args: Parameters<typeof buildTestExecutionPlan>): Promise<TestExecutionPlan> {
  const worker = evidenceProcess(deadline, signal)
  try { return await worker.call('test-plan', args) }
  finally { worker.dispose() }
}
