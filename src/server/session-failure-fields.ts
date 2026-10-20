import { describeFailure } from '../api/failure-scope.js'
import { UserInstructionsError } from '../prompt/user-instructions.js'
import { errorRecoveryGuidance } from '../api/error-classifier.js'
import { isColdStartEvidenceError, continuityFailureDetails } from '../api/continuation-prefix.js'

/** Shared error event fields; diagnostics contain no rule text or local source paths. */
export function sessionFailureFields(err: unknown): { scope?: 'local' | 'provider'; kind?: string; guidance?: string; continuity?: ReturnType<typeof continuityFailureDetails> } {
  try {
    if (err instanceof UserInstructionsError) return { scope: 'local', kind: err.code, guidance: err.code === 'user_instructions_boundary_required'
      ? '请发送新输入应用当前规则；历史正文仍保留，彻底移除需新建会话。'
      : '请修正用户全局配置或指令文件后重试；未自动截断或忽略规则。' }
    // resume 证据门（冷启动证据缺失）：不是故障，是待用户抉择——kind 供桌面渲染
    // 「以当前配置继续」动作，guidance 说清代价（缓存全量重建一次）。
    if (isColdStartEvidenceError(err)) return { kind: 'cold_start_evidence', guidance: '可显式开始新会话；或点「以当前配置继续」放弃连续性证明——缓存将全量重建一次，之后恢复正常。' }
    // server 只服务桌面端（sidecar HTTP/SSE）——指引走 desktop 分流，不给 slash 命令。
    if (continuityFailureDetails(err)) return { scope: 'local', kind: 'continuity_projection', continuity: continuityFailureDetails(err), guidance: errorRecoveryGuidance(err, 'desktop') }
    const f = describeFailure(err)
    const guidance = err instanceof Error && err.name === 'AbortError'
      ? undefined
      : errorRecoveryGuidance(err, 'desktop')
    return {
      ...(f.category === 'unknown' && f.kind === 'other' ? {} : { scope: f.scope, kind: f.kind }),
      ...(guidance ? { guidance } : {}),
    }
  } catch { return {} }
}
