/**
 * session-module-store-reaper — 会话键控的 agent 层 module store 收割汇点。
 *
 * 五张会话键控表此前只注册不清理——跑过团队计划/defer 审查的会话把这些记录
 * 永久钉在进程内（cron 每任务新 sessionId，长驻 sidecar 日积月累可达百 MB 级）。
 * releaseAgent（空闲回收/归档）与 hardDelete 都经 session-manager 的
 * forgetStores 走到这里。
 *
 * 收割分两档（2026-09-16 审查修复）：
 * - **挂起级**（terminal=false，releaseAgent）：只清「体积是释放收益主体」的
 *   表（wave 结果桥 / plan-store / post-commit 待审集）；会话可能被恢复续跑，
 *   代价是丢跨波回执情报与待审集（后者权衡记于 clearPendingReview 注释）。
 * - **终结级**（terminal=true，hardDelete）：五张全清——会话永不重建，
 *   留着就是净泄漏。
 * 门禁类（wave-gate / skill-gate）只在终结级清理：plan-executor 的跨波门禁
 * 判定是 fail-open（记录缺失即放行，plan-executor.ts:258-260），挂起级清掉会
 * 让闲置超时（默认 30min）或归档后恢复的会话绕过「上一波未过」的拦截——
 * 2026-09-16 审查探针复现（同输入、唯一变量是本收割）。两类记录与会话数
 * 1:1 有界，不构成泄漏；skill-gate 同族保留（清掉虽是 fail-closed 方向，
 * 但会让恢复会话重新执行计划时误拦要求重新加载）。
 *
 * @module session-module-store-reaper
 */

import { clearWaveResults } from './wave-results-store.js'
import { clearWaveGate } from './wave-gate.js'
import { clearPlan } from './plan-store.js'
import { clearPendingReview } from './post-commit-review-pending.js'
import { clearSessionReviewResults } from './post-commit-review-queue.js'
import { clearSkillGate } from './skill-gate.js'

/**
 * 收割指定会话在 module store 里的条目。各 clear 均按 sessionId 精确删除，
 * 不触碰他会在用条目与 '__default__' 兜底键；运行中的会话不会走到
 * releaseAgent，故不存在清掉在飞运行数据的窗口。terminal=true 表示会话
 * 已终结（hardDelete，永不重建）——五张全清。
 */
export function reapSessionModuleStores(sessionId: string, terminal = false): void {
  try { clearWaveResults(sessionId) } catch { /* best-effort */ }
  try { clearPlan(sessionId) } catch { /* best-effort */ }
  try { clearPendingReview(sessionId) } catch { /* best-effort */ }
  if (!terminal) return
  try { clearSessionReviewResults(sessionId) } catch { /* best-effort */ }
  try { clearWaveGate(sessionId) } catch { /* best-effort */ }
  try { clearSkillGate(sessionId) } catch { /* best-effort */ }
}
