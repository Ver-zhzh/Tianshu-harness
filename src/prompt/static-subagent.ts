/**
 * Sub-agent lean system prompt — composed by filtering the shared BASE_PROMPT.
 *
 * Design constraint (2026-07-26): the main-controller prompt must stay byte-for-byte
 * identical. BASE_PROMPT is therefore never edited for the sub-agent's sake — this
 * module parses it into named sections and re-emits a subset. `composeSections` with
 * an all-keep policy reproduces the input exactly (asserted in tests), so a parse
 * that stops matching the template fails loudly instead of silently dropping text.
 *
 * Retention criterion: 主控事后补救得了吗？Sections the main controller cannot
 * retrofit after the worker returns (probe residue, exhaustive-negative claims,
 * lossy-observation handling, security) stay. Sections the main controller performs
 * itself (delivery contract, six-phase workflow, external-source verification) go.
 *
 * See docs/superpowers/specs/2026-07-26-subagent-lean-runtime-design.md §4.
 */

import type { ToolDefinition } from '../api/types.js'

// ─── Parsing ──────────────────────────────────────────────────────

interface Section {
  name: string
  /** Exact separator before this section (the template uses both one and two newlines). */
  separatorBefore: string
  /** Full text including the enclosing tags. */
  full: string
  /** Inner text, tags excluded. */
  body: string
}

const TOP_LEVEL_RE = /^<([a-z][a-z-]*)>\n([\s\S]*?)\n<\/\1>$/gm
const RULE_RE = /^ {2}<rule name="([^"]+)">\n([\s\S]*?)\n {2}<\/rule>$/gm
const HARNESS_PART_RE = /^ {2}<([a-z-]+)(?: name="([^"]+)")?>\n([\s\S]*?)\n {2}<\/\1>$/gm

export interface ParsedPrompt {
  sections: Section[]
  /** Whitespace following the last section — BASE_PROMPT ends with a newline. */
  trailer: string
}

/**
 * Split a prompt into its top-level `<tag>…</tag>` sections.
 *
 * Throws when the sections plus trailer do not reproduce the input exactly — that
 * means the template grew a shape this parser does not understand, and silently
 * emitting a partial prompt to workers would be worse than failing loudly.
 */
export function parsePrompt(src: string): ParsedPrompt {
  const sections: Section[] = []
  let cursor = 0
  for (const m of src.matchAll(TOP_LEVEL_RE)) {
    const separatorBefore = src.slice(cursor, m.index)
    if (sections.length === 0 ? separatorBefore !== '' : !/^\n{1,2}$/.test(separatorBefore)) {
      throw new Error('[static-subagent] top-level parse is lossy: unexpected text between sections. BASE_PROMPT shape changed.')
    }
    sections.push({ name: m[1]!, separatorBefore, full: m[0]!, body: m[2]! })
    cursor = m.index! + m[0]!.length
  }
  const rejoined = sections.map(s => s.separatorBefore + s.full).join('')
  const trailer = src.slice(cursor)
  if (sections.length === 0 || rejoined + trailer !== src || !/^\s*$/.test(trailer)) {
    throw new Error(
      `[static-subagent] top-level parse is lossy: parsed ${sections.length} sections ` +
      `covering ${rejoined.length} of ${src.length} chars. BASE_PROMPT shape changed.`,
    )
  }
  return { sections, trailer }
}

/** Convenience wrapper for callers that only need the section list. */
export function splitTopLevelSections(src: string): Section[] {
  return parsePrompt(src).sections
}

/** Split a `<rules>` body into its individual `<rule name="…">` entries. */
export function splitRules(rulesBody: string): Section[] {
  const out: Section[] = []
  for (const m of rulesBody.matchAll(RULE_RE)) {
    out.push({ name: m[1]!, separatorBefore: '', full: m[0]!, body: m[2]! })
  }
  if (out.length === 0) throw new Error('[static-subagent] no <rule> entries found in <rules>')
  return out
}

// ─── Retention policy ─────────────────────────────────────────────

/** Top-level sections every sub-agent drops. The main controller runs these itself. */
const DROP_SECTIONS: ReadonlySet<string> = new Set([
  // 交付报告契约是对人类说话的；子代理的交付契约是 WorkerResult，两份同时在场冲突。
  'delivery-contract',
  // 探索→计划→执行→验证是主控的循环；子代理接的是已定边界的任务卡。
  'workflow',
  // 整段是"建议用户运行 /mirror china"。子代理没有面向用户的通道，
  // /mirror 也是 TUI 斜杠命令而非工具——对它是不可执行的建议。
  'downloads',
])

/** Top-level sections kept only when the worker actually holds the coupled tool. */
const TOOL_GATED_SECTIONS: ReadonlyMap<string, (tools: ReadonlySet<string>) => boolean> = new Map([
  ['shared-worktree', (t: ReadonlySet<string>) => t.has('deliver_task')],
  ['git', (t: ReadonlySet<string>) => t.has('git')],
  ['delegation', (t: ReadonlySet<string>) => t.has('delegate_task') || t.has('delegate_batch')],
])

/** Rules every sub-agent drops. */
const DROP_RULES: ReadonlySet<string> = new Set([
  // 整条写给主控：末句直接点名 "worker 输出的 HIGH/CRITICAL 标记不等于已验证事实"。
  // 子代理是这条规则的对象，不是执行者。
  'external-source-verification',
  // 讲用户说 "P1"/"刚才那个" 时怎么回指上一轮回复。子代理不跟人对话，
  // 收到的是自包含任务卡；它引用的 <intent-retrieval-route> 块是主控专有。
  'context-intent-association',
  // 规则描述的是 <git-status> 注入块，而子代理的冻结块里没有该块。
  'git-context-first',
  // 规则描述的全部是 appendixDelta 线格式（seq/覆盖/自闭合），
  // 而 worker 的 PromptEngine 未开 delta，这套格式一次都不会遇到。见设计文档 §6.1。
  'context-update-protocol',
])

/** Rules kept only for write-capable workers. */
const WRITE_ONLY_RULES: ReadonlySet<string> = new Set([
  // 逐字取原文的纪律只在改用户可见字符串时有意义。
  'verbatim-user-facing-text',
])

/** `<test-harness>` sub-blocks kept only for write-capable workers. */
const WRITE_ONLY_HARNESS_PARTS: ReadonlySet<string> = new Set([
  'red-green-bugfix',
  'test-strategy-by-task',
  'env-simulation',
  // 清理临时探针的纪律：只读 worker 没有写工具，创建不了探针——对它是死条文。
  // 保留判据（"主控只看到 diff 摘要，补救不了残留探针"）只在 worker 能写文件时成立。
  'probe-discipline',
])

/** `<test-harness>` sub-blocks no sub-agent gets. */
const DROP_HARNESS_PARTS: ReadonlySet<string> = new Set([
  // 子代理有硬 turn 预算和软着陆收尾，没有换视角深挖的余裕——这条会诱导它超预算乱跑。
  'perspective-shift',
])

/**
 * `<evidence-scope>` lines dropped for read-only workers, keyed by a stable
 * leading substring. 例外条款是主控改自身认知层时的动作；诊断悖论要求写最小
 * 复现测试，只读侦察写不了。
 */
const EVIDENCE_LINE_DROPS: readonly { prefix: string; writeOnly: boolean }[] = [
  { prefix: '  例外：', writeOnly: false },
  { prefix: '  诊断悖论：', writeOnly: true },
]

/**
 * `<identity>` sentence claiming a complete toolset. Every sub-agent runs on a
 * registry filtered by `profile.allowedTools ∩ domain.toolWhitelist`, so the claim
 * is false for all of them and invites calls to tools that are not there. The real
 * toolset is enumerated in the request's tools JSON — the prompt need not assert it.
 */
const IDENTITY_TOOLSET_CLAIM = '你拥有完整的开发工具集：文件读写、代码搜索、终端执行、测试运行、项目导航、任务委派。'

interface ToolLineGate {
  /** Line prefix used as the anchor. Must match exactly one line in the section. */
  prefix: string
  /** The line survives when the worker holds any of these tools. */
  anyOf: readonly string[]
}

/**
 * `<tool-usage>` lines coupled to a specific tool. A group header carries the union
 * of its bullets' tools, so it disappears exactly when every bullet under it does.
 *
 * Two lines are deliberately ungated:
 * - 「探索靠 repo_map / glob / grep / ast_grep / read_file…」核心探索指引，任何
 *   worker 都适用。
 * - 「并行纪律：只读工具可一批发；bash/git/… 需逐个串行」首句对所有档位有效，
 *   为后半句拆句不值得（全行 94 字符）。
 */
const TOOL_USAGE_LINE_GATES: readonly ToolLineGate[] = [
  { prefix: '文件操作工具选择：', anyOf: ['edit_file', 'write_file', 'hash_edit', 'apply_patch', 'ast_edit'] },
  { prefix: '- edit_file：', anyOf: ['edit_file'] },
  { prefix: '- write_file：', anyOf: ['write_file'] },
  { prefix: '- hash_edit：', anyOf: ['hash_edit'] },
  { prefix: '- apply_patch：', anyOf: ['apply_patch'] },
  { prefix: '- ast_edit：', anyOf: ['ast_edit'] },
  { prefix: '禁止用 bash 读写文件。', anyOf: ['bash', 'write_file', 'hash_edit'] },
  { prefix: '检索工具选择：', anyOf: ['grep', 'ast_grep'] },
  { prefix: '- grep：', anyOf: ['grep'] },
  { prefix: '- ast_grep：', anyOf: ['ast_grep'] },
  { prefix: '浏览器与桌面自动化分工：', anyOf: ['web_fetch', 'web_search', 'browser_debug', 'computer_use'] },
  { prefix: '- web_fetch / web_search：', anyOf: ['web_fetch', 'web_search'] },
  { prefix: '- browser_debug（', anyOf: ['browser_debug'] },
  { prefix: '- computer_use：', anyOf: ['computer_use'] },
  // 「三者」= 上面三条 bullet；审批边界讲的是导航与逐应用授权，只对后两者成立。
  { prefix: '- 三者动作均有审批边界', anyOf: ['browser_debug', 'computer_use'] },
  { prefix: '工作区外路径：', anyOf: ['request_path_access'] },
  // 前向引用 <delegation> 段——该段被门掉时这行会变成悬空指针。
  { prefix: '委派原则：', anyOf: ['delegate_task', 'delegate_batch'] },
]

// ─── Composition ──────────────────────────────────────────────────

export interface SubagentPromptPolicy {
  /** Worker holds at least one workspace-mutating tool. */
  writeCapable: boolean
  /** Tool names on the worker's filtered registry. */
  tools: ReadonlySet<string>
}

const WRITE_CAPABLE_TOOLS: ReadonlySet<string> = new Set([
  'edit_file', 'write_file', 'hash_edit', 'apply_patch', 'bash', 'run_tests', 'git',
])

export function derivePolicy(tools: ToolDefinition[]): SubagentPromptPolicy {
  const names = new Set(tools.map(t => t.name))
  return {
    tools: names,
    writeCapable: [...names].some(n => WRITE_CAPABLE_TOOLS.has(n)),
  }
}

function trimEvidenceScope(rule: Section, policy: SubagentPromptPolicy): string {
  const kept = rule.body.split('\n').filter(line => {
    const drop = EVIDENCE_LINE_DROPS.find(d => line.startsWith(d.prefix))
    if (!drop) return true
    return drop.writeOnly && policy.writeCapable
  })
  return `  <rule name="${rule.name}">\n${kept.join('\n')}\n  </rule>`
}

function trimTestHarness(rule: Section, policy: SubagentPromptPolicy): string | null {
  const header = rule.body.split('\n\n')[0]!
  const kept: string[] = []
  for (const m of rule.body.matchAll(HARNESS_PART_RE)) {
    const key = m[2] ?? m[1]!
    if (DROP_HARNESS_PARTS.has(key)) continue
    if (WRITE_ONLY_HARNESS_PARTS.has(key) && !policy.writeCapable) continue
    kept.push(m[0]!)
  }
  if (kept.length === 0) return null
  return `  <rule name="${rule.name}">\n${header}\n\n${kept.join('\n\n')}\n  </rule>`
}

/**
 * Every gate anchor must resolve to exactly one line. A drifted anchor would
 * silently stop gating (worker reads about tools it lacks) or gate the wrong line,
 * so it fails the build instead — same discipline as `parsePrompt`.
 */
function assertAnchorsResolve(lines: readonly string[], gates: readonly ToolLineGate[], where: string): void {
  for (const gate of gates) {
    const hits = lines.filter(l => l.startsWith(gate.prefix)).length
    if (hits !== 1) {
      throw new Error(
        `[static-subagent] <${where}> anchor "${gate.prefix}" matched ${hits} lines (expected 1). ` +
        'BASE_PROMPT changed — update TOOL_USAGE_LINE_GATES.',
      )
    }
  }
}

function trimToolUsage(section: Section, tools: ReadonlySet<string>): string {
  const lines = section.body.split('\n')
  assertAnchorsResolve(lines, TOOL_USAGE_LINE_GATES, section.name)
  const kept = lines.filter(line => {
    const gate = TOOL_USAGE_LINE_GATES.find(g => line.startsWith(g.prefix))
    return !gate || gate.anyOf.some(t => tools.has(t))
  })
  if (kept.length === lines.length) return section.full
  return `<${section.name}>\n${kept.join('\n')}\n</${section.name}>`
}

/**
 * Apply the same `<tool-usage>` line gates to a full prompt (main-controller path).
 *
 * 主控提示词此前无条件点名 apply_patch/ast_edit 等 EXTENDED 工具，而主控可见集由
 * `gateToolDefinitions` 摘掉了它们——模型照着提示词发起调用，解析层只看到「未声明的
 * 工具名」→ ToolNameProtocolError(unknown)，整次响应作废（真实事故形态）。
 * 与子代理共用一份门控表，两处不再各写一份漂移。
 *
 * 不变时逐字返回入参（前缀缓存只认字节）。
 */
export function trimPromptToolUsage(base: string, tools: ReadonlySet<string>): string {
  const { sections, trailer } = parsePrompt(base)
  let changed = false
  const rebuilt = sections.map(section => {
    if (section.name !== 'tool-usage') return section.separatorBefore + section.full
    const full = trimToolUsage(section, tools)
    if (full !== section.full) changed = true
    return section.separatorBefore + full
  }).join('')
  return changed ? rebuilt + trailer : base
}

function trimIdentity(section: Section): string {
  if (!section.body.includes(IDENTITY_TOOLSET_CLAIM)) {
    throw new Error(
      '[static-subagent] <identity> toolset-claim anchor not found. ' +
      'BASE_PROMPT changed — update IDENTITY_TOOLSET_CLAIM.',
    )
  }
  return `<${section.name}>\n${section.body.replace(IDENTITY_TOOLSET_CLAIM, '')}\n</${section.name}>`
}

function composeRules(section: Section, policy: SubagentPromptPolicy): string | null {
  const kept: string[] = []
  for (const rule of splitRules(section.body)) {
    if (DROP_RULES.has(rule.name)) continue
    if (WRITE_ONLY_RULES.has(rule.name) && !policy.writeCapable) continue
    if (rule.name === 'evidence-scope') { kept.push(trimEvidenceScope(rule, policy)); continue }
    if (rule.name === 'test-harness') {
      const harness = trimTestHarness(rule, policy)
      if (harness) kept.push(harness)
      continue
    }
    kept.push(rule.full)
  }
  if (kept.length === 0) return null
  return `<rules>\n${kept.join('\n\n')}\n\n</rules>`
}

/**
 * Build the lean sub-agent system prompt from the shared BASE_PROMPT.
 *
 * `base` is passed in rather than imported to keep static.ts → static-subagent.ts
 * a one-way dependency.
 */
export function buildSubagentSystemPrompt(base: string, tools: ToolDefinition[]): string {
  const policy = derivePolicy(tools)
  const { sections, trailer } = parsePrompt(base)
  const out: Array<{ section: Section; text: string }> = []
  for (const section of sections) {
    if (DROP_SECTIONS.has(section.name)) continue
    const gate = TOOL_GATED_SECTIONS.get(section.name)
    if (gate && !gate(policy.tools)) continue
    if (section.name === 'rules') {
      const rules = composeRules(section, policy)
      if (rules) out.push({ section, text: rules })
      continue
    }
    if (section.name === 'tool-usage') { out.push({ section, text: trimToolUsage(section, policy.tools) }); continue }
    if (section.name === 'identity') { out.push({ section, text: trimIdentity(section) }); continue }
    out.push({ section, text: section.full })
  }
  return out.map(({ section, text }, index) => (index === 0 ? '' : section.separatorBefore) + text).join('') + trailer
}
