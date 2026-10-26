import { join } from 'node:path'
import { getSessionDir } from '../agent/session-persist.js'
import { publishFactHandoff, type HandoffLiveInput } from '../agent/fact-handoff.js'
import { createHandoffRequest, buildHandoffPrompt, type HandoffRequest } from '../tui/handoff.js'
import { redactText } from './redact.js'

/**
 * /handoff 的结果。归档与模型叙述是两件事：事实快照落盘即算成功，
 * 叙述未启动只体现在 narrative=skipped，不改 ok。
 */
export interface HandoffResult {
  ok: boolean
  error?: string
  /** 事实快照是否已落盘并广播事件。 */
  archived?: boolean
  snapshotId?: string
  /** 模型叙述的处理结果：started=已发起；skipped=归档完成但叙述未启动。 */
  narrative?: 'none' | 'started' | 'skipped'
  reason?: string
}

interface HandoffSession {
  record: { id: string; cwd: string }
  running: boolean
  agent?: { getHandoffInput?(): HandoffLiveInput } | null
  pendingHandoff?: HandoffRequest
}
export function requestSessionHandoff(session: HandoffSession | undefined, note: string | undefined,
  options: { narrative?: boolean }, deps: {
    start(prompt: string): boolean
    append(type: 'handoff_archived' | 'intent_note', data: Record<string, unknown>): void
  }): HandoffResult {
  if (!session) return { ok: false, error: 'Session not found' }
  const id = session.record.id
  if (session.running) return { ok: false, error: 'Session is already running' }
  let snapshotId: string
  try {
    const snapshot = publishFactHandoff(session.record.cwd, id, session.agent?.getHandoffInput?.(), note)
    snapshotId = snapshot.snapshotId
    deps.append('handoff_archived', { text: `事实交接已归档（零模型调用；默认不注入）\n${snapshot.brief}`, snapshotId })
  } catch (error) { return { ok: false, error: String(error) } }
  if (!options.narrative) return { ok: true, archived: true, snapshotId, narrative: 'none' }
  const skipped = (reason: string): HandoffResult => {
    session.pendingHandoff = undefined
    const text = `事实交接已归档（${snapshotId}），模型叙述未启动：${redactText(reason)}；未自动重试。`
    deps.append('intent_note', { title: '交接叙述未启动', summary: text, text, reasons: [], action: '可稍后显式重试叙述' })
    return { ok: true, archived: true, snapshotId, narrative: 'skipped', reason: redactText(reason) }
  }
  try {
    const dest = join(getSessionDir(session.record.cwd), `${session.record.id}.handoff.md`)
    const request = createHandoffRequest(session.record.cwd, id, dest)
    request.liveInput = session.agent?.getHandoffInput?.()
    session.pendingHandoff = request
    if (!deps.start(buildHandoffPrompt(request.sourcePath, note))) return skipped('当前会话或运行时不接受新的叙述请求')
    return { ok: true, archived: true, snapshotId, narrative: 'started' }
  } catch (error) { return skipped(String(error)) }
}
