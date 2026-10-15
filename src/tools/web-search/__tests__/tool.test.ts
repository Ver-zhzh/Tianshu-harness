import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createWebSearchTool, WEB_SEARCH_TOOL } from '../tool.js'
import type { SearchBackend } from '../types.js'

function backend(name: string, behavior: SearchBackend['search'], available = true): SearchBackend {
  return { name, isAvailable: () => available, search: behavior }
}

const params = (input: Record<string, unknown>) => ({ input, toolUseId: 't', cwd: '/tmp' })

describe('createWebSearchTool', () => {
  it('keeps the tool definition byte-stable regardless of backends (prefix cache)', () => {
    const a = createWebSearchTool()
    const b = createWebSearchTool({ backends: [backend('brave', async () => [])] })
    assert.deepEqual(a.definition, b.definition)
    assert.deepEqual(WEB_SEARCH_TOOL.definition, a.definition)
    assert.equal(a.definition.name, 'web_search')
  })

  it('rejects an empty query', async () => {
    const tool = createWebSearchTool()
    const out = await tool.execute(params({ query: '  ' }))
    assert.equal(out.isError, true)
    assert.match(out.content, /非空字符串/)
  })

  it('formats results and attributes the winning backend', async () => {
    const tool = createWebSearchTool({
      backends: [backend('brave', async () => [{ title: 'T', url: 'https://x', snippet: 'S' }])],
    })
    const out = await tool.execute(params({ query: 'q' }))
    assert.equal(out.isError, undefined)
    assert.match(out.content, /经 brave/)
    assert.match(out.content, /\[T\]\(https:\/\/x\)/)
  })

  it('returns a benign no-results message when all backends are empty', async () => {
    const tool = createWebSearchTool({ backends: [backend('ddg', async () => [])] })
    const out = await tool.execute(params({ query: 'nothing here' }))
    assert.equal(out.isError, undefined)
    assert.match(out.content, /未找到与「nothing here」相关的搜索结果/)
  })

  it('discards an all-off-topic result set instead of delivering it (issue #483)', async () => {
    // 2026-09 cn.bing.com 故障形态：结构完好但无关/降级的 SERP。旧契约把这批
    // 已判跑题的结果加「低相关」标注后交付，实测弱模型仍采信并据此编造答案——
    // 泛结果冒充答案比「没搜到」更糟。新契约：弃置正文，只说明降级事实与出路。
    const tool = createWebSearchTool({
      backends: [backend('bing', async () => [
        { title: '西南交通大学研究生院（党委研究生工作部）', url: 'https://gsnews.swjtu.edu.cn/', snippet: '与查询无关。' },
        { title: '国家科学评论 (National Science Review)', url: 'https://www.nsreviewgroup.com/', snippet: '与查询无关。' },
      ])],
    })
    const out = await tool.execute(params({ query: '杭州西湖 门票预约' }))
    assert.equal(out.isError, undefined)
    assert.match(out.content, /未找到相关结果/)
    assert.match(out.content, /与查询无关/)
    assert.match(out.content, /已弃置/)
    assert.match(out.content, /bocha/, '出路建议应指向 API key 后端')
    assert.ok(!out.content.includes('西南交通大学'), '判跑题的结果正文不得交付')
    assert.ok(!out.content.includes('gsnews.swjtu.edu.cn'), '判跑题的结果 URL 不得交付')
  })

  it('keeps a relevant result set unlabelled', async () => {
    const tool = createWebSearchTool({
      backends: [backend('bing', async () => [
        { title: '2026杭州西湖景区门票预约购买入口汇总', url: 'https://x/1', snippet: '杭州西湖门票预约入口，每日限流。' },
        { title: '杭州西湖景区预约指南', url: 'https://x/2', snippet: '西湖门票预约流程与开放时间。' },
      ])],
    })
    const out = await tool.execute(params({ query: '杭州西湖 门票预约' }))
    assert.equal(out.isError, undefined)
    assert.ok(!out.content.includes('低相关'), '相关结果不得带低相关标注')
    assert.match(out.content, /经 bing/)
  })

  it('does not report a hard error when the only results are low-confidence', async () => {
    // 软失败语义：低置信兜底不是硬错误，不该显示「搜索失败」。
    const tool = createWebSearchTool({
      backends: [backend('bing', async () => [
        { title: '湖南科技大学', url: 'https://www.hnust.edu.cn/', snippet: '无关。' },
      ])],
    })
    const out = await tool.execute(params({ query: '杭州西湖 门票预约' }))
    assert.equal(out.isError, undefined)
    assert.ok(!out.content.includes('搜索失败'))
  })

  it('surfaces an error when all backends fail hard', async () => {
    const tool = createWebSearchTool({
      backends: [backend('ddg', async () => { throw new Error('HTTP 503') })],
    })
    const out = await tool.execute(params({ query: 'q' }))
    assert.equal(out.isError, true)
    assert.match(out.content, /搜索失败/)
    assert.match(out.content, /ddg: HTTP 503/)
  })

  it('coerces a numeric-string count to a number', async () => {
    let receivedCount: number | undefined
    const tool = createWebSearchTool({
      backends: [backend('brave', async (_q, count) => {
        receivedCount = count
        return Array.from({ length: count }, (_, i) => ({
          title: `T${i}`,
          url: `https://x/${i}`,
          snippet: 'S',
        }))
      })],
    })
    const out = await tool.execute(params({ query: 'q', count: '3' }))
    assert.equal(out.isError, undefined)
    assert.equal(receivedCount, 3)
    assert.match(out.content, /1\. \[T0\]\(https:\/\/x\/0\)/)
    assert.match(out.content, /3\. \[T2\]\(https:\/\/x\/2\)/)
  })

  it('coerces a numeric query to a string', async () => {
    let receivedQuery: string | undefined
    const tool = createWebSearchTool({
      backends: [backend('brave', async (q) => {
        receivedQuery = q
        // 标题回带查询词：否则「123」与「T」零重叠会被 off-topic 守卫判为低置信兜底
        // （守卫行为见 relevance.test.ts）。本用例只关心 query 的类型转换。
        return [{ title: 'T123', url: 'https://x', snippet: 'S' }]
      })],
    })
    const out = await tool.execute(params({ query: 123 }))
    assert.equal(out.isError, undefined)
    assert.equal(receivedQuery, '123')
    assert.match(out.content, /「123」的网页搜索结果/)
  })

  it('falls back to the default count for an invalid count string', async () => {
    let receivedCount: number | undefined
    const tool = createWebSearchTool({
      backends: [backend('brave', async (_q, count) => {
        receivedCount = count
        return Array.from({ length: count }, (_, i) => ({
          title: `T${i}`,
          url: `https://x/${i}`,
          snippet: 'S',
        }))
      })],
    })
    const out = await tool.execute(params({ query: 'q', count: 'abc' }))
    assert.equal(out.isError, undefined)
    assert.equal(receivedCount, 10)
  })

  it('requires approval and is concurrency-safe', () => {
    const tool = createWebSearchTool()
    assert.equal(tool.requiresApproval(params({ query: 'q' })), true)
    assert.equal(tool.isConcurrencySafe(), true)
    assert.equal(tool.isEnabled(), true)
  })
})
