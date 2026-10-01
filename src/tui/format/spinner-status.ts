/**
 * T9 格式化函数 — spinner 状态行（运行态指示器）。
 *
 * Wave 2 对标改造：spinner 支持动词池轮换（与 worker 面板词池风格统一，
 * activity-labels.ts 同源审美），默认池 + config `ui.spinnerVerbs` 覆盖/追加。
 * 轮换按 elapsed 时间片（8s 一换）而非 tick，避免高频闪词。
 * - stall（10s 无 token）时整行转琥珀色。
 * - reducedMotion：动画帧退化为静态字符、动词不轮换（无障碍）。
 * - 提供 ASCII fallback 兼容。
 */

import { color } from '../engine/ansi.js'
import { useAsciiGlyphs } from '../term-caps.js'
import type { RivetTheme } from '../theme.js'
import { circleSpinnerFrame } from '../braille-spinner.js'
import { displayWidth, truncateToDisplayWidth } from '../width.js'
import type { JobRow } from '../job-registry.js'

/** 宽度口径与 LiveEngine.rowsForLine / clampLine 一致（ambiguous 按 2 列）。 */
const WIDE = { ambiguousAsWide: true }

/**
 * activityLabel 的整行宽度适配。
 *
 * 不裁剪时整行超宽 → 调用方的 clampLine 从**尾部**截，正好把耗时切掉：
 * 「在等什么」可见而「等了多久」不可见——与本次如实化的意图正相反。这里把
 * 预算让给耗时（它是「还要不要等」的判断依据），只裁标签中段并加省略号。
 * 未提供 columns 时原样返回（纯 formatter 不知道终端宽度）。
 */
function clipActivityLabel(label: string, columns: number | undefined, frame: string, elapsedText: string): string {
  if (!columns) return label
  const budget = columns - 1 - displayWidth(`${frame} `, WIDE) - displayWidth(` ${elapsedText}`, WIDE)
  if (budget <= 2 || displayWidth(label, WIDE) <= budget) return label
  return `${truncateToDisplayWidth(label, Math.max(1, budget - 2), WIDE)}…`
}

export type SpinnerPhase = 'idle' | 'thinking' | 'streaming' | 'waiting' | 'analyzing'

const ASCII_FRAMES = ['-', '\\', '|', '/'] as const

/** 默认动词池——与 activity-labels.ts worker 词池同风格（中文、凝练、两字动词+中）。 */
const DEFAULT_VERBS = [
  'thinking', '思索中', '推演中', '梳理中', '构筑中', '琢磨中', '沉淀中',
] as const

/** 动词轮换周期（毫秒）——一个词至少停留这么久再换，避免闪烁。 */
const VERB_ROTATE_MS = 8_000

let verbPool: readonly string[] = DEFAULT_VERBS
let reducedMotion = false

/**
 * 配置 spinner 动词池（config `ui.spinnerVerbs` / `ui.spinnerVerbsMode` 接线）。
 * - replace: 完全替换默认池
 * - append: 追加到默认池尾部
 * 空数组视为未配置（保持当前池）。
 */
export function configureSpinnerVerbs(verbs: string[], mode: 'replace' | 'append' = 'replace'): void {
  if (verbs.length === 0) return
  verbPool = mode === 'append' ? [...DEFAULT_VERBS, ...verbs] : [...verbs]
}

/** reducedMotion 无障碍开关：动画帧静态化、动词固定为池首。 */
export function setReducedMotion(value: boolean): void {
  reducedMotion = value
}

/** 当前 reducedMotion 状态（其它瞬态动画——如 todo 徽章闪烁——据此降级为静态）。 */
export function isReducedMotion(): boolean {
  return reducedMotion
}

/** 重置为默认（测试用）。 */
export function resetSpinnerConfig(): void {
  verbPool = DEFAULT_VERBS
  reducedMotion = false
}

function spinnerFrame(tick: number, useAscii: boolean): string {
  if (reducedMotion) return useAscii ? '*' : '◐'
  if (useAscii) return ASCII_FRAMES[((tick % 4) + 4) % 4]!
  return circleSpinnerFrame(tick)
}

/** 按 elapsed 时间片从池中取动词。reducedMotion 时恒为池首。 */
function verbFor(elapsedMs: number): string {
  if (reducedMotion || verbPool.length === 1) return verbPool[0]!
  const slot = Math.floor(Math.max(0, elapsedMs) / VERB_ROTATE_MS)
  return verbPool[slot % verbPool.length]!
}

export function formatElapsedHuman(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000))
  if (secs < 60) return `${secs}s`
  return `${Math.floor(secs / 60)}m ${secs % 60}s`
}

export interface SpinnerStatusInput {
  tick: number
  phase: SpinnerPhase
  elapsedMs: number
  stalled?: boolean
  /**
   * 审批等待中（onApprovalRequired 挂起）。设置后 spinner 不再轮换「思索中」
   * 动词冒充模型活动，改为如实显示「等待审批 <tool> · Ns」——把「失去响应」
   * 变成「可见的等待」。waitMs 是审批等待时长（非 turn 时长）。
   */
  approvalWait?: { toolName: string; waitMs: number }
  /**
   * 活动如实标签（如 `运行 Bash(npm test)`）：设置后取代动词池轮换——
   * analyzing 相位下工具在跑却显示「琢磨中…」是冒充模型活动（与 approvalWait /
   * job-await 如实化同族，grok-build 的相位标签同构）。
   */
  activityLabel?: string
  /**
   * 终端列数：给定时 activityLabel 按「整行 ≤ columns-1」裁剪，保证耗时不被
   * 尾部截断（见 clipActivityLabel）。省略则不做宽度适配。
   */
  columns?: number
}

export function formatSpinnerStatus(input: SpinnerStatusInput, theme: RivetTheme): string | null {
  if (input.phase === 'idle') return null
  const useAscii = useAsciiGlyphs()
  const frame = spinnerFrame(input.tick, useAscii)
  if (input.approvalWait) {
    const { toolName, waitMs } = input.approvalWait
    const text = `${frame} 等待审批 ${toolName} · ${formatElapsedHuman(waitMs)}`
    return color(text, theme.warning)
  }
  const elapsedText = formatElapsedHuman(input.elapsedMs)
  const label = input.activityLabel
    ? clipActivityLabel(input.activityLabel, input.columns, frame, elapsedText)
    : input.phase === 'streaming' ? '正在生成…' : input.phase === 'waiting' ? '等待响应…' : `${verbFor(input.elapsedMs)}…`
  const text = `${frame} ${label} ${elapsedText}`
  const phaseColor: Record<SpinnerPhase, string> = {
    idle: theme.muted,
    thinking: theme.muted,
    streaming: theme.primary,
    analyzing: theme.muted,
    waiting: theme.warning,
  }
  // stall 优先级最高，覆盖 phase 颜色以提示用户
  return color(text, input.stalled ? theme.warning : phaseColor[input.phase])
}

export function formatTokenCount(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

// ── job(await) 等待区如实化 ──────────────────────────────────────────
//
// 根修「琢磨中 8m11s」撒谎：agent 阻塞在 job(action:'await') 期间零 token、
// 零事件，通用 spinner 却按 8s 时间片轮换思考系动词冒充模型活动。等待区改由
// 本 formatter 如实回答「在等谁 / 等了多久 / 上限多少」——与 approvalWait
// 同族（把「失去响应」变成「可见的等待」），且不轮换动词。

/** await 上限与 job-tool.ts 前后端 clamp 同口径：默认 120s，封顶 600s。 */
const DEFAULT_AWAIT_LIMIT_MS = 120_000
const MAX_AWAIT_LIMIT_MS = 600_000

/** 从工具 input.timeout 换算阻塞上限（非法/缺省 → 120s，>600s 截到 600s）。 */
export function jobAwaitLimitMs(timeoutMs: unknown): number {
  const t = Number(timeoutMs)
  return Math.min(Number.isFinite(t) && t > 0 ? t : DEFAULT_AWAIT_LIMIT_MS, MAX_AWAIT_LIMIT_MS)
}

export interface JobAwaitCall {
  /** await 目标 job id（工具 input.id）。 */
  jobId: string
  /** 工具 input.timeout（毫秒，可缺省）。 */
  timeoutMs?: unknown
  /** await 调用开始时刻（pending entry startMs）。 */
  startMs: number
}

export interface JobAwaitWaitView {
  /** 主行（未着色，调用方按 warning 上色）：⏳ 等待后台任务 <cmd> · 已等 Xs / 上限 Ys。 */
  line: string
  /** 次行（未着色，调用方淡化）：job 最后一行输出（截断），无则缺省。 */
  detail?: string
}

/** 压平空白（含 \n\r\t）后按字符截断——live 区行数安全，与 jobs-panel snippet 同口径。 */
function snippet(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * job(await) 等待区纯 formatter。jobRow 缺省（jobsModel 查不到该 jobId，如
 * 回放截断）时降级为 `等待后台任务 <jobId>` 不带 cmd；已等超过上限时转
 * 「运行已久 — Ctrl+C 可中断」档（await 已到点，如实说可中断而非继续报上限）。
 */
export function formatJobAwaitWait(call: JobAwaitCall, jobRow: JobRow | undefined, nowMs: number): JobAwaitWaitView {
  const waitMs = Math.max(0, nowMs - call.startMs)
  const limitMs = jobAwaitLimitMs(call.timeoutMs)
  const glyph = useAsciiGlyphs() ? '*' : '⏳'
  if (waitMs > limitMs) {
    return { line: `${glyph} 后台任务运行已久 — Ctrl+C 可中断 (${formatElapsedHuman(waitMs)})` }
  }
  const target = jobRow ? snippet(jobRow.command, 40) : call.jobId
  const line = `${glyph} 等待后台任务 ${target} · 已等 ${formatElapsedHuman(waitMs)} / 上限 ${formatElapsedHuman(limitMs)}`
  const detail = jobRow?.lastLine ? snippet(jobRow.lastLine, 60) : undefined
  return detail ? { line, detail } : { line }
}

export function formatTurnWorkSummary(input: {
  elapsedMs: number
  inputTokens?: number
  outputTokens?: number
}, theme: RivetTheme): string {
  const useAscii = useAsciiGlyphs()
  const glyph = useAscii ? '*' : '◆' // ASCII 降级原为 'Y'——与 ◆ 无语义关联，'*' 是通用近似
  const elapsed = formatElapsedHuman(input.elapsedMs)
  const tokens = input.inputTokens !== undefined && input.outputTokens !== undefined
    ? `${formatTokenCount(input.inputTokens)}→${formatTokenCount(input.outputTokens)}`
    : input.inputTokens !== undefined ? `${formatTokenCount(input.inputTokens)} in`
      : input.outputTokens !== undefined ? `${formatTokenCount(input.outputTokens)} out` : ''
  // 颜色层级：glyph 是完成指示（accent），耗时/token 是元信息（muted）。
  return `${color(glyph, theme.primary)} ${color(`完成 · ${elapsed}`, theme.muted)}${tokens ? ' ' + color(`· ${tokens}`, theme.muted) : ''}`
}
