/**
 * StripImagesAtIntervals —— 缓存友好的请求侧图片修剪（CUBP High #1 对齐）。
 *
 * ## 它解决什么
 *
 * 视觉密集会话（computer_use / browser_debug 截图回灌）里，朴素「只留最近 N 张」
 * （sliding last-N）每轮都会换掉**不同**的旧图 → wire 前缀字节每轮变化 →
 * 前缀缓存每轮 miss、每轮重付全量 cache write。interval 策略改为让 kept-count
 * 从 `minImages` 爬到 `minImages + interval - 1` 再回落：一个窗口（interval 轮）
 * 内，被换成占位符的**最老一批图不变**，前缀逐字节稳定，缓存命中；每 interval
 * 轮只付一次 cache write（回落轮）。
 *
 * 公式对齐 CUBP（computer-use-best-practices `formatters.py`）：
 *
 *     keep = ((total - offset) % interval) + min_images
 *
 * ## 与 CUBP 的实现差异（口径适配，非语义偏差）
 *
 * CUBP 在**同一个**消息列表上原地改写，total 只数得到幸存图；本仓每轮从
 * pristine transcript 重建 wire（copy-on-write 契约，见 `request-invariant.ts`），
 * total 恒计 transcript 全量图。因此 force-prune 后把 offset 置为 **prune 时
 * transcript 图数**（CUBP 置幸存数）：两者在各自口径下等价——下一轮
 * keep 都从 `min + 1` 重新爬升（回归测试「force-prune 后周期重启」钉住）。
 *
 * ## 边界纪律
 *
 * - 纯函数式 `apply`：绝不改写入参，no-op 返回**原数组引用**（与
 *   `stripOaiImageParts` 同款调用方零成本识别惯例）；
 * - 占位符与 413 剥图路径（`STRIPPED_IMAGE_PLACEHOLDER`）**不同**——那条是
 *   「服务端拒图」的持久化语义；这里是「预算修剪」的 wire-only 语义，图仍
 *   在 transcript 里、模型可经 ask_image 复看。
 *
 * @module
 */

import type { OaiMessage, OaiContentPart } from '../api/oai-types.js'
import { debugLog } from '../utils/debug.js'

/** 修剪占位文本。与 413 拒图路径的 STRIPPED_IMAGE_PLACEHOLDER 有意不同：
 *  那边是「图已被拒、别再描述」，这边是「图仍在，只是这轮没随请求发送」——
 *  模型需要知道可以经 ask_image（imageId 由 tool-execution 的 askHint 提供）
 *  把细节问回来，而不是被禁止谈论。 */
export const INTERVAL_PRUNED_IMAGE_PLACEHOLDER =
  '[Image omitted this turn to bound request size — it is not lost. '
  + 'Do not describe it from memory; re-interrogate it with ask_image if you need its details.]'

/** 修剪策略。`interval`（默认，缓存友好）| `simple`（恒留最近 minImages 张，
 *  缓存不友好，仅供对照/调试）| `none`（不修剪）。 */
export type ImagePruningStrategy = 'interval' | 'simple' | 'none'

export interface StripImagesAtIntervalsConfig {
  strategy: ImagePruningStrategy
  /** 窗口起点：kept-count 回落后的下限。≥0。 */
  minImages: number
  /** 窗口长度：kept-count 爬升步数。≥1（%0 是 NaN 陷阱）。 */
  interval: number
  /** 请求序列化超此 MB 数时 force-prune 到 minImages 并重置周期。undefined = 不设。
   *  仅 interval 策略消费（simple 恒留 minImages，无再压空间）。 */
  maxMessageMb?: number
}

export interface StripImagesResult {
  /** 修剪后的消息（no-op 时返回入参原引用）。 */
  messages: OaiMessage[]
  /** 本次被换成占位符的 image part 数。 */
  prunedCount: number
  /** 是否触发了 maxMessageMb force-prune。 */
  forcePruned: boolean
}

function envInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim()
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? Math.floor(n) : fallback
}

/** 从 env 解析配置。未设 → CUBP 同款默认（interval / 3 / 40 / 不设 MB 上限）。
 *  interval 策略下 ≤ min+interval-1（默认 42）张图全保留 → 现有短会话零行为差。
 *  env 键与 `resolveRequestInvariantPolicy` 同款 RIVET_ 前缀惯例。
 *  注意 0 是合法显式值（MIN=0），不得走 `||` falsy 回退。 */
export function resolveStripImagesConfig(env: NodeJS.ProcessEnv = process.env): StripImagesAtIntervalsConfig {
  const raw = env['RIVET_IMAGE_PRUNING']?.trim().toLowerCase()
  const strategy: ImagePruningStrategy = raw === 'none' || raw === 'simple' ? raw : 'interval'
  const minImages = Math.max(0, envInt(env, 'RIVET_IMAGE_PRUNING_MIN', 3))
  const interval = Math.max(1, envInt(env, 'RIVET_IMAGE_PRUNING_INTERVAL', 40))
  const maxMbRaw = env['RIVET_IMAGE_PRUNING_MAX_MB']?.trim()
  const maxMb = maxMbRaw === undefined ? NaN : Number(maxMbRaw)
  return {
    strategy,
    minImages,
    interval,
    ...(Number.isFinite(maxMb) && maxMb > 0 ? { maxMessageMb: maxMb } : {}),
  }
}

function countImages(messages: readonly OaiMessage[]): number {
  let total = 0
  for (const m of messages) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue
    for (const p of m.content) if (p.type === 'image_url') total++
  }
  return total
}

/**
 * 有状态 pruner。状态只有 offset（默认 0，仅 force-prune 置数 / 历史变短钳制）——
 * 这也是 CUBP 的设计：interval 窗口本身无状态（由 total 决定），有状态的只有
 * 「周期被强制重启过」。跨轮保活：挂 AgentLoop 实例（与 imageRegistry 同构）。
 *
 * config 按引用持有（字段可变）：CUBP 测试用 `s.max_message_mb = None` 模拟
 * 「上限只在胖图轮触发」，本仓对齐这一手法。
 */
export class StripImagesAtIntervals {
  private offset = 0

  constructor(readonly config: StripImagesAtIntervalsConfig) {}

  getOffset(): number { return this.offset }

  /** 当前策略下、给定 total（transcript 全量图数）的保留数。纯推导，供测试
   *  对账与遥测。 */
  keepFor(total: number): number {
    if (this.config.strategy === 'simple') return Math.min(total, this.config.minImages)
    if (this.config.strategy === 'none') return total
    const offset = Math.min(this.offset, total)
    return ((total - offset) % this.config.interval) + this.config.minImages
  }

  /**
   * 对 wire 消息应用修剪。copy-on-write：需要修剪时产出新数组与新消息对象，
   * 未受影响的消息保持原对象身份；total ≤ keep 时返回**入参原引用**。
   *
   * 注意：此路径**不**发 onImageStripped——那是 413 服务端拒图的持久化语义
   * （persistStrippedImages 会写回历史）；本修剪是每轮 wire-only 预算动作，
   * transcript 里的图原样保留，下一轮窗口变化时它们可能重新上线。
   */
  apply(messages: OaiMessage[]): StripImagesResult {
    if (this.config.strategy === 'none') return { messages, prunedCount: 0, forcePruned: false }
    const total = countImages(messages)
    // rewind / compact 让历史变短时，offset 不可能大于当前 total——钳掉，
    // 防止 (total - offset) 为负把 % 推成负数。
    if (this.offset > total) this.offset = total

    let result = this.pruneOldest(messages, this.keepFor(total))

    const cap = this.config.strategy === 'interval' ? this.config.maxMessageMb : undefined
    if (cap !== undefined) {
      const mb = JSON.stringify(result.messages).length / 1_000_000
      if (mb > cap) {
        debugLog('strip-images', `serialized request ${mb.toFixed(2)}MB exceeds ${cap}MB cap; `
          + `force-pruning to ${this.config.minImages} image(s) and resetting interval cycle`)
        result = this.pruneOldest(messages, Math.min(total, this.config.minImages))
        // offset = prune 时 transcript 图数（pristine 口径，见模块注释）：下一轮
        // (total+1-offset)%interval = 0 → keep = min+1，周期从窗口起点重启。
        this.offset = total
        return { ...result, forcePruned: true }
      }
    }
    return result
  }

  /** 把最老 total-keep 张图换成占位文本（文档序：先出现的先换）。
   *  copy-on-write；keep ≥ total 时返回原引用。 */
  private pruneOldest(messages: OaiMessage[], keep: number): StripImagesResult {
    const total = countImages(messages)
    if (keep >= total) return { messages, prunedCount: 0, forcePruned: false }
    let budget = total - keep
    let next: OaiMessage[] | undefined
    for (let i = 0; i < messages.length && budget > 0; i++) {
      const msg = messages[i]!
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
      if (!msg.content.some(p => p.type === 'image_url')) continue
      const content: OaiContentPart[] = msg.content.map(p => {
        if (budget <= 0 || p.type !== 'image_url') return p
        budget--
        return { type: 'text' as const, text: INTERVAL_PRUNED_IMAGE_PLACEHOLDER }
      })
      next ??= messages.slice()
      next[i] = { ...msg, content }
    }
    return { messages: next ?? messages, prunedCount: total - keep - budget, forcePruned: false }
  }
}

/** 工厂：对齐 CUBP 构造形态，便于单测与装配方共用同一入口。 */
export function createStripImagesAtIntervals(config: StripImagesAtIntervalsConfig): StripImagesAtIntervals {
  return new StripImagesAtIntervals(config)
}
