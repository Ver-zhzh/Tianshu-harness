/**
 * thinking 回看仓（ThinkingReviewStore）：留存/取出/清空语义 + 详情格式。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ThinkingReviewStore, formatThinkingReview } from '../thinking-review.js'
import { getTheme } from '../../theme.js'

const theme = getTheme()
const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')

describe('ThinkingReviewStore', () => {
  it('save → peek → take（take 后清空，避免重复消费）', () => {
    const store = new ThinkingReviewStore()
    assert.equal(store.peek(), null)
    store.save({ text: '思考内容', elapsedMs: 1000 })
    assert.equal(store.peek()?.text, '思考内容')
    assert.equal(store.take()?.text, '思考内容')
    assert.equal(store.take(), null, '第二次 take 应为空')
  })

  it('save 覆盖上一段（只留最近一次 thinking）', () => {
    const store = new ThinkingReviewStore()
    store.save({ text: '第一段', elapsedMs: 1 })
    store.save({ text: '第二段', elapsedMs: 2 })
    assert.equal(store.take()?.text, '第二段')
  })

  it('空白文本不留存；clear 清空', () => {
    const store = new ThinkingReviewStore()
    store.save({ text: '   \n  ', elapsedMs: 1 })
    assert.equal(store.peek(), null)
    store.save({ text: '有内容', elapsedMs: 1 })
    store.clear()
    assert.equal(store.peek(), null)
  })

  it('超长文本只留尾部 256KB（结论在近处）', () => {
    const store = new ThinkingReviewStore()
    const text = '头'.repeat(100) + 'x'.repeat(300_000) + '尾'.repeat(100)
    store.save({ text, elapsedMs: 1 })
    const kept = store.peek()!.text
    assert.equal(kept.length, 256_000)
    assert.ok(kept.endsWith('尾'.repeat(100)))
    assert.ok(!kept.startsWith('头'))
  })
})

describe('formatThinkingReview', () => {
  it('详情：done 头 + 展开正文', () => {
    const lines = formatThinkingReview({ text: '第一行思考\n第二行结论', elapsedMs: 12_000 }, theme)
    const plain = lines.map(stripAnsi)
    assert.ok(plain[0]!.includes('已推理'), plain[0])
    assert.ok(plain[0]!.includes('12s'), plain[0])
    assert.ok(plain.some(l => l.includes('第一行思考')), '正文第一行在')
    assert.ok(plain.some(l => l.includes('第二行结论')), '正文第二行在')
  })

  it('超过 400 逻辑行时走「上方省略」截断', () => {
    const text = Array.from({ length: 500 }, (_, i) => `思考 ${i}`).join('\n')
    const plain = formatThinkingReview({ text, elapsedMs: 1000 }, theme).map(stripAnsi)
    assert.ok(plain.some(l => l.includes('上方省略 100 行')), plain.join('|'))
    assert.ok(plain.some(l => l.includes('思考 499')), '尾部保留')
  })
})
