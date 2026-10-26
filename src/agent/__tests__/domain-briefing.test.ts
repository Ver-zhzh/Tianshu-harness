import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDomainBriefLines, formatDomainSwitch, formatDomainSwitchLine } from '../domain-briefing.js'
import { STAR_DOMAINS, type StarDomainId } from '../star-domain-data.js'
import { DOMAIN_AUTO_POOL } from '../star-domain.js'

const BUILTIN_IDS = Object.keys(STAR_DOMAINS) as StarDomainId[]

test('every built-in domain yields a briefing of at most 3 lines', () => {
  for (const id of BUILTIN_IDS) {
    const lines = buildDomainBriefLines(STAR_DOMAINS[id])
    assert.ok(lines.length > 0, `${id} 简报为空`)
    assert.ok(lines.length <= 3, `${id} 简报 ${lines.length} 行，超过 3 行`)
  }
})

test('briefing never echoes the persona正文 (volatileBlock)', () => {
  for (const id of BUILTIN_IDS) {
    const domain = STAR_DOMAINS[id]
    const text = buildDomainBriefLines(domain).join('\n')
    // volatileBlock 是注入模型的文本，用户面简报不得转述它。
    const proseHead = (domain.volatileBlock || '')
      .split('\n')
      .map((s) => s.trim())
      .find((s) => s.length >= 12)
    if (proseHead) {
      assert.equal(text.includes(proseHead), false, `${id} 简报回显了 volatileBlock`)
    }
    assert.ok(text.length <= 220, `${id} 简报 ${text.length} 字符，过长`)
  }
})

test('briefing names the domain and its engineering alias', () => {
  const lines = buildDomainBriefLines(STAR_DOMAINS.tianquan)
  assert.match(lines[0]!, /天权/)
  assert.match(lines[0]!, /方案审查官/)
  assert.match(lines[0]!, /tianquan/)
})

test('briefing states expertise from genesis data (single source of truth)', () => {
  const text = buildDomainBriefLines(STAR_DOMAINS.yaoguang).join('\n')
  assert.match(text, /验收别人的修复/)
})

test('expertise reads as plain guidance: says when to use it, no metaphor terms', () => {
  // 「一句话核心专长（小白可读）」是 genesis 字段自己的承诺——验收它，别只信注释。
  const jargon = ['轴', '透镜', '共振', '骨骼', '归族', '守昼', '托举', '剪枝', '肃秋', '天得一']
  for (const id of BUILTIN_IDS) {
    const lines = buildDomainBriefLines(STAR_DOMAINS[id])
    const expertiseLine = lines.find((l) => l.startsWith('擅长：'))
    assert.ok(expertiseLine, `${id} 缺擅长行`)
    for (const term of jargon) {
      assert.equal(
        expertiseLine!.includes(term),
        false,
        `${id} 的擅长句仍含内部术语「${term}」：${expertiseLine}`,
      )
    }
  }
})

test('briefing translates behaviour traits, not decisionStyle enum literals', () => {
  const bold = buildDomainBriefLines(STAR_DOMAINS.pojun).join('\n')
  assert.match(bold, /大胆试错/)
  assert.equal(/\bmethodical\b|\bcautious\b|\bbold\b/.test(bold), false, '不应把枚举字面量丢给用户')

  const calm = buildDomainBriefLines(STAR_DOMAINS.taiyi).join('\n')
  assert.match(calm, /少被打断/)
})

test('briefing tells whether the domain can be auto-routed', () => {
  const autoRouted = buildDomainBriefLines(STAR_DOMAINS.tianquan).join('\n')
  assert.match(autoRouted, /自动匹配/)
  const manualOnly = buildDomainBriefLines(STAR_DOMAINS.taiyi).join('\n')
  assert.match(manualOnly, /手动/)
})

test('auto pool membership in the briefing matches DOMAIN_AUTO_POOL', () => {
  for (const id of BUILTIN_IDS) {
    const text = buildDomainBriefLines(STAR_DOMAINS[id]).join('\n')
    const inPool = DOMAIN_AUTO_POOL.includes(id)
    assert.equal(/需手动切换/.test(text), !inPool, `${id} 的自动匹配标注与池不一致`)
  }
})

test('custom domain without genesis entry falls back to tagline', () => {
  const custom = {
    id: 'my-star' as StarDomainId,
    name: '自定义星',
    alias: '我的代理',
    motto: '一句话',
    tagline: '自定义气质 · 自定节奏',
    volatileBlock: '这段人设正文不应该出现在用户简报里，一个字的转述都不行。',
    decisionStyle: 'cautious' as const,
    courageThreshold: 0.5,
    keywords: ['custom'],
    isCustom: true,
    toolWhitelist: [],
    systemPromptSuffix: '',
    uiPersona: { separator: 'dots' as const, accent: 'primary' as const, glyph: '★' },
  }
  const lines = buildDomainBriefLines(custom)
  assert.ok(lines.length <= 3)
  const text = lines.join('\n')
  assert.match(text, /自定义气质/)
  assert.equal(text.includes('这段人设正文不应该出现'), false)
})

test('formatDomainSwitch returns non-empty text and keeps optional cache note separate', () => {
  const out = formatDomainSwitch(STAR_DOMAINS.tianxuan)
  assert.ok(out.length > 0)
  assert.match(out, /天璇/)
  // 缓存代价提示由调用方追加（DOMAIN_SWITCH_CACHE_WARNING），简报自身不夹带。
  assert.equal(/前缀缓存/.test(out), false)
})

test('formatDomainSwitchLine is a single line with human-readable traits', () => {
  for (const id of BUILTIN_IDS) {
    const line = formatDomainSwitchLine(STAR_DOMAINS[id])
    assert.equal(line.includes('\n'), false, `${id} 单行确认含换行`)
    assert.ok(line.length <= 120, `${id} 单行确认 ${line.length} 字符`)
    assert.equal(/\bmethodical\b|\bcautious\b|\bbold\b/.test(line), false)
  }
})
