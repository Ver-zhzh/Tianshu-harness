/**
 * 跨表面共享的会话状态与活性归约器（Single Source of Truth for Session Liveness & Run State）。
 *
 * 统一右侧原生 Chat (`src/chat/turn-events.ts` + `participant.ts`)、状态栏 (`src/extension.ts`)
 * 以及左侧座舱 Webview 对 sidecar SSE 事件的活性与运行态判定，消除多处手写判断导致的漂移。
 */
import type { SessionEvent, SessionEventType } from '../sidecar/protocol.js'

/**
 * 代表后端 run 仍在活跃推进的 SSE 事件类型集合（用于重置静默超时看门狗）。
 */
export type LivenessEventType = Extract<
  SessionEventType,
  | 'text_delta'
  | 'thinking_delta'
  | 'tool_use'
  | 'tool_result'
  | 'phase'
  | 'turn_complete'
  | 'watchdog_recovery'
  | 'retry'
  | 'hook_result'
  | 'job'
  | 'plan_draft'
>

const LIVENESS_EVENT_SET: ReadonlySet<string> = new Set<LivenessEventType>([
  'text_delta',
  'thinking_delta',
  'tool_use',
  'tool_result',
  'phase',
  'turn_complete',
  'watchdog_recovery',
  'retry',
  'hook_result',
  'job',
  'plan_draft',
])

/**
 * 判断一条 SSE 事件是否证明后端任务处于活跃工作状态。
 */
export function isLivenessEvent(ev: SessionEvent): boolean {
  if (!LIVENESS_EVENT_SET.has(ev.type)) return false
  if (ev.type === 'phase') {
    const phase = typeof ev.data?.phase === 'string' ? ev.data.phase : ''
    return phase.length > 0
  }
  return true
}

export interface SessionRunSummary {
  status: string
  phase: string
  pendingApprovals: number
  lastSeq: number
}

export function createInitialSessionRunSummary(): SessionRunSummary {
  return {
    status: 'idle',
    phase: '',
    pendingApprovals: 0,
    lastSeq: 0,
  }
}

/**
 * 纯函数归约器：根据单条 SSE 事件更新会话运行态摘要（供状态栏、原生 Chat 与座舱共用）。
 */
export function reduceSessionRunState(prev: SessionRunSummary, ev: SessionEvent): SessionRunSummary {
  const d = ev.data ?? {}
  const lastSeq = typeof ev.seq === 'number' && ev.seq > prev.lastSeq ? ev.seq : prev.lastSeq

  switch (ev.type) {
    case 'status': {
      const nextStatus = typeof d.status === 'string' && d.status ? d.status : prev.status
      return { ...prev, status: nextStatus, lastSeq }
    }
    case 'phase': {
      const nextPhase = typeof d.phase === 'string' ? d.phase : prev.phase
      return {
        ...prev,
        status: prev.status === 'idle' ? 'running' : prev.status,
        phase: nextPhase,
        lastSeq,
      }
    }
    case 'approval_required': {
      return {
        ...prev,
        pendingApprovals: prev.pendingApprovals + 1,
        lastSeq,
      }
    }
    case 'approval_resolved': {
      return {
        ...prev,
        pendingApprovals: Math.max(0, prev.pendingApprovals - 1),
        lastSeq,
      }
    }
    case 'approval_snapshot': {
      const list = Array.isArray(d.approvals) ? d.approvals : []
      return {
        ...prev,
        pendingApprovals: list.length,
        lastSeq,
      }
    }
    case 'done': {
      return {
        ...prev,
        status: 'idle',
        phase: '',
        pendingApprovals: 0,
        lastSeq,
      }
    }
    default:
      return lastSeq !== prev.lastSeq ? { ...prev, lastSeq } : prev
  }
}
