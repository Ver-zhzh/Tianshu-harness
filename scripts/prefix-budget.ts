/**
 * 前缀预算审计 — 回答「主控的注意力花在哪个块上」。
 *
 * 走真实装配路径采集（createVolatileSnapshot + buildStableVolatileBlock +
 * createDefaultToolRegistry），再按块归因。总量与真实 frozen 前缀对账，
 * 偏差过大会告警——防止明细口径悄悄偏离实际发出的字节。
 *
 * Usage:
 *   npx tsx scripts/prefix-budget.ts             # 当前 cwd
 *   npx tsx scripts/prefix-budget.ts --tools     # 追加逐工具 schema 明细
 *   npx tsx scripts/prefix-budget.ts --json      # 机器可读
 *   RIVET_TOOL_PRESET=full npx tsx scripts/prefix-budget.ts
 */
import { buildSystemPrompt } from '../src/prompt/static.js'
import { createVolatileSnapshot } from '../src/prompt/volatile-snapshot.js'
import { buildStableVolatileBlock } from '../src/prompt/volatile.js'
import { resolvePromptBlocks } from '../src/prompt/block-policy.js'
import { buildBudgetReport, formatBudgetReport, estimateTokens, type BudgetInput } from '../src/prompt/prefix-budget.js'
import { createDefaultToolRegistry } from '../src/tools/default-registry.js'
import { resolveToolPreset } from '../src/tools/tool-preset.js'
import { gateToolDefinitions, resolveMainToolTier } from '../src/agent/tool-tiers.js'
import { STAR_DOMAINS } from '../src/agent/star-domain-data.js'
import { loadConfig } from '../src/config/manager.js'
import { loadUserInstructions } from '../src/config/user-instructions.js'
import { renderUserInstructions } from '../src/prompt/user-instructions.js'

const args = process.argv.slice(2)
const wantJson = args.includes('--json')
const wantTools = args.includes('--tools')
const cwd = process.cwd()

// 走与 createAgentConfig 同一条解析路径——脚本自己硬编码 cap 就量不到档位差异。
const policy = resolvePromptBlocks(cwd)

// ── 工具 schema：走主控真实门控（CORE 层），不是全量注册表 ──────────
const registry = createDefaultToolRegistry()
const gatedTools = gateToolDefinitions(registry.getDefinitions(), {
  enabled: true,
  domainTier: resolveMainToolTier(null),
  toolDescriptions: policy.toolDescriptions,
})
const toolsJson = JSON.stringify(gatedTools)

// ── frozen volatile：真实快照 ────────────────────────────────────
const userInstructions = loadUserInstructions(loadConfig({ cwd }).agent.userInstructions)
const snapshot = createVolatileSnapshot({ cwd, blockPolicy: policy, userInstructions })
const frozenVolatile = buildStableVolatileBlock(snapshot)
const systemPrompt = buildSystemPrompt({ tools: gatedTools })

// 默认星域（天枢）——真实会话由 bindSessionDomain 绑定，这里取默认值做量级参考。
const domain = STAR_DOMAINS.tianshu

const inputs: BudgetInput[] = [
  { name: 'static.ts BASE_PROMPT', category: 'brake', content: systemPrompt },
  { name: 'star-domain volatileBlock', category: 'brake', content: domain.volatileBlock },
  { name: '工具 schema (JSON)', category: 'tools', content: toolsJson },
  { name: 'user-instructions (new boundary)', category: 'brake', content: userInstructions.state === 'active' ? renderUserInstructions(userInstructions)! + '\n\n' : undefined },
  {
    name: 'project-instructions',
    category: 'reference',
    content: snapshot.rivetMd?.slice(0, policy.caps.projectInstructions),
    cap: policy.caps.projectInstructions,
    rawChars: snapshot.rivetMd?.length,
  },
  {
    name: 'project-memory',
    category: 'reference',
    content: snapshot.projectMemoryBlock?.slice(0, policy.caps.projectMemory),
    cap: policy.caps.projectMemory,
    rawChars: snapshot.projectMemoryBlock?.length,
  },
  {
    name: 'knowledge-manifest',
    category: 'reference',
    content: snapshot.knowledgeManifestBlock?.slice(0, policy.caps.knowledgeManifest),
    cap: policy.caps.knowledgeManifest,
    rawChars: snapshot.knowledgeManifestBlock?.length,
  },
  {
    name: 'codebase-index',
    category: 'reference',
    content: snapshot.projectIndexBlock?.slice(0, policy.caps.codebaseIndex),
    cap: policy.caps.codebaseIndex,
    rawChars: snapshot.projectIndexBlock?.length,
  },
  { name: 'seed-capsule 索引', category: 'reference', content: snapshot.seedCapsuleBlock },
]

const report = buildBudgetReport(inputs)

// 对账：明细之和 vs 真实发出的字节（system + frozen volatile + tools）。
// 明细按 loader 输出估算，真实块带 XML 包装与拼接开销，允许 15% 偏差。
const actualChars = systemPrompt.length + frozenVolatile.length + toolsJson.length
const drift = actualChars > 0 ? Math.abs(report.totalChars - actualChars) / actualChars : 0

if (wantJson) {
  console.log(JSON.stringify({
    profile: policy.profile,
    toolDescriptions: policy.toolDescriptions,
    preset: resolveToolPreset(cwd),
    toolCount: gatedTools.length,
    actualChars,
    actualTokens: estimateTokens('x'.repeat(actualChars)),
    drift: Number(drift.toFixed(4)),
    ...report,
  }, null, 2))
} else {
  console.log()
  console.log(formatBudgetReport(report))
  console.log()
  console.log(`真实前缀 ${actualChars} 字符 ~${estimateTokens('x'.repeat(actualChars))} token`)
  console.log(`前缀档位 ${policy.profile}（工具描述 ${policy.toolDescriptions}）`)
  console.log(`工具档位 ${resolveToolPreset(cwd)}，主控可见 ${gatedTools.length} 个工具`)
  console.log('token 为 chars/4 粗估（项目统一口径）——中文密集内容实际偏高，跨块对比用，勿与 API usage 直接比对。')
  if (!snapshot.projectIndexBlock) {
    console.log(`codebase-index 未采集：本脚本不建 MeridianDB，真实会话中该块另占至多 ${policy.caps.codebaseIndex} 字符。`)
  }
  if (drift > 0.15) {
    console.log(`\n[warn] 明细与真实前缀偏差 ${(drift * 100).toFixed(1)}% — 归因口径可能已漂移，检查是否有新块未纳入采集`)
  }

  if (wantTools) {
    console.log()
    console.log('逐工具 schema（desc = 描述正文，compact 档只作用于它）')
    console.log('─'.repeat(76))
    const sized = gatedTools
      .map(d => ({ name: d.name, chars: JSON.stringify(d).length, desc: d.description.length }))
      .sort((a, b) => b.chars - a.chars)
    for (const t of sized) {
      const share = ((t.chars / toolsJson.length) * 100).toFixed(1)
      console.log(`${t.name.padEnd(24)} ${String(t.chars).padStart(6)} 字符  desc ${String(t.desc).padStart(5)}  ~${String(estimateTokens('x'.repeat(t.chars))).padStart(5)} token  ${share.padStart(5)}%`)
    }
  }
}
