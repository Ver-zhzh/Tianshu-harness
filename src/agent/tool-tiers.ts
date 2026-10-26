import type { ToolPreset } from '../tools/tool-preset-names.js'
/** Main-agent visibility only. Cold registration and worker permissions are independent. */

import type { StarDomain } from './star-domain.js'
import { applyDescriptionMode, type ToolDescriptionMode } from '../tools/description-compact.js'

/** 26 default tools plus optional browser/semantic tools controlled by assembly. */
export const CORE_TOOLS = [
  // 文件读写编辑
  'read_file',
  'write_file',
  'edit_file',
  'hash_edit',
  // 搜索导航
  'grep',
  'glob',
  'ast_grep',
  'semantic_search',
  'web_search',
  'web_fetch',
  'repo_map',
  // 执行
  'bash',
  'run_tests',
  'git',
  'todo',
  // 后台任务控制（bash run_in_background 的配套 await/logs/kill）
  'job',
  // 规划与交付
  'plan',
  'deliver_task',
  // 委派
  'delegate_task',
  'delegate_batch',
  // 记忆
  'memory',
  // 用户交互
  'ask_user_question',
  'ask_image',
  // 路径与技能（首调澄清/路径授权/技能加载依赖，static prompt 直接引用）
  'request_path_access',
  'skill',
  // 换视角方法论：static prompt L80 直接指示使用，必须常驻（与 skill 同源）
  'recall_capsule',
  'browser_debug',
  // Basic team stays available without the advanced orchestration preset.
  'team_orchestrate',
] as const

/**
 * EXTENDED 层 — 子代理可用，主控需 opt-in 或委派。
 * web/browser/doc/council/team/import/lsp/undo 等低频或重场景工具。
 */
export const ORCHESTRATION_TOOLS = ['galaxy', 'starflow', 'plan_task', 'council_convene'] as const
const FULL_MAIN_TOOLS = ['ast_edit', 'attack_case', 'cli_discover', 'monitor', 'recall_general', 'record_general_finding', 'session_vitals', 'update_goal', 'web_crawl', 'web_map'] as const
const SCHEDULE_TOOLS = ['schedule_create', 'schedule_list', 'schedule_delete'] as const

export const EXTENDED_TOOLS = [
  'galaxy',
  'starflow',
  'plan_task',
  ...FULL_MAIN_TOOLS,
  'git_scout',
  ...SCHEDULE_TOOLS,
  // browser（一次性 headless）与 browser_debug 能力重叠且默认未注册——退役候选。
  'browser',
  'computer_use',
  'repo_graph',
  // capability 能力索引（2026-07-31 装配）：只读查询本机 dev CLI 能力与缺口
  // （preflight），full 档注册。查询面低频——同 repo_graph/semantic_search
  // 定位，不占 CORE 常驻字节；主控需要时 /tools enable 挂回，worker 始终可用。
  'capability',
  'council_convene',
  'import_resource',
  'apply_patch',
  'undo',
  // 从 CORE 下放（2026-07-01）：低频或被现有工具覆盖的功能，
  // 主控默认不占视野，worker 仍可用、主控可 /tools enable 挂回。
  'read_section',    // read_file 的 offset/limit 已覆盖区间读取
  'diff',            // git 工具覆盖「working tree diff」
  'inspect_project', // 开局一次性定向，repo_map 已给结构；低频
  'related_tests',   // run_tests/grep/repo_map 覆盖；低频
  'file_info',       // bash(stat/ls/wc) 或 read_file 头部覆盖；低频
  'leave_mark',      // 会话结束留痕，消费方 constellation 默认关(opt-in)
  // skill_runtime（issue #523）：技能 Python 运行时（prepare/run 重审批、
  // 低频执行面）——worker 经域白名单可用，主控 /tools enable 挂回。
  'skill_runtime',
  // desktop tools (create_document, create_spreadsheet, etc.)
  'create_document',
  'create_spreadsheet',
  'create_image',
  'generate_image',
  'create_presentation',
  'create_pdf',
  'export_file',
  'open_path',
  'review_changes',
] as const

/** 所有已知工具名 — CORE ∪ EXTENDED */
export const ALL_KNOWN_TOOLS: readonly string[] = [...CORE_TOOLS, ...EXTENDED_TOOLS]

/** CORE 工具集合（O(1) 查找） */
const CORE_SET: ReadonlySet<string> = new Set(CORE_TOOLS)

/** EXTENDED 工具集合 */
const EXTENDED_SET: ReadonlySet<string> = new Set(EXTENDED_TOOLS)

/**
 * 解析主控应使用的工具层。
 *
 * @param domain 当前会话域（可选自定义 mainToolTier 覆盖）
 * @param configEnabled config.toolGating.enabled（默认 true）
 * @param coreOverride 可选的 config 级 CORE 覆盖清单
 * @returns 主控可见的工具名列表
 */
export function resolveMainToolTier(
  domain: Pick<StarDomain, 'mainToolTier'> | null | undefined,
  configEnabled: boolean = true,
  coreOverride?: readonly string[],
): readonly string[] {
  // 门控关闭 → 全量（不做过滤）
  if (!configEnabled) return ALL_KNOWN_TOOLS

  // 域级覆盖优先
  if (domain?.mainToolTier && domain.mainToolTier.length > 0) {
    return domain.mainToolTier
  }

  // config 级覆盖
  if (coreOverride && coreOverride.length > 0) {
    return coreOverride
  }

  // 默认 CORE
  return CORE_TOOLS
}

/**
 * 门控状态 — 描述一次 gateToolDefinitions 的全部输入。
 *
 * 语义分两档：
 *  - allow-list（域级 mainToolTier 或 config coreOverride 显式给定时）：只保留清单内工具，
 *    其余一律摘掉（用户显式接管，自负 MCP/LSP 被摘的后果）。
 *  - deny-list（默认）：只摘 EXTENDED_SET 内的工具，CORE 与一切未分类工具
 *    （MCP / LSP / 自定义注册）原样保留——避免误删用户显式装配的 MCP。
 * 两档都对 exempt（extraCore ∪ mountedExtras）放行。
 * disabledTools（config 级静态禁用）在最后施加，优先级高于一切豁免。 */
export interface ToolGatingState {
  /** config.toolGating.enabled。false → 不过滤，返回全集。 */
  enabled: boolean
  /** Frozen from the actual registry, not inferred from a mutable user config. */
  preset?: ToolPreset
  /** 域级 mainToolTier 覆盖（allow-list）。 */
  domainTier?: readonly string[]
  /** config.toolGating.coreTools 覆盖（allow-list）。 */
  coreOverride?: readonly string[]
  /** config.toolGating.extraCore — 永久挂回主控的 EXTENDED 工具。 */
  extraCore?: readonly string[]
  /** 运行时经 /tools enable 临时挂回的 EXTENDED 工具。 */
  mountedExtras?: readonly string[]
  /** config.toolGating.disabledTools — session 启动时生效，运行中不变（缓存约束）。 */
  disabledTools?: readonly string[]
  /** prompt.toolDescriptions —— compact 压缩超长描述，保留硬门禁行。
   *  放在门控里而不是各调用点，是为了让构造期与 updateTools() 天然共用
   *  同一变换：两处不一致会让 MCP 注册后的描述回弹、翻转前缀字节。 */
  toolDescriptions?: ToolDescriptionMode
}

/**
 * 主控工具门控的唯一过滤入口（构造期与 updateTools 共用）。
 *
 * @param allDefs 全量工具定义（kernel + interactive + MCP/LSP）
 * @param state   门控状态
 * @returns 过滤后的工具定义（不修改入参）
 */
export function gateToolDefinitions<T extends { name: string; description?: string }>(
  allDefs: readonly T[],
  state: ToolGatingState,
): T[] {
  const disabled = new Set(state.disabledTools ?? [])
  const describe = (defs: readonly T[]) => applyDescriptionMode(defs.filter(d => !disabled.has(d.name)), state.toolDescriptions)
  if (!state.enabled) return describe(allDefs)
  const explicit = new Set(state.extraCore ?? [])
  const allowList = state.domainTier?.length ? state.domainTier : state.coreOverride?.length ? state.coreOverride : null
  // A user allow-list is a boundary: preset defaults and runtime mounts never widen it.
  if (allowList) return describe(allDefs.filter(d => allowList.includes(d.name) || explicit.has(d.name)))
  const preset = state.preset ?? 'minimal'
  const defaults = preset === 'orchestration' ? [...ORCHESTRATION_TOOLS]
    : preset === 'full' ? [...ORCHESTRATION_TOOLS, ...FULL_MAIN_TOOLS, 'git_scout', ...SCHEDULE_TOOLS]
    : preset === 'taiyi' ? [...SCHEDULE_TOOLS] : preset === 'frontend' ? ['browser_debug'] : []
  const exempt = new Set<string>([...defaults, ...explicit, ...(state.mountedExtras ?? [])])
  return describe(allDefs.filter(d => !EXTENDED_SET.has(d.name) || exempt.has(d.name)))
}

export function toolMountRestriction(name: string, state: ToolGatingState): 'disabled' | 'restricted' | undefined {
  if (state.disabledTools?.includes(name)) return 'disabled'
  if (!state.enabled) return undefined
  const allow = state.domainTier?.length ? state.domainTier : state.coreOverride?.length ? state.coreOverride : null
  if (allow && !allow.includes(name) && !state.extraCore?.includes(name)) return 'restricted'
}

/** 判断工具是否在 CORE 层 */
export function isCoreTool(name: string): boolean {
  return CORE_SET.has(name)
}

/** 判断工具是否在 EXTENDED 层 */
export function isExtendedTool(name: string): boolean {
  return EXTENDED_SET.has(name)
}

/**
 * 不变量校验：mainToolTier ⊆ toolWhitelist
 * （主控不应有其 worker 调不到的工具）
 */
export function validateTierInvariant(
  mainToolTier: readonly string[],
  toolWhitelist: readonly string[],
): void {
  const whitelistSet = new Set(toolWhitelist)
  const violations = mainToolTier.filter(t => !whitelistSet.has(t))
  if (violations.length > 0) {
    throw new Error(
      `mainToolTier ⊆ toolWhitelist invariant violated: [${violations.join(', ')}] not in toolWhitelist`,
    )
  }
}
