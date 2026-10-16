import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createWebSearchTool, WEB_SEARCH_TOOL } from '../tool.js'
import type { SearchBackend } from '../types.js'
import { parseInline } from '../../../tui/format/markdown.js'

function renderedLinks(content: string) {
  return content.split('\n').flatMap(parseInline).filter(segment => segment.href)
}

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

  it('压平外部显示文本中的换行与控制符，不能伪造结果行结构（#498 后续）', async () => {
    const tool = createWebSearchTool({
      backends: [backend('brave', async () => [{
        title: '真标题\n2. 伪造条目 [fake](https://evil.example/)',
        url: 'https://real.example/',
        snippet: '第一行\r\n第二行\t制表',
        siteName: '站点\u0000名',
        publishedAt: '2026-10-16',
      }])],
    })
    const out = await tool.execute(params({ query: 'q' }))
    assert.equal(out.isError, undefined)
    assert.ok(!/\n2\. 伪造条目/.test(out.content), '标题里的换行不得伪造出一条新的结果行')
    assert.ok(!out.content.includes('\r'), '不得残留 CR')
    assert.ok(!out.content.includes('\t'), '不得残留制表符')
    assert.ok(!out.content.includes('\u0000'), '不得残留 NUL')
    assert.ok(!out.content.includes('[fake]'), '标题方括号仍须剥离（既有契约不回归）')
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

  it('strips markdown link syntax from untrusted titles/snippets (link-spoof guard)', async () => {
    // 攻击模型：搜索后端返回的标题/摘要是不可信外部输入（网页 <title>、
    // meta description、JSON API 原样返回）。TUI 等消费端把 `[title](url)`
    // 渲染成可点击超链接——title 里藏 `](https://evil…)` 会让显示文本无辜、
    // 点击跳转钓鱼站。渲染前必须剥掉方括号，中断链接语法。
    const tool = createWebSearchTool({
      backends: [backend('brave', async () => [{
        title: 'XX银行官网登录](https://evil.example/x)',
        url: 'https://www.real-bank.example/',
        snippet: '官方入口[点此登录](https://evil.example/y)，谨防假冒',
      }])],
    })
    const out = await tool.execute(params({ query: 'XX银行官网', count: 1 }))
    assert.equal(out.isError, undefined)
    // 标题里的 `](` 已被中和：不再形成指向 evil 的链接语法
    assert.doesNotMatch(out.content, /\]\(https:\/\/evil\.example\/x\)/)
    assert.match(out.content, /\[XX银行官网登录\(https:\/\/evil\.example\/x\)\]/)
    // 真实 URL 保持不变
    assert.match(out.content, /\(https:\/\/www\.real-bank\.example\/\)/)
    // snippet 里自带的 markdown 链接同样被中和
    assert.doesNotMatch(out.content, /\[点此登录\]\(https:\/\/evil\.example\/y\)/)
    assert.deepEqual(renderedLinks(out.content).map(link => link.href), ['https://www.real-bank.example/'])
  })

  it('strips markdown link syntax from url/siteName/publishedAt too (#498 follow-up)', async () => {
    // #498 只覆盖了 title/snippet，漏了同样插进渲染输出的三个字段：
    // - siteName / publishedAt：博查后端直接拼进 snippet 行，自带完整
    //   `[文字](url)` 会被 TUI 行内解析器链化成可点击链接；
    // - url：TUI 解析器按 indexOf(')') 截断 href，url 里的 `)` 会提前闭合
    //   外层链接，其后尾随的 `[文字](url)` 会被当成新链接链化。
    const tool = createWebSearchTool({
      backends: [backend('bocha', async () => [{
        title: 'XX银行 官方网站',
        url: 'https://bank.example/) [官网直达](https://evil.example/p)',
        snippet: '正规银行官网介绍',
        siteName: '[官网直达](https://evil.example/s)',
        publishedAt: '[2026-10-16](https://evil.example/d)',
      }])],
    })
    const out = await tool.execute(params({ query: 'XX银行官网', count: 1 }))
    assert.equal(out.isError, undefined)
    // 三个注入向量全部被中和：输出里不再存在指向 evil 的 markdown 链接语法
    assert.doesNotMatch(out.content, /\[官网直达\]\(https:\/\/evil\.example/)
    assert.doesNotMatch(out.content, /\[2026-10-16\]\(https:\/\/evil\.example/)
    const links = renderedLinks(out.content)
    assert.equal(links.length, 1)
    assert.equal(new URL(links[0]!.href!).hostname, 'bank.example')
    assert.equal(decodeURI(links[0]!.href!), 'https://bank.example/) [官网直达](https://evil.example/p)')
  })

  it('keeps legitimate urls with parens working after the guard', async () => {
    const tool = createWebSearchTool({
      backends: [backend('ddg', async () => [{
        title: 'X (消歧义)',
        url: 'https://en.wikipedia.org/wiki/X_(disambiguation)',
        snippet: '正常结果',
      }])],
    })
    const out = await tool.execute(params({ query: 'X 消歧义', count: 1 }))
    assert.equal(out.isError, undefined)
    assert.deepEqual(renderedLinks(out.content).map(link => link.href), ['https://en.wikipedia.org/wiki/X_%28disambiguation%29'])
  })

  it('preserves IPv6, bracketed query keys and existing percent encoding in rendered links', async () => {
    for (const url of [
      'https://[2001:4860:4860::8888]/lookup',
      'https://example.com/?filter[name]=alice',
      'https://example.com/a%2Fb?signature=a%2Bb%3D&filter[name]=alice#section',
    ]) {
      const tool = createWebSearchTool({
        backends: [backend('brave', async () => [{ title: 'fixture', url, snippet: 'fixture' }])],
      })
      const out = await tool.execute(params({ query: 'fixture' }))
      assert.deepEqual(renderedLinks(out.content).map(link => link.href), [url])
    }
  })

  it('encodes destination delimiters and whitespace without creating another rendered link', async () => {
    const url = 'https://example.com/a(b) [other](https://evil.example/x)?q="quoted"&tag=<tag>&tick=`x`&quote=\'x\''
    const tool = createWebSearchTool({
      backends: [backend('brave', async () => [{ title: 'fixture', url, snippet: 'fixture' }])],
    })
    const out = await tool.execute(params({ query: 'fixture' }))
    const links = renderedLinks(out.content)
    assert.equal(links.length, 1)
    assert.equal(new URL(links[0]!.href!).hostname, 'example.com')
    assert.equal(decodeURI(links[0]!.href!), url)
    assert.doesNotMatch(links[0]!.href!, /[()\s<>"'`]/)
  })

  it('renders only the title for invalid or non-http destinations', async () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,fixture', 'file:///tmp/fixture', 'not a url', 'https://', 'https://example.com/\n[fixture](https://evil.example/)', 'https://example.com\\@evil.example/']) {
      const tool = createWebSearchTool({
        backends: [backend('brave', async () => [{ title: 'fixture', url, snippet: 'fixture' }])],
      })
      const out = await tool.execute(params({ query: 'fixture' }))
      assert.deepEqual(renderedLinks(out.content), [], url)
      assert.match(out.content, /1\. fixture\n/)
    }
  })
})
