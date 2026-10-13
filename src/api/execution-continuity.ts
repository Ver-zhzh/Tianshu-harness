import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { proveWirePrefix, isCompleteExecutionSnapshot, ContinuationPrefixError, LocalWorkerPolicyError, type ContinuationPrefixProof } from './continuation-prefix.js'
import type { StreamClient, StreamCallbacks } from './stream-client.js'
import type { OaiChatRequest } from './oai-types.js'
import { normalizeBaseUrl } from './endpoint-map.js'

export interface ExecutionScope {
  singleAttempt: boolean
  sends: number
  sessionId?: string
  model?: string
  requestId?: string
  usageFields?: Record<string, string>
  beforeSend?: (url: string, body: Record<string, unknown>, owner?: string) => void
}
const scopes = new AsyncLocalStorage<ExecutionScope>()
export function currentExecutionScope(): ExecutionScope | undefined { return scopes.getStore() }

/** The transport boundary, after provider transforms and before any HTTP send. */
export function checkExecutionSend(url: string, body: Record<string, unknown>, owner?: string): void {
  const scope = scopes.getStore()
  if (!scope) return
  if (scope.singleAttempt && scope.sends > 0) throw new LocalWorkerPolicyError('Worker request already sent; automatic retry is disabled')
  scope.beforeSend?.(url, body, owner)
  scope.sends++
}

/** Principal identity only. Access tokens and JWT contents are never stored. */
export function credentialPrincipal(headers: RequestInit['headers']): string | undefined {
  const h = new Headers(headers)
  let owner = h.get('chatgpt-account-id') ?? h.get('x-account-id')
  if (!owner) {
    try {
      const jwt = h.get('authorization')?.replace(/^Bearer /i, '').split('.')
      const claims = jwt?.length === 3 ? JSON.parse(Buffer.from(jwt[1]!, 'base64url').toString('utf8')) : undefined
      owner = typeof claims?.sub === 'string' ? claims.sub : undefined
    } catch { /* opaque credentials use a non-reversible fingerprint below */ }
  }
  if (owner) return createHash('sha256').update(owner).digest('hex')
  const opaque = h.get('x-api-key') ?? h.get('x-goog-api-key') ?? h.get('authorization')?.replace(/^Bearer /i, '').trim()
  return opaque ? createHash('sha256').update(`opaque:${opaque}`).digest('hex') : undefined
}

function normalizedBody(body: Record<string, unknown>): Record<string, unknown> {
  const messages = body.messages ?? body.input ?? body.contents ?? []
  return {
    ...body,
    messages: [
      ...(body.system ? [{ role: 'system', content: body.system }] : []),
      ...(body.instructions ? [{ role: 'system', content: body.instructions }] : []),
      ...(body.systemInstruction ? [{ role: 'system', content: body.systemInstruction }] : []),
      ...(Array.isArray(messages) ? messages : [{ role: 'input', content: messages }]),
    ],
    thinking: body.thinking ?? body.reasoning ?? (body.generationConfig as Record<string, unknown> | undefined)?.thinkingConfig,
    max_tokens: body.max_tokens ?? body.max_output_tokens ?? (body.generationConfig as Record<string, unknown> | undefined)?.maxOutputTokens,
  }
}

export interface ContinuityClientOptions {
  provider: string
  model: string
  credentialScope?: string
  expectedPrincipal?: string
  singleAttempt?: boolean
  prior?: ContinuationPrefixProof
  sessionId?: string
}
const policies = new WeakMap<StreamClient, ContinuityClientOptions>()

/** Proxy forwards the entire optional client surface; side paths never replace the main baseline. */
export function withExecutionContinuity(client: StreamClient, options: ContinuityClientOptions): StreamClient {
  const existing = policies.get(client)
  if (existing) {
    if (options.singleAttempt) existing.singleAttempt = true
    return client
  }
  let proof = options.prior
  let generation = proof?.cacheGenerationId ?? randomUUID()
  let generationReason = proof?.generationReason ?? 'initial'
  let terminal: Error | undefined
  let unlocked = !proof
  let sessionId = options.sessionId
  if (proof && (!proof.options || proof.version !== 2)) {
    terminal = new LocalWorkerPolicyError('Legacy execution snapshot is incomplete; explicitly start a new cache generation')
  }
  const authorize = (reason: string) => {
    if (options.singleAttempt && terminal) throw terminal
    terminal = undefined
    proof = undefined
    unlocked = true
    generation = randomUUID()
    generationReason = reason
    client.authorizeCacheGeneration?.(reason)
  }
  const wrapped = new Proxy(client, {
    get(target, prop) {
      if (prop === 'getMainPrefixProof') return () => proof
      if (prop === 'getExecutionPolicy') return () => ({ singleAttempt: options.singleAttempt === true })
      if (prop === 'setRuntimeSessionId') return (id: string) => { sessionId = id }
      if (prop === 'authorizeCacheGeneration') return authorize
      if (prop === 'restoreExecutionSnapshot') return (prior: ContinuationPrefixProof) => {
        if (!isCompleteExecutionSnapshot(prior)) throw new LocalWorkerPolicyError('Execution snapshot missing normalized options')
        client.restoreExecutionOptions?.(prior.options)
        const savedThinking = prior.options.thinking as Record<string, unknown> | undefined
        const savedOutput = prior.options.output_config as Record<string, unknown> | undefined
        const savedEffort = prior.options.reasoning_effort ?? savedOutput?.effort ?? savedThinking?.effort
        if (typeof savedEffort === 'string') client.setReasoningEffort?.(savedEffort)
        const thinking = prior.options.thinking as { type?: string } | undefined
        if (thinking?.type === 'enabled' || thinking?.type === 'disabled') client.setThinking?.(thinking.type)
        proof = prior; generation = prior.cacheGenerationId ?? generation; generationReason = prior.generationReason ?? 'restored'; unlocked = false
      }
      if (prop === 'setReasoningEffort' || prop === 'setThinking' || prop === 'restoreExecutionOptions') return (...args: unknown[]) => {
        if (!unlocked) return
        const fn: unknown = Reflect.get(target, prop, target)
        if (typeof fn === 'function') fn.apply(target, args)
      }
      if (prop === 'stream') return async (request: OaiChatRequest, callbacks: StreamCallbacks, signal?: AbortSignal) => {
        if (terminal) throw terminal
        const protectedRequest = request.prefixProbe === true || request.diagnostics?.purpose === 'worker_execution' || request.diagnostics?.purpose === 'worker_finalize'
        const parent = currentExecutionScope()
        let sends = 0
        const scope: ExecutionScope = { singleAttempt: options.singleAttempt === true || parent?.singleAttempt === true,
          get sends() { return parent?.singleAttempt ? parent.sends : sends },
          set sends(value) { if (parent?.singleAttempt) parent.sends = value; else sends = value },
          sessionId: sessionId ?? parent?.sessionId, model: options.model }
        let comparison = 'baseline_missing'
        let previousMainRequestId: string | undefined
        if (protectedRequest) scope.beforeSend = (url, raw, owner) => {
          if (options.expectedPrincipal && owner !== options.expectedPrincipal) throw new LocalWorkerPolicyError('Root session credential owner changed; model request not sent')
          const body = normalizedBody(raw)
          const next = proveWirePrefix(body, options.provider, currentExecutionScope()?.requestId ?? randomUUID(), normalizeBaseUrl(url))
          next.model = String(raw.model ?? options.model)
          next.cacheGenerationId = generation
          next.generationReason = generationReason
          next.credentialScope = `${options.credentialScope ?? `${options.provider}:default`}${owner ? `:principal:${owner}` : ''}`
          comparison = proof ? 'equal' : generationReason === 'initial' ? 'baseline_missing' : 'generation_changed'
          previousMainRequestId = proof?.requestId
          if (proof) {
            if (proof.provider !== next.provider || proof.model !== next.model || proof.endpointHash !== next.endpointHash
              || proof.credentialScope !== next.credentialScope) throw new ContinuationPrefixError('binding', proof, next)
            if (proof.optionsHash !== next.optionsHash) throw new ContinuationPrefixError('options', proof, next)
            if (proof.toolsHash !== next.toolsHash) throw new ContinuationPrefixError('tools', proof, next)
            const at = proof.messages.findIndex((message, i) => next.messages[i]?.hash !== message.hash)
            if (at !== -1) throw new ContinuationPrefixError(at, proof, next)
          }
          proof = next
          unlocked = false
          request.onExecutionSnapshot?.(next)
        }
        const check = scope.beforeSend
        if (parent?.beforeSend) scope.beforeSend = (url, raw, owner) => { parent.beforeSend!(url, raw, owner); check?.(url, raw, owner) }
        let failure: Error | undefined
        const observed: StreamCallbacks = { ...callbacks,
          onError: error => { failure = error; callbacks.onError(error) },
          onStopReason: (reason, usage) => {
            if (protectedRequest && proof) usage.observation = {
              ...usage.observation,
              requestId: usage.observation?.requestId ?? proof.requestId,
              attemptId: usage.observation?.attemptId ?? proof.requestId,
              status: usage.observation?.status ?? 'complete',
              fields: usage.observation?.fields ?? scope.usageFields ?? Object.fromEntries(Object.keys(usage).filter(k => k.endsWith('_tokens')).map(k => [k, k])),
              executionSnapshot: proof,
              wire: { ...usage.observation?.wire, provider: proof.provider, model: proof.model, purpose: request.diagnostics?.purpose, messages: proof.messages, toolsHash: proof.toolsHash, options: proof.options ?? {}, endpointHash: proof.endpointHash, baseline: request.diagnostics?.priorPrefix ? 'present' : usage.observation?.wire?.baseline ?? 'baseline_missing', comparison, previousMainRequestId: previousMainRequestId ?? request.diagnostics?.previousMainRequestId },
              continuity: { cacheGenerationId: generation, generationReason, optionsHash: proof.optionsHash, toolsHash: proof.toolsHash, credentialScope: proof.credentialScope },
            }
            callbacks.onStopReason(reason, usage)
          },
        }
        try {
          await scopes.run(scope, () => client.stream(request, observed, signal))
          if (failure) throw failure
        } catch (error) {
          if (options.singleAttempt) terminal = error instanceof Error ? error : new Error(String(error))
          throw error
        }
      }
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  policies.set(wrapped, options)
  return wrapped
}
