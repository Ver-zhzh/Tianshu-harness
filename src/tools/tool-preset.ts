import { TOOL_PRESET_NAMES, type ToolPreset } from './tool-preset-names.js'
export type { ToolPreset } from './tool-preset-names.js'
import { existsSync, readFileSync } from 'node:fs'
import { findProjectConfig } from '../config/manager.js'
import { userConfigPath } from '../config/paths.js'
// 叶模块（0 import），仅取域内置档位默认，无循环依赖。
import { STAR_DOMAINS } from '../agent/star-domain-data.js'

/**
 * Session-start assembly and main-agent visibility are separate.
 * CLI baseline (registered / main; excludes MCP, desktop office and forced extras):
 * minimal 36 / 26; frontend 37 / 27; orchestration 36 / 30;
 * full 56 / 43; taiyi 14 / 13 (frozen evaluation baseline).
 *
 * Minimal retains basic delegation, team and assistant capabilities. Advanced
 * orchestration remains cold-registered for explicit activation; orchestration
 * exposes galaxy/starflow/plan_task/council_convene at session start.
 * With a real scheduler, registration adds three tools. Their default main
 * visibility is limited to full and taiyi; other presets opt in explicitly.
 *
 * Precedence: env > project preset > project domain preset > user preset >
 * user domain preset > domain built-in > minimal. Existing sessions stay frozen.
 */

const VALID = new Set<string>(TOOL_PRESET_NAMES)

function parsePreset(raw: unknown): ToolPreset | null {
  return typeof raw === 'string' && VALID.has(raw) ? (raw as ToolPreset) : null
}

const memo = new Map<string, ToolPreset>()

/**
 * 解析工具档位。`domainId`（config.agent.defaultDomain，装配期静态值）非空时，
 * 域相关档位按两级参与解析（均低于 RIVET_TOOL_PRESET env 与同文件 tools.preset）：
 * ① 项目/用户配置 `runtime.domains[domainId].toolPreset`（显式域档）；
 * ② 域定义内置默认（`STAR_DOMAINS[domainId].toolPreset`，如 taiyi 域内置 taiyi 档）。
 * 完整优先级见文件头注释。运行期 /domain 切换不改档位（装配已过，改指纹=前缀重建）。
 */
export function resolveToolPreset(cwd: string, domainId?: string): ToolPreset {
  const key = domainId ? `${cwd}\u0000${domainId}` : cwd
  const cached = memo.get(key)
  if (cached) return cached

  let preset: ToolPreset | null = parsePreset(process.env.RIVET_TOOL_PRESET)

  if (!preset) {
    const projectPath = findProjectConfig(cwd)
    if (projectPath && existsSync(projectPath)) {
      try {
        const raw = JSON.parse(readFileSync(projectPath, 'utf-8')) as {
          tools?: { preset?: unknown }
          runtime?: { domains?: Record<string, { toolPreset?: unknown }> }
        }
        preset = parsePreset(raw.tools?.preset)
        if (!preset && domainId) {
          preset = parsePreset(raw.runtime?.domains?.[domainId]?.toolPreset)
        }
      } catch { /* malformed project config — fall through */ }
    }
  }

  if (!preset) {
    // 必须与写侧同源（saveToolPresetConfig → userConfigPath）。用
    // defaultRivetHome() 会漏掉 RIVET_HOME/RIVET_CONFIG_PATH——桌面端便携模式
    // 与自定义存储路径下设置页写的档位就永远读不回来，UI 显示已保存却无效。
    const userPath = userConfigPath()
    if (existsSync(userPath)) {
      try {
        const raw = JSON.parse(readFileSync(userPath, 'utf-8')) as {
          tools?: { preset?: unknown }
          runtime?: { domains?: Record<string, { toolPreset?: unknown }> }
        }
        preset = parsePreset(raw.tools?.preset)
        if (!preset && domainId) {
          preset = parsePreset(raw.runtime?.domains?.[domainId]?.toolPreset)
        }
      } catch { /* malformed user config — fall through */ }
    }
  }

  // 域内置默认档（star-domain-data toolPreset 字段）：仅在 env/项目/用户均未
  // 显式给档时生效。domainId 可能是 'auto' 或自定义域 id——查不到自然落兜底。
  if (!preset && domainId) {
    preset = parsePreset((STAR_DOMAINS as Record<string, { toolPreset?: unknown }>)[domainId]?.toolPreset)
  }

  // 默认档 minimal（2026-09-23 起为发版默认，取代 frontend；对齐 3.14 线）。
  // lean 的 tools aspect 自此与默认同值，不再单独参与解析。
  const resolved = preset ?? 'minimal'
  memo.set(key, resolved)
  return resolved
}

/** Drop the per-cwd memo (settings changed / tests) so the next session
 *  resolves the preset fresh. Long-lived processes (desktop sidecar) must
 *  call this after persisting a preset change. */
export function invalidateToolPreset(): void {
  memo.clear()
}

/** Test-only: drop the per-cwd memo so env/config edits take effect. */
export function __resetToolPresetForTest(): void {
  invalidateToolPreset()
}

/** minimal 排除名单（kernel + bootstrap 统一）。full 全集；frontend 仅加
 *  browser_debug。判断逻辑见 presetIncludes。 */
const MINIMAL_EXCLUDES: ReadonlySet<string> = new Set([
  // 编排（重 + 日常低频）。team_orchestrate 2026-07-29 移除——它是唯一
  // 多 worker 波次编排入口，主控必须可见（T3 修复：随 tool-tiers 升入 CORE）。
  // browser 系
  'browser_debug',
  // 重而冷门 / 零使用（2026-07-19 会话使用率审计）
  'attack_case',
  'semantic_search',
  'repo_graph',
  'undo',
  'recall_general',
  'record_general_finding',
  'ast_edit',
  'related_tests',
  'inspect_project',
  'import_resource',
  'leave_mark',
  // 2026-07-22 minimal 再瘦身（会话日志使用率实测验证）：极低频工具
  'file_info',
  'session_vitals',
  'update_goal',
  // monitor 事件订阅（full 档专属——引导模型改干等为订阅的进阶能力）
  'monitor',
  // capability 能力索引（查询面低频，full 档专属——同 repo_graph/semantic_search；
  // RIVET_CAPABILITY=1 可单独强制开启）
  'capability',
  // cli_discover CLI 能力发现与安装（安装动作审批硬闸门，full 档专属；
  // RIVET_CLI_DISCOVER=1 可单独强制开启）
  'cli_discover',
  // 整站爬取/发现（重 + 非常用；RIVET_WEB_CRAWL/RIVET_WEB_MAP=1 可单独强制开启）
  'web_crawl',
  'web_map',
])

/** taiyi 评测档专属排除：bootstrap 侧无条件注册的编排/辅助工具，均不在
 *  14 核心集内。此前 bootstrap 层完全未按 taiyi 门控（2026-08-07 侦察确认
 *  实装远多于设计的最小集），本清单 + bootstrap 的 presetIncludes 调用点补上闭环。
 *  minimal/frontend/full 不受影响（这些名字不在 MINIMAL_EXCLUDES，
 *  三档语义与改动前逐字一致）。
 *
 *  2026-10-09 补 `memory`：它在 bootstrap.ts / serve-agent.ts 两处无条件注册，
 *  不在任何档位门控里——注释写「memory 已移出本档」、测试也以为「排除走
 *  default-registry 的 kernel 守卫」，但 default-registry 根本没有 memory，
 *  于是 taiyi 实装 15 件而文档写 14。两个注册点已同步加门控。 */
const TAIYI_EXCLUDES: ReadonlySet<string> = new Set([
  'council_convene',
  'review_changes',
  'delegate_task',
  'delegate_batch',
  'galaxy',
  'starflow',
  'team_orchestrate',
  'plan_task',
  'apply_patch',
  'recall_capsule',
  'ask_user_question',
  'memory',
])

/** 判断某工具在给定档位下是否注册。 */
export function presetIncludes(preset: ToolPreset, toolName: string): boolean {
  if (preset === 'full') return true
  if (preset === 'taiyi' && TAIYI_EXCLUDES.has(toolName)) return false
  if (preset === 'frontend' && toolName === 'browser_debug') return true
  // taiyi 与 minimal 在此层其余语义一致（冷工具由主控分层控制）；kernel 侧
  // taiyi 另有 8 个 `preset !== 'taiyi'` 守卫（default-registry）。
  return !MINIMAL_EXCLUDES.has(toolName)
}
