/**
 * 会话工作区解析——issue #147 诉求 1 的单一判定来源。
 *
 * 落点规则（backward compatible）：`mode` 缺省 = 'explicit'，此时行为与改造前
 * 逐字节一致（落 process.cwd()）；只有在客户端显式声明 `default`/`scratch` 时
 * 才走配置或隔离目录。因此旧的 POST /sessions 调用方（不带 workspaceMode）不受影响。
 *
 * 纯函数：只做字符串判定，不 stat 目录、不落盘。目录创建与存在性校验留给调用方
 * （`managed=true` 时由 session-manager mkdir）。
 */
import { homedir } from 'node:os'
import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 创建会话时客户端声明的工作区意图。缺省 'explicit'。 */
export type SessionWorkspaceMode = 'explicit' | 'default' | 'scratch'

/** cwd 的来源——UI 据此明示「这个会话的工作目录是谁定的」。 */
export type WorkspaceSource = 'explicit' | 'config-default' | 'scratch' | 'runtime-default'

export interface ResolvedWorkspace {
  path: string
  source: WorkspaceSource
  /** true = 由天枢创建并管理（临时会话目录），调用方需 mkdir -p。 */
  managed: boolean
}

export interface SessionWorkspaceInput {
  /** 客户端显式指定的目录。非空即最高优先级。 */
  requested?: string
  /** 缺省 'explicit'。 */
  mode?: SessionWorkspaceMode
  /** config.workspace.defaultDir。 */
  configDefaultDir?: string
  /** 最后一道兜底（sidecar 的 defaultCwd，即 process.cwd()）。 */
  processCwd: string
  /** 临时会话隔离根目录，通常 sessionScratchRoot(rivetHome())。 */
  scratchRoot: string
  sessionId: string
  /** `~` 展开用的 home；缺省 os.homedir()（测试注入固定值以免依赖机器）。 */
  homeDir?: string
}

export function expandTilde(raw: string, home: string): string {
  if (raw === '~') return home
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(home, raw.slice(2))
  return raw
}

/** 空白字符串不算路径——'   ' 曾会让会话落到一个名为空格的目录。 */
function clean(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function resolveSessionWorkspace(input: SessionWorkspaceInput): ResolvedWorkspace {
  const home = input.homeDir ?? homedir()

  const requested = clean(input.requested)
  if (requested) {
    return { path: expandTilde(requested, home), source: 'explicit', managed: false }
  }

  const mode = input.mode ?? 'explicit'

  if (mode === 'scratch') {
    // 每会话一个子目录：并发临时会话互不踩踏，事后可整体删除。
    const key = clean(input.sessionId).slice(0, 8) || 'session'
    return { path: join(input.scratchRoot, key), source: 'scratch', managed: true }
  }

  if (mode === 'default') {
    const configured = clean(input.configDefaultDir)
    if (configured) {
      return { path: expandTilde(configured, home), source: 'config-default', managed: false }
    }
    // 配了 mode=default 但没配目录：fail-open 到旧行为，不让新建会话失败。
  }

  return { path: input.processCwd, source: 'runtime-default', managed: false }
}

/** 临时会话隔离根目录：<rivetHome>/workspace。 */
export function sessionScratchRoot(rivetHome: string): string {
  return join(rivetHome, 'workspace')
}

const SESSION_WORKSPACE_MODES: readonly SessionWorkspaceMode[] = ['explicit', 'default', 'scratch']

/** HTTP 层校验用：非法值应报 400，而不是被静默降级成旧行为。 */
export function isSessionWorkspaceMode(value: unknown): value is SessionWorkspaceMode {
  return typeof value === 'string' && (SESSION_WORKSPACE_MODES as readonly string[]).includes(value)
}

// ─────────────────────────────────────────────────────────────────────────────
// 带配置与落盘副作用的入口（session-manager 只留薄调用）
//
// 上一个是纯判定；这一个读配置、必要时建目录。放在本模块是为了守住
// src/server/session-manager.ts 的行数棘轮——那里的接线只剩参数传递。
// ─────────────────────────────────────────────────────────────────────────────

export interface SessionWorkspaceConfigLike {
  defaultDir?: string
  scratchDir?: string
}

export interface SessionWorkspaceRequest {
  requested?: string
  mode?: SessionWorkspaceMode
  /** sidecar 的 defaultCwd（= process.cwd()），同时是创建失败的回退。 */
  processCwd: string
  sessionId: string
  rivetHome: string
  /** 注入 loadConfig：既避免 server → config 的环，也让测试免于落真配置。 */
  readConfig: () => { workspace?: SessionWorkspaceConfigLike }
}

/**
 * 解析 + 必要时创建隔离目录。
 *
 * 配置读取失败按「未配置」处理（等价旧行为）；临时目录创建失败回落 defaultCwd
 * ——隔离目录的问题不该让新建会话失败，且 source 如实回退为 'runtime-default'
 * （UI 明示必须与事实一致，不能谎报 'scratch'）。config-default 的目录无效时
 * 同理回落（2026-09-15 审查跟进）——不落无效位置、不谎报来源。
 */
export function resolveSessionWorkspaceForSession(input: SessionWorkspaceRequest): ResolvedWorkspace {
  let wsConfig: SessionWorkspaceConfigLike = {}
  try {
    wsConfig = input.readConfig().workspace ?? {}
  } catch { /* 配置读取失败 → 未配置 */ }

  const resolved = resolveSessionWorkspace({
    requested: input.requested,
    mode: input.mode,
    configDefaultDir: wsConfig.defaultDir,
    processCwd: input.processCwd,
    scratchRoot: wsConfig.scratchDir ?? sessionScratchRoot(input.rivetHome),
    sessionId: input.sessionId,
  })
  if (!resolved.managed) {
    // config-default 的目录可能不存在（配置后目录被删/从未创建/路径写错）——
    // 运行时事实为准：无效落点按「未配置」对待，回落 processCwd 并如实报
    // runtime-default（桌面端的 defaultFellBack 警告据此触发）。谎报
    // config-default 会让会话落在无效位置，且用户以为配置已生效。
    if (resolved.source === 'config-default' && !isUsableDirectory(resolved.path)) {
      return { path: input.processCwd, source: 'runtime-default', managed: false }
    }
    return resolved
  }

  try {
    mkdirSync(resolved.path, { recursive: true })
    return resolved
  } catch {
    return { path: input.processCwd, source: 'runtime-default', managed: false }
  }
}

/** 目录可用性——statSync 区分「文件占了路径」与「目录可用」。 */
function isUsableDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
