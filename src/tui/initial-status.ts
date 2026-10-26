/**
 * TuiApp 构造输入的初始状态解析（纯函数，可测）。
 *
 * 背景（2026-08-14，PR#37 同源问题）：main.ts 构造 TuiApp 时，状态栏初始
 * 模型名恒取 provider 预设首模型（models[0]），从不读 config.agent.defaultModel
 * 与运行时实际模型；初始星域只取 agent.getSessionDomain()，全新会话首条消息
 * 前未钉定 → 状态栏落 glance-bar 的「天枢」兜底。显示层与运行时不一致。
 */

import type { ReasoningEffort } from '../agent/auto-reasoning.js'

export interface InitialModelSpec {
  id: string
  alias?: string
  contextWindow?: number
}

export interface ResolveInitialModelNameInput {
  models: InitialModelSpec[]
  /** 运行时实际模型 id（promptEngine.getModel()，bootstrap 装配后值） */
  runtimeModelId?: string
  /** config.agent.defaultModel，格式 "provider:modelId"（可为 null/undefined） */
  defaultModelRef?: string | null
}

export interface ResolveInitialModelNameResult {
  modelName: string
  currentModel?: InitialModelSpec
}

/**
 * 状态栏初始模型名解析。回退链：运行时实际模型 → 配置默认模型
 * （defaultModel 的 modelId 部分）→ provider 首模型。显示名匹配到
 * （id 或 alias）用 alias，未匹配显示原始 modelId——与 bootstrap 的
 * decideStartupResumeModel 决策同源，避免显示与运行时不一致。
 */
export function resolveInitialModelName(
  input: ResolveInitialModelNameInput,
): ResolveInitialModelNameResult {
  const configuredModelId = input.defaultModelRef && input.defaultModelRef.includes(':')
    ? input.defaultModelRef.slice(input.defaultModelRef.indexOf(':') + 1)
    : undefined
  const displayRef = input.runtimeModelId ?? configuredModelId
  const configuredModel = displayRef
    ? input.models.find((m) => m.id === displayRef || m.alias === displayRef)
    : undefined
  const currentModel = configuredModel ?? input.models[0]
  const modelName = displayRef
    ? (configuredModel?.alias ?? displayRef)
    : (currentModel?.alias ?? currentModel?.id ?? 'unknown')
  return { modelName, currentModel }
}

export interface ResolveInitialEffortDisplayInput {
  /** 当前已生效的 effort（agent.getReasoningEffort()） */
  current?: ReasoningEffort
  /** 用户显式配置（config.reasoningEffort） */
  configured?: ReasoningEffort
  /** 模型初始档位（config.reasoningFloor） */
  floor?: ReasoningEffort
  normalize?: (effort: ReasoningEffort) => ReasoningEffort | undefined
}

/** 当前生效值 → 显式配置 → 模型初始 floor；缺失时不虚构档位。 */
export function resolveInitialEffortDisplay(input: ResolveInitialEffortDisplayInput): ReasoningEffort | undefined {
  const effort = input.current ?? input.configured ?? input.floor
  return effort === undefined ? undefined : input.normalize ? input.normalize(effort) : effort
}

export interface ResolveInitialDomainNameInput {
  /** agent.getSessionDomain()?.name（已钉定/恢复时非空） */
  agentDomainName?: string
  /** config.agent.defaultDomain，'auto' 表示保持未钉定（重路由语义） */
  defaultDomain?: string
  /** starDomainRegistry.get 的窄接口（只读 name） */
  resolve: (id: string) => { name: string } | undefined
}

/**
 * 初始星域显示名解析。agent 已钉定（resume/已绑定）优先；全新会话未钉定时
 * 按配置 defaultDomain 显示（非 auto）——与首条消息 bindSessionDomain 的
 * 钉定同源，避免启动时落回 glance-bar 的「天枢」兜底。
 */
export function resolveInitialDomainName(input: ResolveInitialDomainNameInput): string | undefined {
  return input.agentDomainName
    ?? (input.defaultDomain && input.defaultDomain !== 'auto'
      ? input.resolve(input.defaultDomain)?.name
      : undefined)
}
