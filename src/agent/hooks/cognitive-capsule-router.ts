/**
 * Cognitive Capsule Router (CCR) — Phase 2
 *
 * Reads cognitive-mirror dimensions each turn and routes to the most
 * relevant star-domain principle via the advisory bus.
 *
 * Phase 2 additions:
 * - Dynamic principle pool extraction from <principle> tags in capsule docs
 * - Vigor tonic/phasic split for P3 principle selection
 * - Telemetry callback for trigger event recording
 *
 * Design: docs/design/2026-06-17-sr-intelligent-reminder.md
 * Supplement: docs/design/2026-06-18-sr-router-supplement.md
 */

import type { PreTurnRuntimeHook } from '../runtime-hooks.js'
import type { AdvisoryEntry, AdvisoryExpectation } from '../advisory-bus.js'
import type { EvidenceState } from '../evidence.js'
import type { Sensorium } from '../sensorium.js'
import type { VigorState } from '../vigor.js'
import { classifyActivityMode, PRODUCTIVE_TOOLS, type ActivityMode } from '../convergence-detector.js'
import { extractPrinciples, getCapsuleByStar, type ExtractedPrinciple } from '../seed-capsule-store.js'

interface AdvisoryBusLike {
  submit(entry: AdvisoryEntry): void
}

// ─── Principle Pools ─────────────────────────────────────────────

export interface Principle {
  key: string
  actionPrompt: string
}

// Hardcoded fallback pools — used when capsule docs have no <principle> tags

// 与 docs/seed-capsule-yaoguang.md 的 <principle> 池保持同步（Y1–Y10）。
// 胶囊在场时走动态池，这里只是无胶囊环境的兜底——但兜底落后于胶囊
// 意味着裸环境的瑶光缺一半方法论，同步是纪律不是可选。
const YAOGUANG_FALLBACK: Principle[] = [
  { key: 'Y1', actionPrompt: '那行修复能复现原缺陷吗？先 RED→GREEN 再声称已验证' },
  { key: 'Y2', actionPrompt: '不要靠测试绿就判断完成——用原缺陷输入跑一次确认' },
  { key: 'Y5', actionPrompt: '你刚下的结论有没有 ground truth 能自检？' },
  { key: 'Y3', actionPrompt: '这个 bug 和上次的是同一族吗？查 git log 看同类修复' },
  { key: 'Y4', actionPrompt: '不加兜底——补正确语义，不改容错倾向' },
  { key: 'Y6', actionPrompt: '逐条核对 spec 的验收条件，不靠"看起来完成了"' },
  { key: 'Y7', actionPrompt: '测试 fixture 复现了真实系统产出的输入形状吗？追到产出它的那行代码' },
  { key: 'Y8', actionPrompt: '怀疑某机制静默失效？先给它装账本（触发/渲染/丢弃计数），让"没发生"变成可观测事实' },
  { key: 'Y9', actionPrompt: '测试失败先验基线（stash/worktree 跑同一用例），分清"我弄坏的"与"本来就坏的"再归因' },
  { key: 'Y10', actionPrompt: '声称注入/发送的信息，去消费端确认它真的到了——选了却没送达是最安静的断裂' },
]

const TIANXUAN_FALLBACK: Principle[] = [
  { key: 'X1', actionPrompt: '去一个不相关的目录 glob，看你是否忽略了其他模块' },
  { key: 'X3', actionPrompt: '用一个不匹配现有方案的输入跑一次测试，看它会不会红' },
  { key: 'X4', actionPrompt: '别在同一个抽象层深挖——上一层或下一层可能有捷径' },
]

const TIANQUAN_FALLBACK: Principle[] = [
  { key: 'Q1', actionPrompt: 'grep 调用方、读代码、理解数据流——再画架构图' },
  { key: 'Q2', actionPrompt: '每完成一个 task：typecheck + test + commit，不积攒' },
  { key: 'Q3', actionPrompt: '这条路走了三次都撞墙？换维度，别同方向硬推' },
]

const TIANFU_FALLBACK: Principle[] = [
  { key: 'F1', actionPrompt: '不确定的假设不要默认通过——写断言让它 fail，再看' },
  { key: 'F2', actionPrompt: '不变更不破坏既有契约，改动前确认调用方' },
]

const STAR_FALLBACK_POOLS: Record<StarDomain, Principle[]> = {
  '瑶光': YAOGUANG_FALLBACK,
  '天璇': TIANXUAN_FALLBACK,
  '天权': TIANQUAN_FALLBACK,
  '天府': TIANFU_FALLBACK,
}

function toPrinciples(extracted: ExtractedPrinciple[]): Principle[] {
  return extracted.map(e => ({ key: e.key, actionPrompt: e.actionPrompt }))
}

// ─── Rule Table ──────────────────────────────────────────────────

type StarDomain = '瑶光' | '天璇' | '天权' | '天府'

interface RouteRule {
  id: string
  star: StarDomain
  match: (s: RouteState) => boolean
  busPriority: number
  /** Key filter — when set, only use principles whose key is in this set. */
  poolKeyFilter?: Set<string>
  promptTemplate: string
  suppressOnTestIntent?: boolean
  /** 胶囊召回指向的星域（缺省 = rule.star）。P7 由天权发声但方法论在瑶光胶囊。 */
  recallStar?: string
  /** P1a 核销谓词 — 该改道提醒被采纳时的行为签名（缺省 = 只计送达） */
  expect?: AdvisoryExpectation
  /** Phase 2 多信号确认 — 本规则触发时提前确认这些 key 的挂起条目 */
  corroborates?: string[]
}

interface RouteState {
  turn: number
  verificationCoverage: number
  filesModified: number
  vigor: number
  vigorTonic: number
  vigorPhasic: number
  lastTool: string
  lastToolTarget: string
  /** Sensorium 预测动量 — 排查停滞规则（P6）的主信号。 */
  momentum: number
  /** 连续只读（非产出类）工具数 — 排查场景不依赖 filesModified。
   *  来源见 readOnlyStreakSource：生产口径是 recorder 侧独立累计计数，
   *  不受 5 条窗口容量限制（P6 阈值 6/10 高于窗口上限）。 */
  readOnlyStreak: number
  /** readOnlyStreak 的事实来源 — 'cumulative' = recorder 侧独立累计（唯一权威）；
   *  'window' = 事实缺席时的 5 条窗口派生回退（恒 ≤5，低于两个阈值）。 */
  readOnlyStreakSource: ReadOnlyStreakSource
  /** 队尾有效验证连败数（run_tests/bash 语义失败；TDD 编辑/取证间隔各封顶稀释一次）。 */
  verifyFailStreak: number
  /** 会话活动模式（convergence 的 classifyActivityMode 单一事实源）——
   *  A1 接线（2026-07-23 信号互扰治理）：诊断态下惩罚信号做阈值分级而非
   *  完全豁免，保底检测不死。 */
  activityMode: ActivityMode
}

// 产出类工具集合从 convergence-detector 导入（A2 单一事实源）——此前本文件
// 自持副本已与 convergence 侧漂移分叉（缺 apply_patch/ast_edit），两套判据
// 对同一轨迹给出矛盾的"空转"结论。
/** 验证类工具 — 失败流水从这两个工具的 status/errorClass 提取。 */
const VERIFY_TOOLS = new Set(['run_tests', 'bash'])
/** 编辑类工具 — TDD 稀释判定用（两次验证失败之间夹编辑 = 在响应 RED 反馈）。
 *  注意与 isTestIntent 中 2026-07-04 删除的 EDIT_TOOLS 分支无关——那是压制
 *  机制（编辑≠测试意图），这里是 streak 计数的编辑间隔统计。 */
const EDIT_TOOLS = new Set(['edit_file', 'write_file', 'hash_edit', 'apply_patch', 'ast_edit'])

type HistoryEntry = { tool: string; target: string; status?: 'success' | 'failed' | 'running'; errorClass?: string }

/** 队尾连续只读工具数（遇到产出类工具即停）。 */
export function computeReadOnlyStreak(history: ReadonlyArray<HistoryEntry>): number {
  let streak = 0
  for (let i = history.length - 1; i >= 0; i--) {
    if (PRODUCTIVE_TOOLS.has(history[i]!.tool)) break
    streak++
  }
  return streak
}

/** readOnlyStreak 的事实来源。 */
export type ReadOnlyStreakSource = 'cumulative' | 'window'

/** 只读连胜事实的读取面（值 + 来源，来源用于遥测与反证）。 */
export interface ReadOnlyStreakFact {
  value: number
  source: ReadOnlyStreakSource
}

/**
 * P6 的只读连胜事实来源（S2 可达性修复）。
 *
 * 缺陷事实：`recentToolHistory` 是 5 条滑动窗口（tool-history-recorder 的
 * `length > 5 → shift()` 上限），而 P6 的阈值是 6（build）/ 10（diagnostic）——
 * 窗口派生值恒 ≤5，P6 在生产里**不可达**（现有单测喂 8-10 条历史才绿，
 * 真实产出形状永远到不了，属"测试绿而生产死"）。窗口容量是别处的既有契约
 * （不扩大共享历史），所以连续计数必须由 recorder 侧独立累计并随 snapshot
 * 下发（`readOnlyStreak`），本函数只做读取 + 缺数据语义。
 *
 * 缺失语义：字段缺席（未接线 / 旧固件 / 手工固件）→ 回退窗口派生值（≤5，
 * 低于两个阈值）——"缺数据不判停滞"，与 P1b 的 momentum no-data 回退同方向：
 * 读不到事实时不指控停滞。来源经 dimValues.readOnlyStreakCumulative 上报，
 * 让"事实没送达"可观测——否则接线断裂会静默退化成永不触发。
 *
 * 事实在场时它是唯一权威（窗口只是它的末尾子集）：产出工具或新用户任务重置
 * 计数后窗口仍可能残留旧只读条目，此时以事实为准，不拿陈旧窗口判停滞。
 */
export function resolveReadOnlyStreak(snapshot: {
  recentToolHistory: ReadonlyArray<HistoryEntry>
  readOnlyStreak?: number
}): ReadOnlyStreakFact {
  const reported = snapshot.readOnlyStreak
  if (typeof reported === 'number' && Number.isFinite(reported) && reported >= 0) {
    return { value: reported, source: 'cumulative' }
  }
  return { value: computeReadOnlyStreak(snapshot.recentToolHistory), source: 'window' }
}

/**
 * 队尾有效验证连败数（TDD 编辑间隔、诊断取证间隔各封顶稀释一次）。
 *
 * 语义：从队尾回看，验证工具（run_tests/bash）的语义失败（非 environment/
 * timeout）计入流水，遇到一次验证成功即停。两次失败之间的间隔按性质稀释：
 * - 夹编辑 = agent 在响应 RED 反馈（TDD 循环）——稀释一次
 * - 只夹只读取证（read/grep 等）= agent 在诊断中复现（RED→定位→复跑）——稀释一次
 * 两类豁免各封顶 1，同一间隔同时有编辑和只读时只算编辑豁免（不双记）。
 * 「改了一次还红」「读了一轮再复现还红」是正常工作流；「改了两三次还红」
 * 「读了两轮仍不改代码纯复跑」已是方向性信号，实打实计数。
 *
 * effective = raw − min(编辑间隔数, 1) − min(取证间隔数, 1)：
 *   RED→edit→RED             = 1（TDD，不触发 P7）
 *   RED→read→RED             = 1（诊断复现，不触发——H1 修复）
 *   RED→RED（纯重跑）          = 2（真死循环，触发）
 *   RED→edit→RED→edit→RED    = 2（改两次还红，触发）
 *   RED→read→RED→read→RED    = 2（读两轮仍不改代码，触发）
 *   RED→edit→RED→read→RED    = 1（TDD+诊断，活跃工作，不触发）
 *
 * 历史备注：旧实现「编辑不打断」是 2026-07-04 触发面修复的有意设计（抓验证
 * 轮次膨胀），对 TDD RED→edit→RED 误报——2026-07-23 改为编辑封顶稀释
 * （.rivet/plans/verifyfailstreak-*.md 瑶光复核版）；同日信号互扰治理 A1
 * 补上取证间隔稀释（docs/superpowers/specs/2026-07-23-cvm-signal-interference-design.md H1）。
 */
export function computeVerifyFailStreak(history: ReadonlyArray<HistoryEntry>): number {
  let raw = 0
  let editGaps = 0
  let probeGaps = 0
  let pendingEdit = false
  let pendingProbe = false
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i]!
    if (EDIT_TOOLS.has(h.tool)) { pendingEdit = true; continue }
    if (!VERIFY_TOOLS.has(h.tool)) { pendingProbe = true; continue }
    if (h.status === 'failed') {
      // environment/timeout 是环境问题，不是语义失败，不计入
      if (h.errorClass === 'environment' || h.errorClass === 'timeout') continue
      // pending* = 本次失败与更靠队尾的已计入失败之间夹过编辑/只读取证
      if (raw > 0 && pendingEdit) editGaps++
      else if (raw > 0 && pendingProbe) probeGaps++
      pendingEdit = false
      pendingProbe = false
      raw++
      continue
    }
    if (h.status === 'success') break
  }
  return Math.max(0, raw - Math.min(editGaps, 1) - Math.min(probeGaps, 1))
}

/**
 * Rule evaluation order matters: first match wins.
 * P7 first — verification-failure inflation is the sharpest signal (objective
 * failure streak) and directly targets the "排查轮次膨胀" failure mode.
 * P3 before P1 — dual-deficit (verif + vigor both low → 天权 "switch direction")
 * precedes single-deficit (verif low only → 瑶光 "go verify").
 * P6 last — investigation-stall is the broadest (read-only) net.
 *
 * Removed (2026-06-18): P2 (freshness→天璇, causal chain too weak),
 * P4 (complexity→天权, no causal link), P6-stability (stability→天府, overlaps kick-hook).
 * Added (2026-07-04 触发面修复): P7 (verify-fail streak→天权), P6 (investigation
 * stall→天璇) — 补上 verificationCoverage 在零改动时恒 1.0 的排查场景盲区。
 */
const RULES: RouteRule[] = [
  {
    id: 'P7',
    star: '天权',
    match: s => s.verifyFailStreak >= 2,
    busPriority: 0.65,
    poolKeyFilter: new Set(['Q3', 'X3']),
    promptTemplate: '【天权】验证有效连败 {verify_fail_streak} 次（TDD 编辑/诊断取证间隔已各豁免一次）。停止同方向变体重试——换维度（不同证据路径/更小复现）或先用探针确认前提。瑶光胶囊有 RED→GREEN 方法论可 recall。',
    // 最后一个工具就是失败的测试 — 这正是要提醒的时刻，不做测试意图让位
    recallStar: '瑶光',
    // 核销：换维度后仍应回到验证——2 轮内出现验证尝试即采纳
    expect: { kind: 'verify_attempted', withinTurns: 2 },
  },
  {
    id: 'P3',
    star: '天权',
    match: s => s.verificationCoverage < 0.3 && s.vigor < 0.3 && s.turn > 3,
    busPriority: 0.65,
    poolKeyFilter: new Set(['Q3', 'X3']),
    promptTemplate: '【天权】检查点：改了 {files_modified} 个文件未验证，且执行能量在下降。如果同一方向第三次撞墙，换维度。',
    suppressOnTestIntent: true,
    expect: { kind: 'verify_attempted', withinTurns: 2 },
  },
  {
    id: 'P1',
    star: '瑶光',
    match: s => s.verificationCoverage < 0.3 && s.turn > 3,
    busPriority: 0.55,
    poolKeyFilter: new Set(['Y1', 'Y2', 'Y5']),
    promptTemplate: '【瑶光】改了 {files_modified} 个文件但还没验证（距上次验证 {turns_since_verify} 轮）。如实披露未验证；独立验证时机由用户决定，不阻止安全提交或收尾。',
    suppressOnTestIntent: true,
    expect: { kind: 'verify_attempted', withinTurns: 2 },
    corroborates: ['self-verify', 'typecheck-reminder'],
  },
  {
    id: 'P5',
    star: '瑶光',
    match: s => s.filesModified > 5 && s.verificationCoverage < 0.5,
    busPriority: 0.55,
    poolKeyFilter: new Set(['Y3', 'Y6']),
    promptTemplate: '大面积改动（{files_modified} 文件，验证覆盖 {verification_coverage}）。如实披露未验证范围，由用户决定独立审查或扩大验证；不要因此自动增加测试或阻止安全提交。',
    suppressOnTestIntent: true,
    expect: { kind: 'verify_attempted', withinTurns: 2 },
  },
  {
    id: 'P6',
    star: '天璇',
    // A1 阈值分级（2026-07-23 信号互扰治理 M2）：诊断态（窗口几乎全只读 =
    // 用户就是让排查）正常取证批次会轻松打到 streak 6——阈值抬到 10；
    // build 态（窗口内有产出工具，干着干着卡进读循环）保持 6，这才是真停滞。
    // S2 可达性修复（2026-10-02）：streak 现在取 recorder 侧独立累计值——
    // 5 条窗口上限装不下这两个阈值，此前本规则的 match 恒 false（死规则）。
    // 线上可达路径是诊断态 10（≥10 连只读 ⇒ 末尾 5 条全只读 ⇒ 仍是诊断态）。
    match: s => s.turn > 5 && s.momentum < 0.35 && s.filesModified === 0
      && s.readOnlyStreak >= (s.activityMode === 'diagnostic' ? 10 : 6),
    busPriority: 0.55,
    poolKeyFilter: new Set(['X1', 'X3', 'X4']),
    promptTemplate: '【天璇】排查已连续 {readonly_streak} 次只读且预测动量偏低——当前证据维度可能挖穿了。换一层抽象或换一个证据路径（日志/git 历史/小复现），天璇胶囊有跨域换视角方法论可 recall。',
    // 只读排查中读到 test 文件是常态，不做测试意图让位
    // 无 expect："换证据维度"没有单一行为签名（换目录 glob / git log / 写复现
    // 都算采纳），谓词会系统性误判——只计送达（P1a 谓词映射表的显式豁免项）。
  },
]

// ─── Cooldown & Escalation Tracking ─────────────────────────────

interface CooldownState {
  lastTriggeredTurn: number
  lastTriggeredValue: number
  lastEscalationOverrideTurn: number
}

const ESCALATION_OVERRIDE_MIN_INTERVAL = 2

// ─── Template Rendering ─────────────────────────────────────────

function fillTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const val = vars[key]
    return val !== undefined ? String(val) : match
  })
}

// ─── Principle Selection ─────────────────────────────────────────

function selectPrinciple(pool: Principle[], lastUsedKeys: Set<string>): Principle {
  const unused = pool.filter(p => !lastUsedKeys.has(p.key))
  const candidates = unused.length > 0 ? unused : pool
  return candidates[Math.floor(Math.random() * candidates.length)]!
}

/**
 * P3 vigor tonic/phasic split: choose principle based on sub-field values.
 * - tonic < 0.3 (chronic low energy) → Q3 "switch direction" (天权)
 * - phasic < -0.3 (just failed unexpectedly) → X3 "adversarial scout" (天璇)
 * Cross-star principle selection — P3 is semantically a "dual deficit" rule
 * that can route to either 天权 or 天璇 principles depending on vigor profile.
 */
const P3_PHASIC_OVERRIDE: Principle = { key: 'X3', actionPrompt: '用一个不匹配现有方案的输入跑一次测试，看它会不会红' }

function selectP3Principle(pool: Principle[], state: RouteState, lastUsedKeys: Set<string>, getPoolFn?: (star: StarDomain) => { pool: Principle[] }): Principle {
  if (state.vigorTonic < 0.3) {
    const q3 = pool.find(p => p.key === 'Q3')
    if (q3) return q3
  }
  if (state.vigorPhasic < -0.3) {
    // Cross-star: try dynamic 天璇 pool first, then fallback constant
    if (getPoolFn) {
      const tianxuanPool = getPoolFn('天璇').pool
      const x3 = tianxuanPool.find(p => p.key === 'X3')
      if (x3) return x3
    }
    return P3_PHASIC_OVERRIDE
  }
  return selectPrinciple(pool, lastUsedKeys)
}

// ─── Test Intent Detection ──────────────────────────────────────

const TEST_TOOLS = new Set(['run_tests'])

/**
 * 触发面修复（2026-07-04）：删除 EDIT_TOOLS 分支。
 * 旧逻辑把任意编辑工具都视作"测试意图"压制——恰好在验证覆盖率最低的
 * 实现中期（上一个工具几乎总是 edit）把 P1/P3/P5 大面积静音。
 * 编辑不是验证意图；真正该让位的只有"正在跑测试/正在操作测试文件"。
 */
function isTestIntent(lastTool: string, lastToolTarget: string): boolean {
  if (TEST_TOOLS.has(lastTool)) return true
  if (lastToolTarget.includes('test')) return true
  return false
}

// ─── Telemetry ──────────────────────────────────────────────────

export interface CcrTriggerEvent {
  rule: string
  star: StarDomain
  turn: number
  principleKey: string
  dimValues: Record<string, number>
  dynamicPool: boolean
}

// ─── Main Hook ──────────────────────────────────────────────────

export interface CcrHookOptions {
  advisoryBus: AdvisoryBusLike
  wasConvergenceTriggered: () => boolean
  getEvidenceState: () => EvidenceState
  /** cwd for loading capsule docs. When absent, dynamic pools are disabled. */
  cwd?: string
  /** Telemetry callback — called on each trigger for offline analysis. */
  onTrigger?: (event: CcrTriggerEvent) => void
}

export function createCcrHook(opts: CcrHookOptions): PreTurnRuntimeHook {
  const cooldowns = new Map<StarDomain, CooldownState>()
  const lastUsedPrinciples = new Map<StarDomain, Set<string>>()
  let lastVerifyTurn = 0

  // Dynamic principle pool cache (loaded once per star on first trigger)
  const dynamicPools = new Map<StarDomain, Principle[] | null>()

  function getPool(star: StarDomain, keyFilter?: Set<string>): { pool: Principle[]; dynamic: boolean } {
    if (opts.cwd) {
      if (!dynamicPools.has(star)) {
        const extracted = extractPrinciples(opts.cwd, star)
        dynamicPools.set(star, extracted ? toPrinciples(extracted) : null)
      }
      const dynamic = dynamicPools.get(star)
      if (dynamic && dynamic.length > 0) {
        const filtered = keyFilter ? dynamic.filter(p => keyFilter.has(p.key)) : dynamic
        if (filtered.length > 0) return { pool: filtered, dynamic: true }
        return { pool: dynamic, dynamic: true }
      }
    }
    // Fallback to hardcoded
    const fallback = STAR_FALLBACK_POOLS[star]
    const filtered = keyFilter ? fallback.filter(p => keyFilter.has(p.key)) : fallback
    return { pool: filtered.length > 0 ? filtered : fallback, dynamic: false }
  }

  function getCooldown(star: StarDomain): CooldownState {
    let c = cooldowns.get(star)
    if (!c) {
      c = { lastTriggeredTurn: -Infinity, lastTriggeredValue: 0, lastEscalationOverrideTurn: -Infinity }
      cooldowns.set(star, c)
    }
    return c
  }

  function getLastUsed(star: StarDomain): Set<string> {
    let s = lastUsedPrinciples.get(star)
    if (!s) {
      s = new Set()
      lastUsedPrinciples.set(star, s)
    }
    return s
  }

  function extractRouteState(
    sensorium: Sensorium,
    vigor: VigorState | null,
    evidence: EvidenceState,
    turn: number,
    recentToolHistory: ReadonlyArray<HistoryEntry>,
    readOnly: ReadOnlyStreakFact,
  ): RouteState {
    const last = recentToolHistory.length > 0
      ? recentToolHistory[recentToolHistory.length - 1]!
      : { tool: '', target: '' }
    return {
      turn,
      verificationCoverage: sensorium.confidence ?? 1.0,
      filesModified: evidence.filesModified.size,
      vigor: vigor?.vigor ?? 1.0,
      vigorTonic: vigor?.tonic ?? 1.0,
      vigorPhasic: vigor?.phasic ?? 0.0,
      lastTool: last.tool,
      lastToolTarget: last.target,
      // P1b：momentum 无预测样本时是 0 回退（quality='no-data'），会让 P6 的
      // "momentum < 0.35" 把无数据误判为停滞——回退到 1.0（中性偏乐观）。
      momentum: sensorium.quality?.momentum === 'no-data' ? 1.0 : (sensorium.momentum ?? 1.0),
      readOnlyStreak: readOnly.value,
      readOnlyStreakSource: readOnly.source,
      verifyFailStreak: computeVerifyFailStreak(recentToolHistory),
      activityMode: classifyActivityMode(recentToolHistory, evidence.filesModified.size),
    }
  }

  return {
    phase: 'preTurn',
    name: 'cognitive-capsule-router',
    run(ctx) {
      if (opts.wasConvergenceTriggered()) return

      const { sensorium, vigor, turn, recentToolHistory } = ctx.snapshot
      if (!sensorium) return

      const evidence = opts.getEvidenceState()

      if (evidence.deliveryStatus === 'verified') {
        lastVerifyTurn = turn
      }

      const state = extractRouteState(sensorium, vigor, evidence, turn, recentToolHistory, resolveReadOnlyStreak(ctx.snapshot))

      for (const rule of RULES) {
        if (!rule.match(state)) continue
        if (rule.suppressOnTestIntent && isTestIntent(state.lastTool, state.lastToolTarget)) continue

        const cooldownTurns = rule.star === '天权' ? 4 : 5
        const cd = getCooldown(rule.star)
        const turnsElapsed = turn - cd.lastTriggeredTurn

        if (turnsElapsed < cooldownTurns) {
          const currentDimValue = getDominantDimValue(rule, state)
          const degradedEnough = currentDimValue < cd.lastTriggeredValue * 0.5
          const escalationCooldownOk = (turn - cd.lastEscalationOverrideTurn) >= ESCALATION_OVERRIDE_MIN_INTERVAL
          if (!degradedEnough || !escalationCooldownOk) continue
          cd.lastEscalationOverrideTurn = turn
        }

        // Resolve principle pool (dynamic from capsule docs → fallback to hardcoded)
        const { pool, dynamic: dynamicPool } = getPool(rule.star, rule.poolKeyFilter)

        // P3 uses tonic/phasic split for principle selection (may cross-star to 天璇)
        const lastUsed = getLastUsed(rule.star)
        const principle = rule.id === 'P3'
          ? selectP3Principle(pool, state, lastUsed, (s) => getPool(s))
          : selectPrinciple(pool, lastUsed)

        lastUsed.add(principle.key)
        if (lastUsed.size >= pool.length) lastUsed.clear()

        const turnsSinceVerify = turn - lastVerifyTurn
        const situationText = fillTemplate(rule.promptTemplate, {
          files_modified: state.filesModified,
          turn: state.turn,
          turns_since_verify: turnsSinceVerify,
          last_tool: state.lastTool || '(none)',
          verification_coverage: (state.verificationCoverage * 100).toFixed(0) + '%',
          readonly_streak: state.readOnlyStreak,
          verify_fail_streak: state.verifyFailStreak,
        })
        // 触发面修复（2026-07-04）：把选中的原则真正带给模型。此前 principle
        // 只进遥测不进 content——动态原则池（胶囊经验）选了却没送达。
        const passiveQuality = rule.id === 'P1' || rule.id === 'P3' || rule.id === 'P5'
        const content = passiveQuality ? situationText : `${situationText} 行动指引：${principle.actionPrompt}`

        opts.advisoryBus.submit({
          key: `ccr-${rule.star}-${rule.id}`,
          priority: rule.busPriority,
          // star_domain：独立类别，不与 discipline 争 MAX_PER_CATEGORY 预算
          category: 'star_domain',
          tier: passiveQuality ? 'informational' : undefined,
          content,
          ttl: 1,
          expect: passiveQuality ? undefined : rule.expect,
          corroborates: passiveQuality ? undefined : rule.corroborates,
        })

        // 胶囊经验召回 — CCR 触发的一等附属：同轮追加一条 informational 条目
        // （填空位，不占 operational Top-N），指向对应星域胶囊的 gist 与 recall 入口。
        const recallStar = rule.recallStar ?? rule.star
        const capsule = opts.cwd ? getCapsuleByStar(opts.cwd, recallStar) : undefined
        if (capsule) {
          opts.advisoryBus.submit({
            key: 'capsule-recall',
            priority: 0.45,
            category: 'star_domain',
            tier: 'informational',
            content: `【${recallStar}·胶囊】${capsule.gist ?? '方法论已封存'}——需要完整方法论时调用 recall_capsule("${recallStar}")。`,
            ttl: 1,
          })
        }

        // Telemetry
        opts.onTrigger?.({
          rule: rule.id,
          star: rule.star,
          turn,
          principleKey: principle.key,
          dimValues: {
            verificationCoverage: state.verificationCoverage,
            vigor: state.vigor,
            vigorTonic: state.vigorTonic,
            vigorPhasic: state.vigorPhasic,
            momentum: state.momentum,
            readOnlyStreak: state.readOnlyStreak,
            verifyFailStreak: state.verifyFailStreak,
            // Wave C 共现标定：诊断态=1（dimValues 只收 number）
            activityModeDiagnostic: state.activityMode === 'diagnostic' ? 1 : 0,
            // S2 接线取证：1 = 只读连胜来自 recorder 累计事实；0 = 事实缺席、
            // 回退到 5 条窗口派生值（P6 因此不可达）。接线断裂不再静默。
            readOnlyStreakCumulative: state.readOnlyStreakSource === 'cumulative' ? 1 : 0,
          },
          dynamicPool,
        })

        cd.lastTriggeredTurn = turn
        cd.lastTriggeredValue = getDominantDimValue(rule, state)

        return
      }
    },
  }
}

function getDominantDimValue(rule: RouteRule, state: RouteState): number {
  // 主导维度值用于冷却期内的恶化升级判断（value 减半 → 提前发射）。
  switch (rule.id) {
    case 'P6':
      return state.momentum
    case 'P7':
      // 失败流水越长值越小 — streak 2→0.33, 4→0.2（翻倍恶化触发升级）
      return 1 / (1 + state.verifyFailStreak)
    default:
      // P1, P3, P5 use verificationCoverage as the primary signal
      return state.verificationCoverage
  }
}

// ═══════════════════════════════════════════════════════════════════
// CVM-vector 干预路由（v3.1 计划 Wave 1-3）— render 前纯 evaluator
// ═══════════════════════════════════════════════════════════════════
//
// 与上方 preTurn CCR（RULES）的关系：同一模块的第二个发射点，在
// turn-step-producer 的 AdvisoryBus render 前评估——此时本轮 perception/
// convergence/pressure/obligation 与各 preTurn hook 的 pending advisory
// 都已就绪。约束（计划 v3.1）：
//   - 唯一发声入口：不新建平行 router/bus；候选是现有 AdvisoryEntry，
//     经既有 AdvisoryBus 送达（active 模式），复用 readback/习惯化/efficacy
//     负反馈环（熔断 + probation 语义已由 bus 实现，不重建）。
//   - 让位矩阵：high-risk obligation gate > 已在场的专用 hook 声音（pending
//     key）> CVM-vector 候选；同轮同星域只允许一条（老 CCR pending 的
//     `ccr-<star>-*` 视为已有声音）。
//   - 辅域聚焦契约：一个缺口、一个动作、一个可核销 expect、一个停止条件；
//     没有单一行为签名的规则不得 activeEligible。
//   - off/shadow/active 闸门：shadow 只产出 decision（telemetry），绝不
//     submit——由调用方（turn-step-producer）执行该纪律，evaluator 本身
//     无副作用。
//   - 事实源唯一：convergence 只读消费 ConvergenceResult.signals 的真实
//     字段（textRepetitionPenalty/oscillationPenalty，缺数据时为 1.0 =
//     中性，不会假阳性）；不自建停滞计数。

import type { ObligationStore } from '../evidence-obligation.js'
import { isIndependentVerification } from '../evidence-obligation.js'
import type { CaseOpenSignal } from '../case-open-signals.js'
import { classifyFailureSignal, renderRouteAnnotation } from '../failure-taxonomy.js'

export type CvmVectorMode = 'off' | 'shadow' | 'active'

/** RIVET_CVM_VECTOR 闸门解析：'0'/'off' 关闭，'active' 开放主动送达，缺省 shadow。 */
export function cvmVectorMode(env: NodeJS.ProcessEnv = process.env): CvmVectorMode {
  const raw = env.RIVET_CVM_VECTOR
  if (raw === 'off' || raw === '0') return 'off'
  if (raw === 'active') return 'active'
  return 'shadow'
}

/** 困难分类（确定性，带触发字段；不输出无解释的 0-1 分数）。 */
export type CvmDifficultyKind =
  | 'gate-blocked'
  | 'context-pressure'
  | 'perspective-locked'
  | 'verification-debt'
  | 'attack-stalled'

export interface CvmVectorInput {
  turn: number
  /** perception 传入 ConvergenceInput 的 phaseClass；'' = 尚未有 convergence 检查。 */
  phaseClass: string
  /** ConvergenceResult 只读快照；null = 本会话尚未跑过 convergence 检查。
   *  signals 缺数据时 detector 返回 1.0（中性）——低值才是真实重复信号。 */
  convergence: {
    score: number
    level: number
    textRepetitionPenalty: number
    oscillationPenalty: number
  } | null
  pressure: {
    ratio: number
    cvmOverheadRatio: number
    thrashing: boolean
    shouldThrottleCvm: boolean
    hardCeiling: boolean
  }
  obligations: ObligationStore
  evidence: {
    filesModified: number
    deliveryStatus: string
  }
  /** render 前的 AdvisoryBus.peekPendingKeys() 只读快照。 */
  pendingAdvisoryKeys: readonly string[]
  /** loop.wasConvergenceEmittedRecently()——convergence 真实发射过的相邻轮让位。 */
  convergenceEmittedRecently: boolean
  /** anchor-break-scout 本 session 已派发（opt-in，默认恒 false）。 */
  scoutOwned: boolean
  /** 上一轮 ControlPlane frame 是否有 decision-gate（worker/ownership 等）。 */
  hasDecisionGates: boolean
  /** PAL 攻坚层快照（ProblemAttackStore.snapshotForCvm）。null = 无存活案件。 */
  attack?: { activeCases: number; anyNeedsUser: boolean; anyStalled: boolean; hasPlannedProbes?: boolean } | null
  /** PAL 层是否启用（RIVET_PAL !== 'off'）——CV3-open 的前置条件。 */
  attackLayerEnabled?: boolean
  /** 开案信号聚合（collectCaseOpenSignals 纯输出）——带稳定锚的"卡住形状"
   *  事实。第四波 W1：CV3-open 触发面从「仅深度重复」扩展为
   *  「convergence 门 ∧（重复 ∨ 带锚信号）」。缺省视为空。 */
  caseOpenSignals?: readonly CaseOpenSignal[]
}

export interface CvmVectorDecision {
  /** 确定性分类 + 触发字段（回放/反证用）。null = 无分类命中。 */
  classification: {
    kind: CvmDifficultyKind
    ruleId?: string
    facts: Record<string, number | string | boolean>
  } | null
  /** 主动候选（active 模式由调用方 submit；shadow 只落 telemetry）。 */
  candidate: { ruleId: string; star: string; entry: AdvisoryEntry } | null
  /** 让位记录：规则匹配但被单一声音仲裁静默。 */
  yielded: { ruleId: string; to: string } | null
}

const EMPTY_DECISION: CvmVectorDecision = { classification: null, candidate: null, yielded: null }

/** 同规则冷却（轮）——与 bus 侧习惯化/efficacy 环叠加，evaluator 侧先挡一层。 */
export const CVM_VECTOR_RULE_COOLDOWN_TURNS = 6

/** CV2 视角锁定触发阈值（Wave 0 标注校准前仅 shadow 运行，初值为工程判断）。
 *  detector 缺数据时 penalty 为 1.0（中性），低于阈值必然是真实重复信号。 */
export const CVM_REPETITION_THRESHOLD = 0.4

/** 让位 key 清单：这些声音在场时对应规则静默（专用 hook 拥有执行责任）。 */
const PERSPECTIVE_YIELD_KEYS = [
  'convergence',
  'convergence-gate',
  'dissipative-kick',
  'reasoning-spiral',
  'dead-end-file',
  'regression-bisect',
  'capsule-recall',
] as const

/**
 * 检查 pending keys 中是否有专用声源的让位信号。
 *
 * 扩展了 PERSPECTIVE_YIELD_KEYS 的匹配：基础表用精确 includes，
 * edit-failure-recovery（带动态文件路径后缀）用前缀匹配。
 * 让位 ≠ 丢失——edit-failure 信号仍在 caseOpenSignals 中，
 * CV3-open 在后续轮次无专用声源时可正常开火（升级阶梯不断裂）。
 */
function hasPendingSpecialKey(pendingKeys: readonly string[]): string | undefined {
  const exact = PERSPECTIVE_YIELD_KEYS.find(k => pendingKeys.includes(k))
  if (exact) return exact
  if (pendingKeys.some(k => k.startsWith('edit-failure-recovery:'))) return 'edit-failure-recovery'
  return undefined
}
const VERIFY_YIELD_KEYS = [
  'self-verify',
  'self-verify-scope-mismatch',
  'typecheck-reminder',
] as const

/** 同星去重：老 CCR 本轮 pending 的 `ccr-<star>-*` 视为该星域已有声音。 */
function sameStarCcrPending(pendingKeys: readonly string[], star: string): string | null {
  return pendingKeys.find(k => k.startsWith(`ccr-${star}-`)) ?? null
}

/** high-risk obligation gate 判定——与 signalsFromObligations 的 decision-gate
 *  语义同构（high + open/attempted → requiresDecision）。直接读 store 事实，
 *  不经 ControlPlane frame（frame 是上一轮归并结果，义务事实要用当前值）。 */
function hasHighRiskObligationGate(store: ObligationStore): boolean {
  return store.obligations.some(o =>
    o.risk === 'high' && !isIndependentVerification(o.family) && (o.state === 'open' || o.state === 'attempted'))
}

/**
 * CVM-vector evaluator 工厂。session 级冷却状态内聚（与 CCR 的 per-star
 * cooldown 同构）；除冷却推进外无状态、无 IO、无 Date.now()、无随机——
 * 相同输入序列产生相同 decision 序列。
 */
export function createCvmVectorEvaluator(): { evaluate(input: CvmVectorInput): CvmVectorDecision } {
  const lastFiredTurn = new Map<string, number>()
  // W1 二次送达（two-challenge 的降级实现，不自建 tier 升级状态机）：
  // 记录 CV3-open 已发过的锚。同锚信号持续到第二发（冷却已过 = 至少 6 轮
  // 后）说明首发未被采纳——第二发挂 observe 短暂观察，到期由 bus 强制
  // 送达（corroborate 自愈可提前撤销）。bus 没有 "escalate 文案" 机制。
  const openFiredAnchors = new Set<string>()

  function cooled(ruleId: string, turn: number): boolean {
    const last = lastFiredTurn.get(ruleId)
    return last === undefined || turn - last >= CVM_VECTOR_RULE_COOLDOWN_TURNS
  }

  return {
    evaluate(input: CvmVectorInput): CvmVectorDecision {
      // ── 让位矩阵第一层：gate 在场 → 分类记录，永不发声 ──
      if (hasHighRiskObligationGate(input.obligations)) {
        return {
          classification: {
            kind: 'gate-blocked',
            facts: { source: 'obligation-gate', turn: input.turn },
          },
          candidate: null,
          yielded: null,
        }
      }
      if (input.hasDecisionGates) {
        return {
          classification: {
            kind: 'gate-blocked',
            facts: { source: 'control-plane-gate', turn: input.turn },
          },
          candidate: null,
          yielded: null,
        }
      }

      // ── 上下文压力：永久让位 compact/recovery，只记 silent 分类 ──
      if (input.pressure.hardCeiling || input.pressure.shouldThrottleCvm || input.pressure.thrashing) {
        return {
          classification: {
            kind: 'context-pressure',
            facts: {
              ratio: input.pressure.ratio,
              cvmOverheadRatio: input.pressure.cvmOverheadRatio,
              thrashing: input.pressure.thrashing,
              hardCeiling: input.pressure.hardCeiling,
              turn: input.turn,
            },
          },
          candidate: null,
          yielded: null,
        }
      }

      // ── CV3 攻坚层（PAL 计划 v2）→ 天机 ──
      // 案件级信号比通用视角锁定更尖锐：有存活案件时先评案件状态；
      // 无案件但深度空转（level≥2 重复）且 PAL 启用时建议开案。
      // 让位链与 CV2 同构：convergence 发射相邻轮 / scout / 专用 key / 同星 CCR。
      const attack = input.attack ?? null
      const conv0 = input.convergence
      const openSignals = input.caseOpenSignals ?? []
      const cv3Situation: { variant: 'needs-user' | 'stalled' | 'execute-planned' | 'open'; content: string; anchorKey?: string } | null = (() => {
        if (attack) {
          if (attack.anyNeedsUser) {
            return {
              variant: 'needs-user',
              content: '【天机】攻坚案件假设空间已清空或预算耗尽。下一动作：attack_case status 复盘证据链，补充新解释（hypothesize）或带证据向用户求证后 close。本提醒不重复。',
            }
          }
          // P3 修订：anyStalled 语义已收紧为"连续 uninformative 且无 planned
          // 剩余"——真卡死才催换谓词。还有 planned 探针但主控深度空转
          // （level≥2 重复）→ 引导回去执行已计划的判别探针，不催开新方向。
          if (attack.anyStalled) {
            return {
              variant: 'stalled',
              content: '【天机】攻坚案件连续探针不出信息且无备用探针——判别方向可能选错。下一动作：attack_case status 看假设板，换一个能区分存活假设的谓词（不同文件/不同测试/基线对照）。低风险只读探针可 delegate_task 并行验证。本提醒不重复。',
            }
          }
          if (
            attack.hasPlannedProbes === true
            && conv0 !== null
            && conv0.level >= 2
            && (conv0.textRepetitionPenalty <= CVM_REPETITION_THRESHOLD || conv0.oscillationPenalty <= CVM_REPETITION_THRESHOLD)
          ) {
            return {
              variant: 'execute-planned',
              content: '【天机】案件里还有已计划未执行的判别探针，而你在重复无新证据的动作。下一动作：attack_case status 看板上 planned 探针，执行它并用 observe 结算谓词——先收割已计划的区分力，再考虑新方向。本提醒不重复。',
            }
          }
          return null
        }
        // W1：触发面 = convergence 门（L2+）∧（深度重复 ∨ 带锚开案信号）。
        // 信号扩大的是"何时建议"，不降低 convergence 门——没有停滞证据时
        // 即使信号在场也不发声（信号只是形状，停滞才是时机）。
        const repetitionHit0 = conv0 !== null
          && (conv0.textRepetitionPenalty <= CVM_REPETITION_THRESHOLD || conv0.oscillationPenalty <= CVM_REPETITION_THRESHOLD)
        if (
          input.attackLayerEnabled === true
          && conv0 !== null
          && conv0.level >= 2
          && (repetitionHit0 || openSignals.length > 0)
          && input.turn >= 4
        ) {
          const sig = openSignals[0]
          if (sig) {
            const route = classifyFailureSignal(sig)
            const annotation = renderRouteAnnotation(route)
            const initialProbe = route.ladder[0] ?? '读实现'
            const skeleton = JSON.stringify({ anchor: sig.anchor, problem: sig.summary })
            return {
              variant: 'open',
              anchorKey: `${sig.anchor.kind}:${sig.anchor.ref}`,
              content: `【天机】卡住形状已带锚事实（${sig.source}: ${sig.anchor.kind}:${sig.anchor.ref}——${sig.summary}）。这是攻坚案件的形状——直接开案：attack_case open ${skeleton}（problem 可改写为你的一句话问题），提出 ≥2 条竞争假设，用判别探针淘汰。有效探针/排除/复现都会计分。${annotation} 初始探针建议：${initialProbe}。本提醒不重复。`,
            }
          }
          return {
            variant: 'open',
            content: '【天机】深度空转：多轮重复未产生新证据。这是攻坚案件的形状——用 attack_case open 绑定锚事实（失败签名/义务/用户原话），提出 ≥2 条竞争假设，用判别探针淘汰。有效探针/排除/复现都会计分。本提醒不重复。',
          }
        }
        return null
      })()
      if (cv3Situation) {
        const facts: Record<string, number | string | boolean> = {
          variant: cv3Situation.variant,
          activeCases: attack?.activeCases ?? 0,
          hasPlannedProbes: attack?.hasPlannedProbes ?? false,
          caseOpenSignals: openSignals.length,
          turn: input.turn,
        }
        if (openSignals[0]) facts.firstSignalSource = openSignals[0].source
        if (input.convergenceEmittedRecently) {
          return { classification: { kind: 'attack-stalled', ruleId: 'CV3', facts }, candidate: null, yielded: { ruleId: 'CV3', to: 'convergence-emit' } }
        }
        if (input.scoutOwned) {
          return { classification: { kind: 'attack-stalled', ruleId: 'CV3', facts }, candidate: null, yielded: { ruleId: 'CV3', to: 'anchor-break-scout' } }
        }
        const pendingSpecial = hasPendingSpecialKey(input.pendingAdvisoryKeys)
        if (pendingSpecial) {
          return { classification: { kind: 'attack-stalled', ruleId: 'CV3', facts }, candidate: null, yielded: { ruleId: 'CV3', to: pendingSpecial } }
        }
        const sameStar = sameStarCcrPending(input.pendingAdvisoryKeys, '天机')
        if (sameStar) {
          return { classification: { kind: 'attack-stalled', ruleId: 'CV3', facts }, candidate: null, yielded: { ruleId: 'CV3', to: sameStar } }
        }
        if (!cooled('CV3', input.turn)) {
          return { classification: { kind: 'attack-stalled', ruleId: 'CV3', facts }, candidate: null, yielded: null }
        }
        lastFiredTurn.set('CV3', input.turn)
        // W1 二次送达：同锚信号跨过冷却仍在场（首发未被采纳）→ 第二发挂
        // observe 短暂观察，到期由 bus 强制送达；首发保持即时投递。
        const anchorKey = cv3Situation.anchorKey
        const isSecondChallenge = anchorKey !== undefined && openFiredAnchors.has(anchorKey)
        if (anchorKey !== undefined) openFiredAnchors.add(anchorKey)
        if (isSecondChallenge) facts.secondChallenge = true
        return {
          classification: { kind: 'attack-stalled', ruleId: 'CV3', facts },
          candidate: {
            ruleId: cv3Situation.variant === 'open' ? 'CV3-open' : 'CV3',
            star: '天机',
            entry: {
              key: 'cvm-vector-天机-CV3',
              priority: 0.5,
              category: 'star_domain',
              content: cv3Situation.content,
              ttl: 1,
              expect: { kind: 'tool_appears', tools: ['attack_case'], withinTurns: 3 },
              ...(isSecondChallenge ? { observe: { turns: 2 } } : {}),
            },
          },
          yielded: null,
        }
      }

      // ── CV2 视角锁定 → 天璇（stuck 信号比验证债更尖锐，先评）──
      const conv = input.convergence
      if (conv !== null) {
        const repetitionHit = conv.textRepetitionPenalty <= CVM_REPETITION_THRESHOLD
          || conv.oscillationPenalty <= CVM_REPETITION_THRESHOLD
        if (repetitionHit && conv.level >= 1) {
          const facts: Record<string, number | string | boolean> = {
            textRepetitionPenalty: conv.textRepetitionPenalty,
            oscillationPenalty: conv.oscillationPenalty,
            convergenceLevel: conv.level,
            phaseClass: input.phaseClass,
            turn: input.turn,
          }
          if (input.convergenceEmittedRecently) {
            return {
              classification: { kind: 'perspective-locked', ruleId: 'CV2', facts },
              candidate: null,
              yielded: { ruleId: 'CV2', to: 'convergence-emit' },
            }
          }
          if (input.scoutOwned) {
            return {
              classification: { kind: 'perspective-locked', ruleId: 'CV2', facts },
              candidate: null,
              yielded: { ruleId: 'CV2', to: 'anchor-break-scout' },
            }
          }
          const pendingSpecial = hasPendingSpecialKey(input.pendingAdvisoryKeys)
          if (pendingSpecial) {
            return {
              classification: { kind: 'perspective-locked', ruleId: 'CV2', facts },
              candidate: null,
              yielded: { ruleId: 'CV2', to: pendingSpecial },
            }
          }
          const sameStar = sameStarCcrPending(input.pendingAdvisoryKeys, '天璇')
          if (sameStar) {
            return {
              classification: { kind: 'perspective-locked', ruleId: 'CV2', facts },
              candidate: null,
              yielded: { ruleId: 'CV2', to: sameStar },
            }
          }
          if (!cooled('CV2', input.turn)) {
            return { classification: { kind: 'perspective-locked', ruleId: 'CV2', facts }, candidate: null, yielded: null }
          }
          lastFiredTurn.set('CV2', input.turn)
          return {
            classification: { kind: 'perspective-locked', ruleId: 'CV2', facts },
            candidate: {
              ruleId: 'CV2',
              star: '天璇',
              entry: {
                key: 'cvm-vector-天璇-CV2',
                priority: 0.5,
                category: 'star_domain',
                content: '【天璇】证据缺口：近几轮输出/工具模式重复，未产生新证据。下一动作：调用 recall_capsule("天璇") 换视角，或写一个最小反证输入。3 轮内见到动作即停，本提醒不重复。',
                ttl: 1,
                expect: { kind: 'tool_appears', tools: ['recall_capsule'], targetIncludes: '天璇', withinTurns: 3 },
              },
            },
            yielded: null,
          }
        }
      }

      // ── CV1 验证债 → 瑶光 ──
      if (
        input.turn >= 2
        && input.evidence.filesModified > 0
        && input.evidence.deliveryStatus !== 'verified'
      ) {
        const facts: Record<string, number | string | boolean> = {
          filesModified: input.evidence.filesModified,
          deliveryStatus: input.evidence.deliveryStatus,
          turn: input.turn,
        }
        const pendingVerify = VERIFY_YIELD_KEYS.find(k => input.pendingAdvisoryKeys.includes(k))
        if (pendingVerify) {
          return {
            classification: { kind: 'verification-debt', ruleId: 'CV1', facts },
            candidate: null,
            yielded: { ruleId: 'CV1', to: pendingVerify },
          }
        }
        const sameStar = sameStarCcrPending(input.pendingAdvisoryKeys, '瑶光')
          ?? sameStarCcrPending(input.pendingAdvisoryKeys, '天权')
        if (sameStar) {
          return {
            classification: { kind: 'verification-debt', ruleId: 'CV1', facts },
            candidate: null,
            yielded: { ruleId: 'CV1', to: sameStar },
          }
        }
        if (!cooled('CV1', input.turn)) {
          return { classification: { kind: 'verification-debt', ruleId: 'CV1', facts }, candidate: null, yielded: null }
        }
        lastFiredTurn.set('CV1', input.turn)
        return {
          classification: { kind: 'verification-debt', ruleId: 'CV1', facts },
          candidate: {
            ruleId: 'CV1',
            star: '瑶光',
            entry: {
              key: 'cvm-vector-瑶光-CV1',
              priority: 0.5,
              category: 'star_domain',
              tier: 'informational',
              content: '已有代码改动尚未验证，请如实披露；单独审查和扩大验证由用户选择，不追加全量测试或阻止安全提交。',
              ttl: 1,
            },
          },
          yielded: null,
        }
      }

      return EMPTY_DECISION
    },
  }
}

// ─── Exports for testing ─────────────────────────────────────────

export { RULES as _RULES_FOR_TESTING }
export { fillTemplate as _fillTemplate }
export { isTestIntent as _isTestIntent }
export type { StarDomain as _StarDomain }
export { STAR_FALLBACK_POOLS as _STAR_FALLBACK_POOLS }
