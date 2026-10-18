import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { OaiMessage } from '../../api/oai-types.js'
import {
  StripImagesAtIntervals,
  createStripImagesAtIntervals,
  resolveStripImagesConfig,
  INTERVAL_PRUNED_IMAGE_PLACEHOLDER,
} from '../strip-images-at-intervals.js'

/**
 * StripImagesAtIntervals —— CUBP（claude-quickstarts computer-use-best-practices）
 * `formatters.py::StripImagesAtIntervals` 的本仓对齐实现。对齐的是**语义**：
 *
 * 1. kept-count 从 minImages 爬到 minImages+interval-1 再回落（cycle）；
 * 2. 同一 interval 窗口内，history 增长时更早被 omit 的集合不变（prefix-stable）
 *    ——这是前缀缓存友好的核心，sliding last-N 每轮都换一批旧图、每轮全 miss；
 * 3. total ≤ minImages 时 no-op；
 * 4. maxMessageMb 超限 force-prune 到 minImages 且重置周期，之后能继续爬升。
 *
 * 与 CUBP 的实现差异（有意为之，非偏差）：本仓每轮从 pristine transcript 重建
 * wire（copy-on-write 契约，见 request-invariant.ts），不是原地改写消息列表，
 * 因此 total 恒计 transcript 全量图；force-prune 后 offset 置为 prune 时的
 * transcript 图数（CUBP 置为幸存图数——两者在各自口径下等价：下一轮 keep 都从
 * min+1 重新爬升）。
 */

const FAT = 'F'.repeat(2000) // ≈2KB/图，force-prune 测试用

function img(tag: string): string {
  return 'data:image/png;base64,' + tag
}

function msgs(n: number, tagOf: (i: number) => string = i => `img${i}`): OaiMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: 'user' as const,
    content: [
      { type: 'text' as const, text: `turn ${i}` },
      { type: 'image_url' as const, image_url: { url: img(tagOf(i)) } },
    ],
  }))
}

function surviving(messages: OaiMessage[]): string[] {
  const out: string[] = []
  for (const m of messages) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue
    for (const p of m.content) {
      if (p.type === 'image_url') out.push(p.image_url.url.replace('data:image/png;base64,', ''))
    }
  }
  return out
}

describe('StripImagesAtIntervals — kept-count 循环（对齐 CUBP test_interval_kept_count_cycles）', () => {
  it('total 从 1 涨到 11：kept-count 走 1,2,3,3,4,5,6,3,4,5,6', () => {
    const f = createStripImagesAtIntervals({ strategy: 'interval', minImages: 3, interval: 4 })
    const seen: number[] = []
    for (let n = 1; n <= 11; n++) {
      // 每轮从 pristine 重建（本仓 wire 拼装模式），同一 pruner 实例跨轮保活。
      const out = f.apply(msgs(n)).messages
      seen.push(surviving(out).length)
    }
    assert.deepEqual(seen, [1, 2, 3, 3, 4, 5, 6, 3, 4, 5, 6])
  })
})

describe('StripImagesAtIntervals — prefix-stable（对齐 CUBP test_interval_prefix_stable_within_window）', () => {
  it('同一窗口内 9→10 张：先被 omit 的集合不变，wire 前缀逐字节相同', () => {
    const f = createStripImagesAtIntervals({ strategy: 'interval', minImages: 3, interval: 4 })
    const a = f.apply(msgs(9)).messages
    const b = f.apply(msgs(10)).messages
    // 两轮都把最老 5 张换成占位符，保留其余。
    assert.deepEqual(surviving(a), ['img5', 'img6', 'img7', 'img8'])
    assert.deepEqual(surviving(b), ['img5', 'img6', 'img7', 'img8', 'img9'])
    // 前 9 条消息序列化逐字节一致——前缀缓存只付新增尾部。
    assert.equal(JSON.stringify(a), JSON.stringify(b.slice(0, 9)))
  })

  it('跨窗口回落的那一轮才换掉更早的一批图（每 interval 轮一次 cache write）', () => {
    const f = createStripImagesAtIntervals({ strategy: 'interval', minImages: 2, interval: 3 })
    // 窗口内 8→9 之前逐轮增长不动旧占位符集合；9 是回落轮（9%3=0）
    const at8 = surviving(f.apply(msgs(8)).messages)
    const at9 = surviving(f.apply(msgs(9)).messages)
    assert.deepEqual(at8, ['img4', 'img5', 'img6', 'img7'])
    assert.deepEqual(at9, ['img7', 'img8'], '回落轮：kept 集合前移，最老一批重新换血')
  })
})

describe('StripImagesAtIntervals — no-op 边界', () => {
  it('total ≤ minImages：返回原数组引用且内容不变', () => {
    const f = createStripImagesAtIntervals({ strategy: 'interval', minImages: 3, interval: 4 })
    const input = msgs(2)
    const snapshot = JSON.stringify(input)
    const result = f.apply(input)
    assert.equal(result.messages, input, 'no-op 必须返回原引用（调用方零成本识别）')
    assert.equal(JSON.stringify(input), snapshot, '绝不原地改写入参')
    assert.equal(result.prunedCount, 0)
  })

  it('strategy none：恒等原引用', () => {
    const f = createStripImagesAtIntervals({ strategy: 'none', minImages: 3, interval: 4 })
    const input = msgs(50)
    assert.equal(f.apply(input).messages, input)
  })
})

describe('StripImagesAtIntervals — copy-on-write 纪律（request-invariant 契约）', () => {
  it('修剪产出新数组；未受影响的消息保持对象身份；入参不被改写', () => {
    const f = createStripImagesAtIntervals({ strategy: 'interval', minImages: 1, interval: 2 })
    const input = msgs(6)
    const pristine = JSON.stringify(input)
    const out = f.apply(input).messages
    assert.notEqual(out, input)
    assert.equal(JSON.stringify(input), pristine, 'pristine transcript 不被触碰')
    // 保留的尾部消息对象身份不变（共享引用，字节天然一致）
    assert.equal(out[out.length - 1], input[input.length - 1])
    // 被替换的最老消息：image part 变占位文本
    const first = out[0]!
    assert.ok(Array.isArray(first.content))
    assert.deepEqual((first.content as Array<{ type: string; text?: string }>)[1], {
      type: 'text',
      text: INTERVAL_PRUNED_IMAGE_PLACEHOLDER,
    })
  })

  it('同一条消息内多张图只换最老的（部分替换）', () => {
    const f = createStripImagesAtIntervals({ strategy: 'interval', minImages: 1, interval: 1 })
    const input: OaiMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'three images in one message' },
          { type: 'image_url', image_url: { url: img('a') } },
          { type: 'image_url', image_url: { url: img('b') } },
          { type: 'image_url', image_url: { url: img('c') } },
        ],
      },
    ]
    const out = f.apply(input).messages
    assert.deepEqual(surviving(out), ['c'], '最老的 a、b 被换，c 保留')
  })
})

describe('StripImagesAtIntervals — maxMessageMb force-prune（对齐 CUBP test_max_message_mb_force_prunes_and_resets_offset / test_force_prune_then_cycle_resumes）', () => {
  it('超限 force-prune 到 minImages，offset 重置为 prune 时 transcript 图数', () => {
    const f = createStripImagesAtIntervals({ strategy: 'interval', minImages: 2, interval: 10, maxMessageMb: 0.0005 })
    const input = msgs(5, () => FAT)
    const result = f.apply(input)
    assert.ok(result.forcePruned)
    assert.equal(surviving(result.messages).length, 2)
    assert.equal(f.getOffset(), 5, 'offset = prune 时 transcript 图数（pristine 口径）')
  })

  it('force-prune 后周期重启并能继续爬升（min, min+1, min+2 …）', () => {
    // 5 张胖图触发 force-prune；后续轮模拟上限不再触发（CUBP 测试同款手法：
    // 放宽 config.maxMessageMb），验证爬升恢复。
    const f = createStripImagesAtIntervals({ strategy: 'interval', minImages: 2, interval: 10, maxMessageMb: 0.0005 })
    const seed = msgs(5, () => FAT)
    assert.equal(surviving(f.apply(seed).messages).length, 2, 'force-prune 到 2')
    f.config.maxMessageMb = undefined

    // 之后每轮加一张小图，从 pristine 全量重建
    let history = seed
    const seen: number[] = []
    for (let i = 5; i < 12; i++) {
      history = [...history, ...msgs(1, () => `s${i}`)]
      seen.push(surviving(f.apply(history).messages).length)
    }
    assert.deepEqual(seen, [3, 4, 5, 6, 7, 8, 9], 'prune 后必须从 min+1 重新爬升，不得钉死在 min')
  })

  it('未超限时不 force-prune', () => {
    const f = createStripImagesAtIntervals({ strategy: 'interval', minImages: 2, interval: 10, maxMessageMb: 1 })
    const result = f.apply(msgs(5, () => FAT))
    assert.ok(!result.forcePruned)
  })
})

describe('StripImagesAtIntervals — simple 策略（显式选择才用，缓存不友好）', () => {
  it('恒留最近 minImages 张', () => {
    const f = createStripImagesAtIntervals({ strategy: 'simple', minImages: 2, interval: 40 })
    assert.deepEqual(surviving(f.apply(msgs(5)).messages), ['img3', 'img4'])
  })
})

describe('resolveStripImagesConfig — env 解析', () => {
  it('缺省：interval / min 3 / interval 40 / 无 MB 上限（CUBP 同款默认）', () => {
    const cfg = resolveStripImagesConfig({})
    assert.equal(cfg.strategy, 'interval')
    assert.equal(cfg.minImages, 3)
    assert.equal(cfg.interval, 40)
    assert.equal(cfg.maxMessageMb, undefined)
  })

  it('RIVET_IMAGE_PRUNING=none / simple 生效；数值解析 + 越界钳制', () => {
    assert.equal(resolveStripImagesConfig({ RIVET_IMAGE_PRUNING: 'none' }).strategy, 'none')
    assert.equal(resolveStripImagesConfig({ RIVET_IMAGE_PRUNING: 'simple' }).strategy, 'simple')
    const cfg = resolveStripImagesConfig({
      RIVET_IMAGE_PRUNING_MIN: '0',
      RIVET_IMAGE_PRUNING_INTERVAL: '1',
      RIVET_IMAGE_PRUNING_MAX_MB: '2.5',
    })
    assert.equal(cfg.minImages, 0)
    assert.equal(cfg.interval, 1)
    assert.equal(cfg.maxMessageMb, 2.5)
    // interval 钳到 ≥1（%0 是 NaN 陷阱），min 钳到 ≥0
    const clamped = resolveStripImagesConfig({ RIVET_IMAGE_PRUNING_INTERVAL: '0', RIVET_IMAGE_PRUNING_MIN: '-3' })
    assert.equal(clamped.interval, 1)
    assert.equal(clamped.minImages, 0)
  })

  it('未知策略值回落默认 interval（不 fail 也不放大）', () => {
    assert.equal(resolveStripImagesConfig({ RIVET_IMAGE_PRUNING: 'bogus' }).strategy, 'interval')
  })
})

describe('StripImagesAtIntervals — offset 钳制（rewind/compact 后历史变短）', () => {
  it('total 跌破 offset 时 offset 钳到 total，keep 落回 minImages', () => {
    const f = createStripImagesAtIntervals({ strategy: 'interval', minImages: 2, interval: 10, maxMessageMb: 0.0005 })
    f.apply(msgs(5, () => FAT)) // force-prune，offset=5
    // 历史被 rewind 到 3 张（小图，不再触 MB 上限）
    const result = f.apply(msgs(3))
    assert.equal(f.getOffset(), 3, '历史变短时 offset 钳到当轮 total')
    // 钳制后 keep = ((3-3)%10)+2 = min：周期从窗口起点重启，而非负数取模
    assert.deepEqual(surviving(result.messages), ['img1', 'img2'])
  })
})
