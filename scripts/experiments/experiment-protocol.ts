import { randomUUID } from 'node:crypto'
import type { Usage } from '../../src/api/types.js'

export type Origin = 'harness' | 'policy' | 'candidate' | 'provider' | 'unknown'
export interface Observation {
  origin: Origin; code: string; executed: boolean; phase: string; sourceHash: string
  evidenceId: string; nextAction?: string
}
export const observation = (origin: Origin, code: string, executed: boolean, phase: string, sourceHash: string, nextAction?: string): Observation =>
  ({ origin, code, executed, phase, sourceHash, evidenceId: randomUUID(), ...(nextAction ? { nextAction } : {}) })
export type Verdict = 'pass' | 'fail' | 'inconclusive'
export interface Stage {
  id: string; required: boolean; executed: boolean; exit: number | null; timedOut: boolean
  output: string; origin: Origin; tests?: { passed: number; failed: number; skipped: number }
  command?: string[]
}
export function nodeTestCounts(output: string): Stage['tests'] {
  const number = (key: string) => Number(output.match(new RegExp(`(?:ℹ |# )${key} (\\d+)`))?.[1] ?? 0)
  return { passed: number('pass'), failed: number('fail'), skipped: number('skipped') }
}
export function checkEvidence(before: string, after: string, protectedUnchanged: boolean, runs: Stage[]) {
  const required = runs.filter(r => r.required)
  const flowEnded = runs.filter(r => r.executed).every(r => r.exit !== null && !r.timedOut)
  const stagesComplete = required.length > 0 && required.every(r => r.executed && r.exit !== null && !r.timedOut && (!r.tests || r.tests.passed + r.tests.failed > 0 && r.tests.skipped === 0))
  const complete = flowEnded && stagesComplete && protectedUnchanged && before === after
  return { before, after, protectedUnchanged, flowEnded, stagesComplete, complete,
    passed: complete && required.every(r => r.exit === 0 && (!r.tests || r.tests.failed === 0)), runs }
}
export function verdict(id: string, value: boolean | null, evidence: unknown, origin: Origin = 'candidate') {
  return { id, verdict: value === null ? 'inconclusive' as const : value ? 'pass' as const : 'fail' as const,
    passed: value === true, origin, evidence }
}

/** Reserve the full production request limit; missing usage keeps the reservation. */
export class CompletionLedger {
  spent = 0
  reserved = 0
  uncertain = false
  constructor(readonly requestLimit: number, readonly trialLimit = requestLimit * 2) {
    if (!Number.isSafeInteger(requestLimit) || requestLimit < 1 || !Number.isSafeInteger(trialLimit) || trialLimit < requestLimit) throw new Error('Invalid completion budget')
  }
  admit(): boolean {
    if (this.reserved || this.uncertain || this.trialLimit - this.spent < this.requestLimit) return false
    this.reserved = this.requestLimit; return true
  }
  settle(usage?: Partial<Usage>): void {
    if (!this.reserved) throw new Error('No request reservation')
    if (usage?.estimated || !Number.isSafeInteger(usage?.output_tokens) || usage!.output_tokens! < 0 || usage!.output_tokens! > this.reserved) { this.uncertain = true; return }
    this.spent += usage!.output_tokens!; this.reserved = 0
  }
  releaseUnsent(): void { if (!this.reserved) throw new Error('No request reservation'); this.reserved = 0 }
  snapshot() { return { requestLimit: this.requestLimit, trialLimit: this.trialLimit, spent: this.spent, reserved: this.reserved, uncertain: this.uncertain } }
}
