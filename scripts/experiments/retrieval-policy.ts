import type { OaiChatRequest } from '../../src/api/types.js'
import { buildSystemPrompt } from '../../src/prompt/static.js'

export type RetrievalArm = 'A' | 'B' | 'C'
export const RETRIEVAL_CALIBRATION = '<calibration>对影响当前修改或结论的关键事实，使用能区分当前假设的最小证据。先定位入口、相关消费方和测试，再读取必要区段。已取得且仍适用的证据可复用，不因轮次增加重复检索；文件变化、证据被截断或压缩丢失、出现矛盾时，补查对应部分。证据足以支持下一步就实施或验证；只读任务按其目标给出结论。检索无结果只支持所查范围未命中，错误信息只说明该操作的观察，不直接证明根因或整个任务不可执行。</calibration>'
export const CURRENT_CALIBRATION = buildSystemPrompt({ tools: [], modelFamily: 'deepseek' }).slice(buildSystemPrompt({ tools: [] }).length)
/** Only before the first dispatch; never edit a published request or the production prompt. */
export function retrievalRequest(template: OaiChatRequest, arm: RetrievalArm): OaiChatRequest {
  const request = { ...template, messages: structuredClone(template.messages) }
  const system = request.messages[0]
  if (!CURRENT_CALIBRATION.startsWith('\n\n<calibration>') || system?.role !== 'system' || typeof system.content !== 'string' || !system.content.endsWith(CURRENT_CALIBRATION)) throw new Error('DeepSeek calibration anchor changed; re-register the experiment')
  const base = system.content.slice(0, -CURRENT_CALIBRATION.length)
  system.content = base + (arm === 'A' ? CURRENT_CALIBRATION : arm === 'B' ? '' : '\n\n' + RETRIEVAL_CALIBRATION)
  return request
}
export const RETRIEVAL_TASKS = ['readonly-alias', 'synthetic', 'scoped-hook'] as const
export type RetrievalTask = typeof RETRIEVAL_TASKS[number]
export function retrievalOrder(repetitions: number) {
  if (![1, 3].includes(repetitions)) throw new Error('Register either a one-per-cell pilot or three-per-cell replication')
  return Array.from({ length: repetitions }, (_, repetition) => RETRIEVAL_TASKS.flatMap((task, taskIndex) =>
    Array.from({ length: 3 }, (_, i) => ({ task, arm: ['A', 'B', 'C'][(i + taskIndex + repetition) % 3] as RetrievalArm, repetition: repetition + 1 })))).flat()
}
export function capacityQualified(results: { status: string; budget: { uncertain: boolean }; adapterFaults: number }[]) {
  return results.length === 2 && results.every(r => r.status === 'final' && !r.budget.uncertain && r.adapterFaults === 0)
}
