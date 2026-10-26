import type { ReasoningEffort } from './auto-reasoning.js'
import { debugLog } from '../utils/debug.js'
import { normalizeReasoningEffort, resolveEffortSupported, type ProviderCapabilities } from '../api/provider.js'
import type { ProviderConfig } from '../config/schema.js'

export function supportsLatencyReasoning(provider: ProviderConfig, capabilities: ProviderCapabilities): boolean {
  return provider.auth?.type !== 'oauth' && resolveEffortSupported(provider.name, provider, capabilities)
    && normalizeReasoningEffort('medium', capabilities) === 'medium'
}

export function latencyExperimentEnabled(kind: 'reasoning' | 'prompt', env = process.env): boolean {
  return (kind === 'reasoning' ? env.RIVET_LATENCY_REASONING_EXPERIMENT : env.RIVET_LATENCY_PROMPT_EXPERIMENT) === '1'
}

/** An opt-in initial automatic choice; explicit settings and complex work win. */
export function latencyExperimentEffort(input: string, effort: ReasoningEffort, floor?: ReasoningEffort): ReasoningEffort {
  if (latencyExperimentEnabled('reasoning')) debugLog(`[latency-effort] baseline=${effort} inputChars=${input.length} floor=${floor ?? 'preset'}`)
  if (!latencyExperimentEnabled('reasoning') || effort === 'max' || floor === 'high' || floor === 'max') return effort
  const complex = /架构|安全|漏洞|审计|并发|竞态|迁移|根因|性能|全局|重构|architecture|security|audit|race|migration|root cause|performance|refactor/i
  const bounded = /^(?:请|帮我)?\s*(?:读取|查看|列出|解释|显示|read|show|list|explain)\b|^(?:请|帮我)?\s*(?:读取|查看|列出|解释|显示)/i
  const commands = input.replace(/(?:不要|不)(?:修改|写入|删除)(?:任何)?(?:文件|代码)/g, '')
    .replace(/不执行有副作用的命令/g, '').replace(/do not (?:modify|edit|delete) (?:any )?(?:files?|code)/gi, '')
  const actions = /删除|写入|修改|执行|运行|提交|安装|部署|实现|重写|delete|write|modify|execute|\brun\b|commit|install|deploy|implement|rewrite/i
  return input.length <= 300 && bounded.test(input) && !complex.test(input) && !actions.test(commands) && effort !== 'off' && effort !== 'low'
    ? 'medium' : effort
}
