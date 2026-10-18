/**
 * 账户类查询（余额 / 平台摘要 / 成本）的凭据解析——多 key 池感知（issue #392）。
 *
 * 旧行为：`GET /config/balance` 等三条路由只读默认 provider 的顶层 apiKey/apiKeyEnv。
 * A′ 迁移后的多 key provider 顶层槽位全空（凭据在 keys[].keyRef → secrets.json），
 * 余额查询恒 null；未迁移形态下又永远只查同一个账户——第二个 key 的余额无从得知。
 *
 * 解析规则：
 * - 显式 keyId → 该 key 的三槽（keyRef/apiKey/apiKeyEnv，经 tryResolveCredentialKey，
 *   与请求端同链，含 `<PROVIDER>_API_KEY` 环境回退）；找不到 → 400（fail-closed，
 *   不悄悄回落到别的 key——查错账户比报错更糟）。'default' 是合法池 id（存量
 *   迁移的首个 key）；仅当 provider 无池时它指顶层三槽（对齐 pro
 *   provider-usage 服务的无池 keyId 约定）。
 * - 省略 keyId → keys 池非空且顶层无 keyRef/apiKey（A′ 迁移形态）→ 池主 key
 *   （defaultKeyOf，显式三槽解析）优先于顶层与 env 兜底——宿主残留的
 *   `<NAME>_API_KEY` 不得劫持用户显式配置的池凭据（PR #503 P1）；池主 key 落空
 *   再走顶层三槽（含 env 兜底，未迁移形态的历史行为）与池回退保底。
 * - provider 省略 → 默认 provider；显式给的 provider 不存在 → 400。
 */
import type { Config, ProviderConfig } from '../config/schema.js'
import { defaultKeyOf, DEFAULT_KEY_ID } from '../config/provider-keys.js'
import { tryResolveCredentialKey, tryResolveExplicitCredentialKey } from '../api/factory.js'

export interface AccountCredential {
  /** undefined 仅出现在「隐式默认 provider 不存在」——路由据此返回 null 数据。 */
  provider?: ProviderConfig
  apiKey?: string
  /** 实际命中的 keyId（显式传入或池回退命中）；顶层槽形态为 undefined。 */
  keyId?: string
  /** 命中 key 的展示名（池成员才有）——路由回显给客户端确认账户身份。 */
  label?: string
}

export function resolveAccountCredential(
  cfg: Config,
  providerName?: string,
  keyId?: string,
): AccountCredential | { error: string } {
  const name = providerName ?? cfg.provider.default
  const provider = cfg.provider.providers[name]
  if (!provider) {
    // 隐式默认缺失维持旧行为的「空数据」；显式指定不存在是调用方错误。
    return providerName === undefined ? {} : { error: `provider "${name}" not found` }
  }
  const resolve = (slots: { keyRef?: string; apiKey?: string; apiKeyEnv?: string }) =>
    tryResolveCredentialKey({ name, ...slots })
  // 显式凭据解析（无 <NAME>_API_KEY 兜底）：池形态守卫专用——「字段非空」≠
  // 「用户显式配置」，预设注入的 apiKeyEnv 与宿主残留 env 都不算池凭据。
  const resolveExplicit = (slots: { keyRef?: string; apiKey?: string; apiKeyEnv?: string }) =>
    tryResolveExplicitCredentialKey({ name, ...slots })
  if (keyId !== undefined) {
    // 池非空时按 id 查找——'default' 也是合法池 id（存量迁移的首个 key 就叫
    // 'default'，见 provider-keys.ts DEFAULT_KEY_ID）。池为空时 'default' 指顶层
    // 三槽（对齐 pro provider-usage 服务对无池 provider 的 keyId 约定）。
    if (provider.keys?.length) {
      const key = provider.keys.find(k => k.id === keyId)
      if (!key) return { error: `key "${keyId}" not found on provider "${name}"` }
      return { provider, apiKey: resolve(key), keyId, ...(key.label ? { label: key.label } : {}) }
    }
    return keyId === DEFAULT_KEY_ID
      ? { provider, apiKey: resolve(provider) }
      : { error: `provider "${name}" has no key pool (keyId "${keyId}")` }
  }
  // A′ 池形态回退：keys 池非空且顶层无 keyRef/apiKey 时，池主 key 优先于 env 兜底。
  // 故意不看 provider.apiKeyEnv——loadConfig 深合并会把预设自带的 apiKeyEnv
  // （如 deepseek 预设的 DEEPSEEK_API_KEY）注入顶层，字段非空 ≠ 用户显式配置；
  // 若把它算作显式凭据，宿主残留的 <NAME>_API_KEY 会越过用户配置的池主 key
  // 静默查错账户（PR #503 P1）。池形态下请求端本就只读 keys[0] 三槽（见
  // provider-keys.ts 脱钩注释），此处对齐。池主 key 解析落空则继续走顶层（含
  // env 兜底）——配置不完整时保底。
  if (provider.keys?.length && !provider.keyRef && !provider.apiKey) {
    const fallback = defaultKeyOf(provider)
    if (fallback) {
      const apiKey = resolveExplicit(fallback)
      if (apiKey) return { provider, apiKey, keyId: fallback.id, ...(fallback.label ? { label: fallback.label } : {}) }
    }
  }
  const topLevel = resolve(provider)
  if (topLevel) return { provider, apiKey: topLevel }
  const fallback = defaultKeyOf(provider)
  if (fallback) return { provider, apiKey: resolve(fallback), keyId: fallback.id, ...(fallback.label ? { label: fallback.label } : {}) }
  return { provider }
}
