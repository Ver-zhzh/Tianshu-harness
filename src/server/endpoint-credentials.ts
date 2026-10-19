import { loadConfig } from '../config/manager.js'
import { assertEnvironmentOrigin } from './endpoint-network-input.js'

/**
 * 服务端配置文件中已声明的环境变量密钥名集合
 * （provider.apiKeyEnv / provider.keys[].apiKeyEnv）。
 * 试画/探测类端点只允许解析这些名字——见 parseImageGenRequest 的安全边界注释。
 */
function declaredKeyEnvs(): Set<string> {
  const names = new Set<string>()
  const providers = loadConfig().provider.providers ?? {}
  for (const provider of Object.values(providers)) {
    if (typeof provider.apiKeyEnv === 'string' && provider.apiKeyEnv) names.add(provider.apiKeyEnv)
    for (const key of provider.keys ?? []) {
      if (typeof key.apiKeyEnv === 'string' && key.apiKeyEnv) names.add(key.apiKeyEnv)
    }
  }
  return names
}

interface ParsedImageGenRequest {
  baseUrl: string
  modelId: string
  providerName?: string
  /** 用于真测请求的实际 key（apiKey 或由 apiKeyEnv 解析而来）。 */
  apiKey?: string
  /** 原样透传给 registerImageGenModelConfig 的凭据字段。 */
  rawApiKey?: string
  rawApiKeyEnv?: string
  sizeField?: 'size' | 'image_size'
  error?: string
}

/**
 * 生图 provider 的凭据/参数解析。apiKey 与 apiKeyEnv 互斥；真测需要**实际**的
 * key，仅真测在验证声明与 origin 后解析 apiKeyEnv；保存操作只保留变量名。
 */
export function parseImageGenRequest(body: unknown, options: { requireProviderName?: boolean; envPolicy?: 'reject-undeclared' } = {}): ParsedImageGenRequest {
  const record = (body ?? {}) as Record<string, unknown>
  const baseUrl = typeof record.baseUrl === 'string' ? record.baseUrl.trim() : ''
  const modelId = typeof record.modelId === 'string' ? record.modelId.trim() : ''
  const providerName = typeof record.providerName === 'string' ? record.providerName.trim() : undefined
  const apiKey = typeof record.apiKey === 'string' ? record.apiKey.trim() : undefined
  const apiKeyEnv = typeof record.apiKeyEnv === 'string' ? record.apiKeyEnv.trim() : undefined
  const sizeField = record.sizeField === 'size' || record.sizeField === 'image_size' ? record.sizeField : undefined

  if (!baseUrl) return { baseUrl: '', modelId, error: 'baseUrl is required' }
  if (!modelId) return { baseUrl, modelId: '', error: 'modelId is required' }
  if (options.requireProviderName && !providerName) return { baseUrl, modelId, error: 'providerName is required' }
  if (apiKey && apiKeyEnv) return { baseUrl, modelId, error: 'Use either apiKey or apiKeyEnv, not both.' }
  if (options.envPolicy === 'reject-undeclared' && apiKeyEnv && !declaredKeyEnvs().has(apiKeyEnv)) {
    return { baseUrl, modelId, error: `Environment variable "${apiKeyEnv}" is not declared in the saved provider configuration` }
  }

  if (options.envPolicy && apiKeyEnv) assertEnvironmentOrigin(apiKeyEnv, baseUrl)
  const resolvedKey = apiKey ?? (options.envPolicy && apiKeyEnv ? process.env[apiKeyEnv] : undefined)
  return {
    baseUrl,
    modelId,
    ...(providerName ? { providerName } : {}),
    ...(resolvedKey ? { apiKey: resolvedKey } : {}),
    ...(apiKey ? { rawApiKey: apiKey } : {}),
    ...(apiKeyEnv ? { rawApiKeyEnv: apiKeyEnv } : {}),
    ...(sizeField ? { sizeField } : {}),
  }
}
interface ParsedVisionCredentials {
  baseUrl?: string
  providerName?: string
  apiKey?: string
  apiKeyEnv?: string
  error?: string
}

/** Resolve only nonblank credential input; env values never leave this boundary.
 * 安全边界：'reject-undeclared'（discover）拒绝一切未在服务端配置中声明的变量名；
 * 'no-resolve-undeclared'（onboard）允许声明新变量名，但本次校验不解析它——
 * 否则调用方可让服务端读出任意环境变量并以密钥发往自选的 baseUrl（机密外泄原语）。 */
export function parseVisionCredentials(
  body: unknown,
  options: { envPolicy?: 'reject-undeclared' | 'no-resolve-undeclared' } = {},
): ParsedVisionCredentials {
  const { baseUrl, providerName, apiKey, apiKeyEnv } = (body ?? {}) as Record<string, unknown>
  if (baseUrl !== undefined && typeof baseUrl !== 'string') return { error: 'baseUrl must be a string' }
  if (providerName !== undefined && typeof providerName !== 'string') return { error: 'providerName must be a string' }
  if (apiKey !== undefined && typeof apiKey !== 'string') return { error: 'apiKey must be a string' }
  if (apiKeyEnv !== undefined && typeof apiKeyEnv !== 'string') return { error: 'apiKeyEnv must be a string' }

  const normalizedKey = typeof apiKey === 'string' ? apiKey.trim() : undefined
  const normalizedEnv = typeof apiKeyEnv === 'string' ? apiKeyEnv.trim() : undefined
  if (apiKey !== undefined && !normalizedKey) return { error: 'apiKey must not be blank' }
  if (apiKeyEnv !== undefined && !normalizedEnv) return { error: 'apiKeyEnv must not be blank' }
  if (normalizedKey && normalizedEnv) return { error: 'apiKey and apiKeyEnv cannot both be set' }
  if (normalizedEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalizedEnv)) {
    return { error: 'apiKeyEnv must be a valid environment variable name' }
  }
  if (options.envPolicy && normalizedEnv && !declaredKeyEnvs().has(normalizedEnv)) {
    if (options.envPolicy === 'reject-undeclared') {
      return { error: `Environment variable "${normalizedEnv}" is not declared in the saved provider configuration` }
    }
    // 'no-resolve-undeclared'：新变量名只做持久化，本次校验不携带解析出的密钥。
    return {
      ...(typeof baseUrl === 'string' && baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      ...(typeof providerName === 'string' && providerName.trim() ? { providerName: providerName.trim() } : {}),
      apiKeyEnv: normalizedEnv,
    }
  }
  if (normalizedEnv && typeof baseUrl === 'string') assertEnvironmentOrigin(normalizedEnv, baseUrl)
  const resolvedKey = normalizedKey ?? (normalizedEnv ? process.env[normalizedEnv]?.trim() : undefined)
  if (normalizedEnv && !resolvedKey) return { error: `Environment variable "${normalizedEnv}" is not set or is blank in the server process` }
  return {
    ...(typeof baseUrl === 'string' && baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
    ...(typeof providerName === 'string' && providerName.trim() ? { providerName: providerName.trim() } : {}),
    ...(resolvedKey ? { apiKey: resolvedKey } : {}),
    ...(normalizedEnv ? { apiKeyEnv: normalizedEnv } : {}),
  }
}
