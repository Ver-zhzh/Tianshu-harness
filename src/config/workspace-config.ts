/**
 * 工作区配置读写（issue #147）——从 src/config/manager.ts 外移，守住该文件的行数
 * 棘轮（scripts/source-budgets.manifest.json）。语义与 greeting/mirror 等配置面同族：
 * 读 = loadConfig().workspace，写 = 落用户全局 config.json。
 */
import { loadConfig, saveConfig } from './manager.js'
import { rivetHome } from './paths.js'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'
import { isProtectedDirectory } from '../server/workspace-roots.js'
import { expandTilde } from '../server/workspace.js'

export interface WorkspaceConfigSnapshot {
  /** 未指定目录的新会话落点；null = 未配置。 */
  defaultDir: string | null
  /** 临时会话隔离根目录覆盖；null = 用 <rivetHome>/workspace。 */
  scratchDir: string | null
}

/** 桌面端设置页读取。空配置 = 两个字段都 null，即「保持改造前行为」。 */
export function getWorkspaceConfig(): WorkspaceConfigSnapshot {
  const ws = loadConfig().workspace ?? {}
  return {
    defaultDir: ws.defaultDir ?? null,
    scratchDir: ws.scratchDir ?? null,
  }
}

/** 大小写不敏感文件系统的规范形（Windows 等）——同一目录的两种写法必须同判。 */
function canonical(p: string): string {
  const abs = resolve(p)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

/**
 * `scratchDir` 是「临时会话隔离根」：`POST /scratch/cleanup` 会递归删除它下面的
 * 直接子目录（见 scratch-cleanup.ts 的 resolveScratchRoot + removeScratchEntries）。
 * 数据根之内任意位置都可以，但不能是数据根本身（那会让清理打到 sessions/、
 * config.json 这些数据根的直接子项），也不能逃到数据根之外——否则任何能写配置
 * 的一方都能指定删除目标（issue #223）。
 *
 * @throws Error —— 路由层（workspace-route.ts 的 PUT /config/workspace）转 400。
 */
export function assertScratchDirInDataRoot(dir: string): void {
  const home = canonical(rivetHome())
  const target = canonical(dir)
  const rel = relative(home, target)
  if (rel === '') {
    throw new Error('Invalid "scratchDir" — must be a subdirectory of the Rivet data root, not the data root itself')
  }
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Invalid "scratchDir" — must live inside the Rivet data root (${rivetHome()})`)
  }
}

/**
 * `defaultDir` 未校验 → 已注册工作区投毒（2026-10-12 安全审计）。
 *
 * `registeredWorkspaces()`（workspace-guard.ts，issue #221 守卫的 allowlist
 * 来源之一）把 defaultDir 直接纳入"已注册工作区"，进而放行 /project-docs、
 * /project-templates/*、/project/trust 等路由的 cwd 参数。defaultDir 零校验 =
 * 任何能写配置的一方（Bearer 鉴权 ≠ 用户同意，见 #221）都能把任意目录
 * （如 /etc）注册进来，绕过 #221 守卫：PUT /project-docs {cwd:"/etc"} 可往
 * /etc 写 AGENTS.md，POST /project/trust {cwd:"/etc"} 可自我授信；mode=default
 * 的新会话也会落进去。与 scratchDir 的 assertScratchDirInDataRoot
 * （issue #223）同族缺口。
 *
 * 只拦系统保护目录（与 validateWorkspaceRoots 同一名单）：普通目录仍视为
 * 用户意图，不做存在性等限制，保持最小改动。
 *
 * @throws Error —— 路由层（workspace-route.ts 的 PUT /config/workspace）转 400。
 */
function assertDefaultDirSafe(dir: string): void {
  // 审查 L2：复用 server/workspace.ts 的 expandTilde 单一实现，避免两处 ~ 语义
  // 长期手工同步（它一改、这里就漂移，校验与真实落点会分家）。
  const expanded = expandTilde(dir, homedir())
  if (isProtectedDirectory(expanded)) {
    throw new Error('Invalid "defaultDir" — system-protected folder cannot be a workspace')
  }
  // 审查 M1：上面只按字面路径查名单，`~/mylink → /etc` 这类 symlink 的名字
  // 不像受保护目录，会被放行，落点却仍是 /etc。路径存在时用 realpath 解析后
  // 再判一次，与 validateWorkspaceRoots（先 realpathSync 再判）的强度对齐。
  // 仍不做存在性限制：路径不存在时跳过（悬空 symlink 逃逸不到受保护目录）。
  if (existsSync(expanded) && isProtectedDirectory(realpathSync(expanded))) {
    throw new Error('Invalid "defaultDir" — system-protected folder cannot be a workspace')
  }
}

/**
 * 写入用户全局配置——**部分更新语义**（2026-09-15 审查跟进）：
 *   undefined = 不改该字段（设置页每个控件独立提交，漏传 ≠ 清除）；
 *   null / 空白字符串 = 清除该字段（回到旧行为）；
 *   非字符串值抛错（HTTP 层转 400），不静默忽略——静默忽略会让用户以为已保存。
 * 曾是整体替换：桌面端只传 defaultDir 的 PUT 会把已配置的 scratchDir 静默清掉
 * ——而它没有 UI 编辑入口，被清后无法自助恢复。
 */
export function setWorkspaceConfig(input: { defaultDir?: unknown; scratchDir?: unknown }): WorkspaceConfigSnapshot {
  const readPath = (value: unknown, field: string): string | undefined => {
    if (value === null) return undefined
    if (typeof value !== 'string') throw new Error(`Invalid "${field}" — expected a path string or null`)
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  const cfg = loadConfig()
  const next = { ...(cfg.workspace ?? {}) }
  if (input.defaultDir !== undefined) {
    const v = readPath(input.defaultDir, 'defaultDir')
    if (v) {
      assertDefaultDirSafe(v)
      next.defaultDir = v
    }
    else delete next.defaultDir
  }
  if (input.scratchDir !== undefined) {
    const v = readPath(input.scratchDir, 'scratchDir')
    if (v) {
      assertScratchDirInDataRoot(v)
      next.scratchDir = v
    } else delete next.scratchDir
  }
  cfg.workspace = next
  saveConfig(cfg)
  return getWorkspaceConfig()
}
