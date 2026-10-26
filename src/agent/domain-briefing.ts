/**
 * 星域「人话简报」——面向用户的一屏定位。
 *
 * 切换星域时，终端原先直接回显 `volatileBlock`——那是注入模型上下文的人设正文
 * （数百到两千字）。它服务的是模型的行为倾向，不是人的理解：用户想知道的其实只有
 * 三件事——
 *
 *   1. 这颗星擅长什么（我该在什么时候选它）
 *   2. 它会怎样改变 agent 的行为（节奏、是否会频频打断我）
 *   3. 它会不会被自动选中（还是必须手动钉定）
 *
 * 人设正文越长，这三件事越难从中抠出来——在这里信息量与可读性是反向的。
 * 所以展示层与注入层分离：模型读 volatileBlock，用户读本模块。
 *
 * 单一事实源（不新造第二份文案）：
 *   - 擅长 → STAR_GENESIS.expertise（本来就是「一句话核心专长（小白可读）」，
 *     图鉴与选择器共用；custom 域缺省时回退 tagline）
 *   - 倾向 → decisionStyle / courageThreshold / DOMAIN_AUTO_POOL 三个**行为字段**
 *     翻译成人话。decisionStyle 只被展示消费，courageThreshold 真接手
 *     courage-hook（最近工具失败率达到多少才注入提醒——高 = 少被打断），
 *     自动池决定关键词路由能否选中它。
 *
 * custom 域（用户自建 md）走同一路径：字段缺省时逐级回退，不抛错。
 */
import { STAR_GENESIS } from './star-genesis-data.js'
import { DOMAIN_AUTO_POOL } from './star-domain.js'
import type { DecisionStyle } from './star-domain-data.js'

/** 简报所需的域字段子集——内置域（StarDomain）与钉定态（ActiveStarDomain 的超集）都能喂。 */
export interface DomainBriefingSource {
  id: string
  name: string
  alias?: string
  tagline?: string
  decisionStyle?: DecisionStyle
  courageThreshold?: number
  uiPersona?: { glyph: string }
}

const STYLE_LABEL: Record<DecisionStyle, string> = {
  bold: '大胆试错',
  cautious: '审慎称量',
  methodical: '稳健分步',
}

/**
 * 催促频率人话化。语义注意：courageThreshold 是「最近工具失败率达到多少才注入
 * 风险提醒」的阈值——**高不等于保守，高等于少被打断**。破军 0.25 是常提醒，
 * 太一 0.95 是几乎从不打断。
 */
function nudgeLabel(threshold: number): string {
  if (threshold < 0.4) return '受挫时提醒频繁'
  if (threshold < 0.65) return '偶尔提醒'
  return '少被打断'
}

/** 用户可见的专长句：优先 genesis 的「一句话核心专长」，custom 域回退 tagline。 */
function expertiseOf(id: string, tagline?: string): string {
  const genesis = STAR_GENESIS.find((g) => g.key === id)
  return (genesis?.expertise ?? tagline ?? '').trim()
}

/** 「倾向」三项人话标签：节奏 · 催促频率 · 能否被自动选中。 */
function traitLabels(domain: DomainBriefingSource): string[] {
  const traits: string[] = []
  if (domain.decisionStyle) traits.push(STYLE_LABEL[domain.decisionStyle] ?? domain.decisionStyle)
  if (typeof domain.courageThreshold === 'number') traits.push(nudgeLabel(domain.courageThreshold))
  traits.push(
    (DOMAIN_AUTO_POOL as readonly string[]).includes(domain.id)
      ? '可自动匹配'
      : '需手动切换（/domain <id>）',
  )
  return traits
}

/**
 * 生成 2–3 行简报：
 *
 *   符号 名称 · 工程别名 (id)
 *   擅长：<一句话专长>
 *   倾向：<节奏> · <催促频率> · <可否自动匹配>
 */
export function buildDomainBriefLines(domain: DomainBriefingSource): string[] {
  const glyph = domain.uiPersona?.glyph ? `${domain.uiPersona.glyph} ` : ''
  const alias = domain.alias ? ` · ${domain.alias}` : ''
  const lines = [`${glyph}${domain.name}${alias} (${domain.id})`]

  const expertise = expertiseOf(domain.id, domain.tagline)
  if (expertise) lines.push(`擅长：${expertise}`)

  lines.push(`倾向：${traitLabels(domain).join(' · ')}`)

  return lines
}

/** `/domain <id>` 切换后的回显文本（缓存代价提示由调用方按需追加）。 */
export function formatDomainSwitch(domain: DomainBriefingSource): string {
  return buildDomainBriefLines(domain).join('\n')
}

/** 选择器路径的单行确认——scrollback 只写一行时用（不含换行）。 */
export function formatDomainSwitchLine(domain: DomainBriefingSource): string {
  const glyph = domain.uiPersona?.glyph ? `${domain.uiPersona.glyph} ` : ''
  const alias = domain.alias ? ` · ${domain.alias}` : ''
  return `${glyph}${domain.name}${alias}（${traitLabels(domain).join(' · ')}）`
}

/** `/domain list` 的单行条目：符号 名称 · 别名 —— 专长。 */
export function formatDomainListLine(domain: DomainBriefingSource, current: boolean): string {
  const glyph = domain.uiPersona?.glyph ? `${domain.uiPersona.glyph} ` : ''
  const alias = domain.alias ? ` · ${domain.alias}` : ''
  const expertise = expertiseOf(domain.id, domain.tagline)
  const marker = current ? '  ← current' : ''
  return `  ${glyph}${domain.name}${alias}${expertise ? `  —  ${expertise}` : ''}${marker}`
}
