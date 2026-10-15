import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TokenData } from './token-store.js'
/**
 * 官方 Codex CLI 登录态的一次性导入（~/.codex/auth.json → 我们的 token store）。
 *
 * 背景：官方 Codex CLI 与本运行时的 Codex provider 走同一个 OpenAI 账号体系
 * （chatgpt.com/backend-api/codex 接受同一种 bearer），但两套 token store 互不
 * 相通——本机明明已用官方 CLI 登录过 ChatGPT，我们却还要用户再走一次 PKCE。
 * 这里把官方 CLI 的 access/refresh token 映射成 TokenData：**只读源文件，绝不
 * 修改或删除**（那是另一个应用的家）；导入成功即落我们自己的加密 store，
 * 之后各走各的续期。
 *
 * 不做导入门禁（auth_mode 是 'apikey' 时 tokens 也可能残留可用）：判断依据只有
 * 「access_token 在、且能从 JWT 解出 exp」。
 */

/** 官方 CLI 的登录态文件路径（所有平台都在用户主目录；可用 RIVET_CODEX_CLI_AUTH 覆盖——测试与自定义安装用）。 */
export function codexCliAuthPath(env: Record<string, string | undefined> = process.env): string {
  const override = env.RIVET_CODEX_CLI_AUTH
  return override && override.trim() ? override : join(env.CODEX_HOME?.trim() || join(homedir(), '.codex'), 'auth.json')
}

/** Routing metadata only; the server still verifies the bearer credential. */
export function codexAccountId(...credentials: unknown[]): string | undefined {
  for (const credential of credentials) {
    if (typeof credential !== 'string') continue
    try {
      const part = credential.split('.')[1]
      if (!part) continue
      const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
      const account = claims?.['https://api.openai.com/auth']?.chatgpt_account_id
      if (typeof account === 'string' && account.trim()) return account
    } catch { /* Opaque credentials carry no locally readable routing metadata. */ }
  }
  return undefined
}

/** 从 JWT payload 解 exp（秒 → ms）；不是三段 JWT 或解不出 exp 返回 null。 */
function jwtExpiresAtMs(token: string): number | null {
  const parts = token.split('.')
  if (parts.length !== 3 || !parts[1]) return null
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    const exp = (payload as { exp?: unknown } | null)?.exp
    const n = typeof exp === 'number' ? exp : Number(exp)
    return Number.isFinite(n) && n > 0 ? n * 1000 : null
  } catch {
    return null
  }
}

/**
 * 读官方 Codex CLI 的登录态并映射为 TokenData。
 * 任一不合形（文件不存在 / JSON 坏 / 缺 access_token / exp 解不出）都返回 null——
 * 导入是 best-effort 的增益路径，绝不把畸形的来源写进 store。
 */
export function readCodexCliToken(env: Record<string, string | undefined> = process.env): TokenData | null {
  let raw: string
  try {
    raw = readFileSync(codexCliAuthPath(env), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    const tokens = (parsed as { tokens?: Record<string, unknown> } | null)?.tokens
    const accessToken = typeof tokens?.access_token === 'string' ? tokens.access_token : ''
    if (!accessToken) return null
    const expiresAt = jwtExpiresAtMs(accessToken)
    if (expiresAt === null) return null
    const refreshToken = typeof tokens?.refresh_token === 'string' && tokens.refresh_token ? tokens.refresh_token : undefined
    const accountId = typeof tokens?.account_id === 'string' && tokens.account_id ? tokens.account_id : undefined
    return {
      accessToken,
      expiresAt,
      ...(refreshToken ? { refreshToken } : {}),
      ...(accountId ? { accountId } : {}),
    }
  } catch {
    return null
  }
}

// ── 「登出后不再导入」标记 ─────────────────────────────────────────────
// 登出（clearOAuthLogin）只在我们的 store 上发生；官方 CLI 的登录态还在
// ~/.codex/auth.json 里。没有这个标记，下一次 loadWithImport 会把刚登出的账号
// 当场拉回来——登出永远无效。标记与 token 同目录（auth dir）， authenticate()
// 成功时摘除（用户主动重登 = 恢复导入许可）。
//
/** 导入抑制标记的路径：<authDir>/codex.import-skip。 */
export function codexCliImportSkipPath(authDir: string): string {
  return join(authDir, 'codex.import-skip')
}

export function isCodexCliImportSkipped(authDir: string): boolean {
  return existsSync(codexCliImportSkipPath(authDir))
}

/** 登出时调用：之后 loadWithImport 不再从官方 CLI 导入。 */
export function skipCodexCliImport(authDir: string): void {
  mkdirSync(authDir, { recursive: true })
  writeFileSync(codexCliImportSkipPath(authDir), new Date().toISOString(), 'utf8')
}

/** 登录成功时调用：恢复导入许可。 */
export function clearCodexCliImportSkip(authDir: string): void {
  try {
    unlinkSync(codexCliImportSkipPath(authDir))
  } catch { /* 本就不存在 */ }
}
