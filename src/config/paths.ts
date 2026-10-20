/**
 * paths.ts — Unified runtime data path resolution.
 *
 * All code that needs to read or write under the user-level `.rivet/` tree
 * should go through this module instead of spelling out `join(homedir(), '.rivet', ...)`
 * directly. This is what makes custom storage locations (RIVET_HOME, desktop
 * launcher config, per-project overrides) possible.
 *
 * Resolution priority for the data root:
 *   1. process.env.RIVET_HOME
 *   2. desktop launcher.json rivetHome
 *   3. platform default (%LOCALAPPDATA%\.rivet on Windows, ~/.rivet elsewhere)
 *
 * Legacy per-path environment variables still win for their specific scope:
 *   - RIVET_SESSION_DIR
 *   - RIVET_DESKTOP_DIR / RIVET_DESKTOP_SESSION_DIR
 *   - RIVET_CONFIG_PATH
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { isolateTestSessionHome } from '../platform/test-session-isolation.js'

/** Platform default data root, ignoring RIVET_HOME. */
export function defaultRivetHome(): string {
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), '.rivet')
  }
  return join(homedir(), '.rivet')
}

/**
 * 桌面端 launcher.json 的路径——复刻 Tauri `app_config_dir()` 的跨平台规则。
 *
 * 桌面端「设置 → 存储」把用户选的存储位置写在这里，sidecar 由 Rust 侧注入
 * RIVET_HOME 所以自洽；而**用户手动在终端跑 CLI 时没有那层注入**，读不到
 * launcher.json 就会落到一个空目录（issue #525：26 个日志落点全部 exists=false）。
 */
export function launcherConfigPath(
  opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string } = {},
): string {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const home = opts.home ?? homedir()
  const identifier = 'app.tianshu.desktop'
  if (platform === 'win32') {
    const appData = env.APPDATA || join(home, 'AppData', 'Roaming')
    return join(appData, identifier, 'launcher.json')
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', identifier, 'launcher.json')
  }
  const xdg = env.XDG_CONFIG_HOME || join(home, '.config')
  return join(xdg, identifier, 'launcher.json')
}

/**
 * 读 launcher.json 的 rivetHome。
 *
 * 缺失/损坏/类型不对/空白一律 undefined——CLI 不能因为桌面端配置坏了就起不来。
 * 测试环境（NODE_TEST_CONTEXT）且未显式注入 launcherPath 时跳过：否则开发者
 * 机器上的桌面端配置会污染测试断言。
 */
export function launcherRivetHome(
  opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string; launcherPath?: string } = {},
): string | undefined {
  if (!opts.launcherPath && process.env.NODE_TEST_CONTEXT) return undefined
  try {
    const raw = readFileSync(opts.launcherPath ?? launcherConfigPath(opts), 'utf8')
    const parsed = JSON.parse(raw) as { rivetHome?: unknown }
    if (typeof parsed.rivetHome === 'string' && parsed.rivetHome.trim()) return parsed.rivetHome
  } catch { /* 未配置或损坏 = 回落平台默认 */ }
  return undefined
}

export type RivetHomeSource = 'RIVET_HOME' | 'launcher.json' | 'platform-default'

function selectRivetHome(env: NodeJS.ProcessEnv, launcherHome: string | undefined, platformDefault: string): { path: string; source: RivetHomeSource } {
  const fromEnv = env.RIVET_HOME?.trim()
  if (fromEnv) return { path: fromEnv, source: 'RIVET_HOME' }
  if (launcherHome) return { path: launcherHome, source: 'launcher.json' }
  return { path: platformDefault, source: 'platform-default' }
}

/** CLI 数据根优先级：RIVET_HOME > launcher.json > 平台默认。 */
export function pickRivetHome(env: NodeJS.ProcessEnv, launcherHome: string | undefined, platformDefault: string): string {
  return selectRivetHome(env, launcherHome, platformDefault).path
}

/** rivetHome 是每个路径解析都会走的热路径——launcher.json 只读一次。 */
let launcherHomeCache: string | null | undefined

/** 清空 launcher 缓存（测试用，同 resetRgResolvedPath 的约定）。 */
export function resetLauncherHomeCache(): void {
  launcherHomeCache = undefined
}

function cachedLauncherRivetHome(): string | undefined {
  if (launcherHomeCache === undefined) launcherHomeCache = launcherRivetHome() ?? null
  return launcherHomeCache ?? undefined
}

/**
 * Active data root: RIVET_HOME > 桌面端 launcher.json > 平台默认。
 *
 * 中间层是 issue #525 的修复：桌面端用户把存储位置改到自定义目录后，终端里
 * 的 CLI（`/logs`、会话目录、配置路径）必须看到同一个根，否则日志工具会
 * 静默输出一份全部 exists=false 的清单。
 */
export function rivetHome(): string {
  return resolveRivetHome().path
}

/** Keep diagnostic provenance on the same decision path as the active root. */
export function resolveRivetHome(): { path: string; source: RivetHomeSource } {
  return selectRivetHome(process.env, cachedLauncherRivetHome(), defaultRivetHome())
}

/** User global config file path. */
export function userConfigPath(): string {
  const fromEnv = process.env.RIVET_CONFIG_PATH
  if (fromEnv) return fromEnv

  const home = rivetHome()
  const candidate = join(home, 'config.json')

  // If the user pointed RIVET_HOME at a new location but there is no config
  // there yet, warn that the old default config still exists. Without this
  // the UI would silently look empty (no providers, no API keys).
  if (!process.env.NODE_TEST_CONTEXT && process.env.RIVET_HOME && !existsSync(candidate)) {
    const legacyPath = join(defaultRivetHome(), 'config.json')
    if (existsSync(legacyPath)) {
      process.stderr.write(
        `[rivet] RIVET_HOME is set to ${home}, but config.json is missing there.\n` +
        `  The previous config is still at ${legacyPath}.\n` +
        `  Use the desktop Settings > Storage page to migrate, or copy the file manually.\n`
      )
    }
  }

  return candidate
}

/**
 * Convert a cwd into a filesystem-safe session directory slug.
 *
 * Shape: `<basename>-<hash6>`. The hash is computed from the full cwd so
 * different projects never collide.
 *
 * Cross-platform safety (Windows was hit by ENOENT here before):
 *  - Split on both `/` and `\` so `D:\tianshu\proj` does not use the whole
 *    path as the basename (the `D:` colon is illegal in NTFS directory names).
 *  - Sanitize NTFS illegal characters (`\ / : * ? " < > |` and control chars)
 *    to `_`.
 *
 * Backward compatibility: POSIX paths have no `\`, so the split behaves like
 * the old `split('/')`; basenames do not contain illegal chars, so sanitizing
 * is a no-op. Existing macOS/Linux session directory names stay unchanged.
 */
function sanitizePathSegment(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/^_+|_+$/g, '')
  return cleaned || 'unknown'
}

export function projectSlug(cwd: string): string {
  const name = cwd.split(/[\\/]/).filter(Boolean).pop() || 'unknown'
  const safeName = sanitizePathSegment(name)
  // Canonicalize cwd before hashing: on Windows, D:\Proj and d:\proj must
  // produce the same slug (filesystem is case-insensitive + separator-agnostic).
  // toPosixPath normalizes separators; platform-specific lowercasing mirrors
  // canonicalPathKey's policy.
  const canonicalCwd = process.platform === 'win32'
    ? cwd.replaceAll('\\', '/').toLowerCase()
    : cwd
  const hash = createHash('sha256').update(canonicalCwd).digest('hex').slice(0, 6)
  return `${safeName}-${hash}`
}

/** Session directory for a project. Honors RIVET_SESSION_DIR. */
export function sessionsDir(cwd?: string): string {
  if (process.env.RIVET_SESSION_DIR) return process.env.RIVET_SESSION_DIR
  if (cwd) return join(rivetHome(), 'sessions', projectSlug(cwd))
  return join(rivetHome(), 'sessions')
}

/** Desktop sidecar data root. Honors RIVET_DESKTOP_DIR. */
export function desktopDir(): string {
  return process.env.RIVET_DESKTOP_DIR ?? join(rivetHome(), 'desktop')
}

/** Desktop sidecar session persistence directory. Honors RIVET_DESKTOP_SESSION_DIR. */
export function desktopSessionsDir(): string {
  return process.env.RIVET_DESKTOP_SESSION_DIR ?? join(desktopDir(), 'sessions')
}

/** Cross-session memory directory for a project hash. */
export function memoryDir(hash: string): string {
  return join(rivetHome(), 'memory', hash)
}

/** Checkpoint file path scoped by cwd slug. */
export function checkpointPath(slug: string): string {
  return join(rivetHome(), `checkpoint-${slug}.json`)
}

/** Per-workspace path grants file. */
export function pathGrantsPath(slug: string): string {
  return join(rivetHome(), `path-grants-${slug}.json`)
}

/**
 * Computer Use per-app grant file — machine-level (NOT per-project): once you
 * trust Codex-style GUI automation to drive an app, that trust spans sessions
 * and projects. `base` lets tests inject a temporary home without RIVET_HOME.
 */
export function computerUseGrantsPath(base?: string): string {
  return join(base ?? rivetHome(), 'computer-use-grants.json')
}

/**
 * CDP 浏览器域策略文件 —— 可选；缺省不存在 = 保持现有 allow 行为。
 * 形态见 src/pro/computer-use/browser-policy.ts（or 环境变量
 * RIVET_CU_BROWSER_POLICY 覆盖，JSON 同构）。
 */
export function computerUseBrowserPolicyPath(base?: string): string {
  return join(base ?? rivetHome(), 'computer-use-browser-policy.json')
}

/**
 * computer_use 动作审计日志（JSONL，仅元数据：action/app/耗时/结果/路由；
 * 不含输入文本、URL query、截图）。RIVET_CU_JOURNAL=0 可关闭。
 */
export function computerUseJournalPath(base?: string): string {
  return join(base ?? rivetHome(), 'computer-use-journal.jsonl')
}

/** Directory holding per-cwd last-session pointer files. */
export function lastSessionPointerDir(): string {
  return join(rivetHome(), 'last-session')
}

/** Session registry state directory. */
export function stateDir(): string {
  return join(rivetHome(), 'state')
}

/** TUI command history file. */
export function historyPath(): string {
  return join(rivetHome(), 'history.json')
}

/** Update-check cache file. */
export function updateCheckPath(): string {
  return join(rivetHome(), 'update-check.json')
}

/**
 * Token 消耗台账状态文件（跨会话全局）：累计 day×model 聚合 + 各 cache-log
 * 消费游标 + 论坛推送回执。`base` 供测试注入临时 home，不设 RIVET_HOME。
 */
export function tokenLedgerStatePath(base?: string): string {
  return join(base ?? rivetHome(), 'token-ledger.json')
}

/**
 * /connect wizard draft — unfinished provider setup, saved on Esc and offered
 * for resume next time. Never holds a plaintext key: only a keyRef into
 * secrets.json. TTL/cleanup is owned by the reader. `base` lets tests inject
 * a temporary home without RIVET_HOME.
 */
export function connectDraftPath(base?: string): string {
  return join(base ?? rivetHome(), 'connect-draft.json')
}

/** Directory for durable claims exports from slash commands. */
export function exportsDir(): string {
  return join(rivetHome(), 'exports')
}

/**
 * Directory for persisted subagent/worker session data.
 *
 * `base` lets tests inject a temporary home without relying on RIVET_HOME.
 */
export function subagentsDir(base?: string): string {
  return join(base ?? rivetHome(), 'subagents')
}

/**
 * Directory for user-global workflow definitions.
 *
 * `base` lets tests inject a temporary home without relying on RIVET_HOME.
 */
export function workflowsDir(base?: string): string {
  return join(base ?? rivetHome(), 'workflows')
}

/**
 * Directory for user-global plan templates.
 *
 * `base` lets tests inject a temporary home without relying on RIVET_HOME.
 */
export function planTemplatesDir(base?: string): string {
  return join(base ?? rivetHome(), 'plan-templates')
}

isolateTestSessionHome(defaultRivetHome())
