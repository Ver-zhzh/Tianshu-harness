import type { Config, ModelTarget } from '../config/schema.js'
import { rivetHome, userConfigPath } from '../config/paths.js'
import { modelBindingAvailability, type ModelBindingRef, type ModelUnavailableReason } from '../model/model-binding.js'

/**
 * 路由诊断（2026-10-24 收编公开仓 PR #37）。
 *
 * 背景：已保存的路由可以指向「当前池里不存在的模型」——设置页只显示保存成功，
 * 子代理要到派发时才报 model_deleted。这里把「哪一条来源路径不可用 + 连的是哪份
 * 配置实例」一并返回，让设置页在保存后立刻提示，而不是把它当保存失败。
 *
 * 语义边界：不可用目标**保持可编辑**（不自动改绑另一账户），诊断只读、不修数据。
 */
type Routing = { review: Config['agent']['review']; workers: Config['workers']; council: Config['agent']['council'] }
interface RoutingWarning {
  path: string
  reason: ModelUnavailableReason
  target?: Pick<ModelBindingRef, 'provider' | 'model' | 'keyId'>
  route?: string
}

/** Warnings keep intentionally unavailable targets editable without silently rebinding them. */
export function routingDiagnostics(config: Config, routing: Routing) {
  const warnings: RoutingWarning[] = []
  const check = (path: string, target: ModelTarget) => {
    if (!('provider' in target)) return
    const ref = { provider: target.provider, model: target.model, ...(target.keyId ? { keyId: target.keyId } : {}) }
    const status = modelBindingAvailability(config.provider.providers, ref)
    if (!status.available && status.reason) warnings.push({ path, reason: status.reason, target: ref })
  }
  for (const [name, target] of Object.entries(routing.review.profiles)) check(`agent.review.profiles.${name}`, target)
  // workers.profiles 只在被 workers.routing 以字符串引用时取用（workerModelPolicy 的
  // 顺序：order → role → task → default），未被引用的模板档案不打扰用户。
  const usedProfiles = new Set(Object.values(routing.workers.routing).filter((route): route is string => typeof route === 'string'))
  for (const [name, target] of Object.entries(routing.workers.profiles)) if (usedProfiles.has(name)) check(`workers.profiles.${name}`, target)
  for (const [task, route] of Object.entries(routing.workers.routing)) {
    const path = `workers.routing.${task}`
    if (typeof route !== 'string') check(path, route)
    else if (!routing.workers.profiles[route]) warnings.push({ path, reason: 'route_deleted', route })
    else check(path, routing.workers.profiles[route])
  }
  routing.council.seats.forEach((seat, index) => {
    if (seat.provider && seat.model) check(`agent.council.seats.${index}`, { provider: seat.provider, model: seat.model, keyId: seat.keyId })
  })
  return {
    instance: { pid: process.pid, home: rivetHome(), configPath: userConfigPath(), version: process.env.RIVET_VERSION ?? process.env.npm_package_version ?? '0.0.0-dev' },
    warnings,
  }
}

export function routingModelStatus(config: Config, routing: Routing) {
  const targets: ModelBindingRef[] = []
  for (const [name, provider] of Object.entries(config.provider.providers)) {
    if (provider.keys?.length) {
      for (const key of provider.keys) for (const model of key.models) targets.push({ provider: name, model: model.id, keyId: key.id })
    } else for (const model of provider.models) targets.push({ provider: name, model: model.id })
  }
  // 只保留可序列化身份：availability 是桌面端展示用的，不把 baseUrl / 凭据主体
  // 带进响应体（2026-10-24 收编时收窄；原实现直接把 target 整个塞进去）。
  for (const target of [...Object.values(routing.review.profiles), ...Object.values(routing.workers.profiles), ...Object.values(routing.workers.routing)]) {
    if (typeof target !== 'string' && 'provider' in target) targets.push({ provider: target.provider, model: target.model, ...(target.keyId ? { keyId: target.keyId } : {}) })
  }
  for (const seat of routing.council.seats) if (seat.provider && seat.model) targets.push({ provider: seat.provider, model: seat.model, keyId: seat.keyId })
  const unique = [...new Map(targets.map(target => [JSON.stringify(target), target])).values()]
  return { availability: unique.map(target => modelBindingAvailability(config.provider.providers, target)), diagnostics: routingDiagnostics(config, routing) }
}
