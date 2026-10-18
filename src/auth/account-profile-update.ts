import { accountApiBase, accountHeaders, HTTP_TIMEOUT_MS, type FetchInjection } from './account.js'

export interface AccountProfileUpdate { name: string; avatar?: string | null }

/**
 * 头像以 base64 内联在请求体里（上限 192KB），弱网直连上传时 10s 经常不够；
 * 不带头像的小请求维持原超时。
 */
const AVATAR_TIMEOUT_MS = 30_000

/**
 * 覆盖写幂等：连接重置 / 超时 / 上游 5xx 后重试一次是安全的。
 * 4xx 是明确拒绝（鉴权、参数），重试无意义。
 */
const MAX_ATTEMPTS = 2
const RETRY_DELAY_MS = 800

export interface AccountProfileUpdateOptions extends FetchInjection {
  /** 测试注入 0 避免真实等待。 */
  retryDelayMs?: number
}

export async function updateAccountProfile(accessToken: string, input: AccountProfileUpdate, opts: AccountProfileUpdateOptions = {}): Promise<{ ok: boolean; error?: string }> {
  const doFetch = opts.fetchImpl ?? fetch
  const timeoutMs = input.avatar !== undefined ? AVATAR_TIMEOUT_MS : HTTP_TIMEOUT_MS
  const retryDelay = opts.retryDelayMs ?? RETRY_DELAY_MS
  for (let attempt = 1; ; attempt++) {
    const lastAttempt = attempt >= MAX_ATTEMPTS
    try {
      const response = await doFetch(`${accountApiBase()}/functions/v1/tui-account-profile-update`, {
        method: 'POST', headers: { ...accountHeaders(), Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(input), signal: AbortSignal.timeout(timeoutMs),
      })
      let body: { ok?: boolean; error?: string }
      try { body = await response.json() as typeof body }
      catch (error) {
        if (response.status >= 400 && response.status < 500) return { ok: false, error: 'profile_update_failed' }
        throw error
      }
      if (response.ok && body.ok === true) return { ok: true }
      if (!lastAttempt && response.status >= 500) {
        await new Promise(resolve => setTimeout(resolve, retryDelay))
        continue
      }
      return { ok: false, error: body.error || 'profile_update_failed' }
    } catch {
      if (lastAttempt) return { ok: false, error: 'profile_update_unavailable' }
      await new Promise(resolve => setTimeout(resolve, retryDelay))
    }
  }
}
