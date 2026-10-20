import type { AdvisoryEntry } from '../../src/agent/advisory-bus.js'

export const GOAL = `修复这个独立的持久化任务服务。用户反馈重试后的失败会被旧成功覆盖，取消的任务偶尔又完成；重启和多个 namespace 共用数据目录时更容易出现异常。
先运行 node scripts/reproduce.mjs 等价的 run_checks 获取真实复现，查明根因，再实施修复并验证。保留现有 API 和事件字段；恢复时旧的合法事件仍应可读。取消、重试、重启后租约和 namespace 的归属必须保持正确。
可以自由修改 src/ 下源码并在 test/ 新增回归测试。原 smoke 测试、复现脚本、README 和 package.json 不得修改。不安装依赖、不使用网络、不提交。工具 run_checks 无参数会运行原 smoke 与原复现，带 test_file 可运行你新增的测试。可用 list_files、read_file、edit_file、write_file 取证与修改。最终报告区分已验证行为、推断和未验证项。`

export interface BoundCheck { before: string; after: string; complete: boolean; passed: boolean; runs: Array<{ id: string; executed: boolean; exit: number | null; timedOut: boolean }> }
/** Trusted adapter results only; stdout/model prose cannot create recognition. */
export class RecoveryFeedback {
  private failureSeen = false
  private successSeen = false
  observe(check: BoundCheck, positive: boolean, runId: string, callId: string): AdvisoryEntry | null {
    if (!check.complete || check.before !== check.after || !check.runs.length || check.runs.some(r => r.exit === null || r.timedOut)) return null
    let kind: string, fact: string, acknowledgement: string
    const reproduction = check.runs.find(r => r.id === 'reproduction' && r.executed)
    if (!reproduction) return null
    if (!check.passed && reproduction.exit !== 0 && !this.failureSeen) {
      this.failureSeen = true; kind = 'reproduced'
      fact = '原任务复现已实际执行且失败。具体已执行阶段见工具证明；该证据不确定根因，也不排除实现问题。'
      acknowledgement = '你取得了与当前源码绑定的失败证据，可以据此继续核对假设。'
    } else if (check.passed && this.failureSeen && !this.successSeen) {
      this.successSeen = true; kind = 'original-checks-recovered'
      fact = '原任务的必要检查阶段在当前源码版本均实际执行并通过。这不证明其他行为或平台通过；按原任务范围交付，不增加新的工作目标。'
      acknowledgement = '你把原检查从失败推进到了真实通过，这一步有可复核的结果。'
    } else return null
    return { key: `experiment-recovery:${runId}:${kind}`, category: 'encouragement', tier: 'operational', priority: 0.4,
      channel: 'system-reminder', srClass: 'discipline', ttl: 1,
      content: `${positive ? acknowledgement : ''}${fact} 证据引用=${callId}，源码指纹=${check.after.slice(0, 16)}。` }
  }
}
