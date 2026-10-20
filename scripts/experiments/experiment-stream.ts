import type { OaiChatRequest, ContentBlock, Usage } from '../../src/api/types.js'
import type { StreamClient } from '../../src/api/stream-client.js'
import type { ProviderConfig } from '../../src/config/schema.js'
import { createProviderClient } from '../../src/api/factory.js'
import { findModelOwner } from '../../src/config/provider-keys.js'
import { resolveRequestBudgetPolicy, buildContextBudget, assertContextBudget, capOutputReserve } from '../../src/context/request-budget.js'
import { CompletionLedger } from './experiment-protocol.js'
import { resolveCapabilities } from '../../src/api/provider.js'
import { RequestInvariantError } from '../../src/api/request-invariant.js'
import { ContinuationPrefixError } from '../../src/api/continuation-prefix.js'
import { ToolNameProtocolError } from '../../src/api/tool-call-name.js'

/** Initial rendering is a template, not a publisher for later experiment history.
 * Fresh arrays preserve the production client's copy-on-write dispatch contract. */
export function experimentRequest(template: OaiChatRequest, messages: OaiChatRequest['messages'], model: string, maxTokens: number): OaiChatRequest {
  return { model, max_tokens: maxTokens, messages: structuredClone(messages), tools: template.tools ? structuredClone(template.tools) : undefined,
    tool_choice: template.tool_choice, stream: true, stream_options: { include_usage: true }, prefixProbe: true }
}

export function productionProfile(provider: ProviderConfig, model: string) {
  const found = findModelOwner(provider, model)
  if (!found) throw new Error('Configured model is unavailable')
  const maxTokens = found.model.maxTokens ?? provider.maxTokens
  if (!maxTokens || !Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error('Model output limit is not configured')
  return { model: found.model.id, configuredMaxTokens: maxTokens, maxTokens: capOutputReserve(maxTokens, found.model.contextWindow), contextWindow: found.model.contextWindow, thinking: provider.thinking ?? 'enabled', reasoningEffort: 'high' }
}
export function productionClient(provider: ProviderConfig, apiKey: string, model: string, sessionId: string) {
  const profile = productionProfile(provider, model)
  const spec = findModelOwner(provider, model)!.model
  const client = createProviderClient(provider, resolveCapabilities(provider.name, provider.capabilities, spec.capabilities), { apiKey, model: profile.model, maxTokens: profile.maxTokens,
    reasoningEffort: profile.reasoningEffort, singleAttempt: true, sessionId })
  return { client, profile, policy: resolveRequestBudgetPolicy(provider.baseUrl, model, profile.contextWindow, true) }
}
export async function streamAttempt(client: StreamClient, request: OaiChatRequest, ledger: CompletionLedger, signal: AbortSignal,
  policy?: ReturnType<typeof resolveRequestBudgetPolicy>, progress?: (event: unknown) => void) {
  const effective = client.previewContextRequest?.(request) ?? request
  if (effective.max_tokens !== ledger.requestLimit) throw new Error('Wire output limit and reserved output limit differ')
  if (policy) assertContextBudget(buildContextBudget(effective, policy, { requestId: 'experiment', revision: 0 }))
  if (!ledger.admit()) return { status: 'insufficient-completion-budget', blocks: [] as ContentBlock[], reason: '', usage: undefined }
  const blocks: ContentBlock[] = []
  let reason = '', usage: Partial<Usage> | undefined, failure: Error | undefined, reasoningChars = 0, textChars = 0
  const started = Date.now()
  try {
    await client.stream(request, {
      onThinkingDelta: s => { reasoningChars += s.length; progress?.({ kind: 'stream-progress', elapsedMs: Date.now() - started, reasoningChars, textChars }) },
      onTextDelta: s => { textChars += s.length },
      onContentBlock: block => blocks.push(block),
      onStopReason: (stop, observed) => { reason = stop; usage = observed },
      onError: error => { failure = error },
      onStreamAttemptAborted: info => { usage = info.usage; progress?.({ kind: 'stream-aborted', requestId: info.requestId, attemptId: info.attemptId, elapsedMs: info.elapsedMs, errorName: info.errorName }) },
    }, signal)
  } catch (error) { failure = error instanceof Error ? error : new Error('stream failed') }
  const measured = usage?.observation?.status === 'complete' && !!usage.observation.fields.output_tokens ? usage : undefined
  const rejectedBeforeSend = failure instanceof RequestInvariantError || failure instanceof ContinuationPrefixError
  if (rejectedBeforeSend) ledger.releaseUnsent()
  else ledger.settle(failure ? undefined : measured)
  const status = signal.aborted ? 'deadline-or-cancelled' : rejectedBeforeSend ? 'local-request-rejected' : failure instanceof ToolNameProtocolError ? 'provider-protocol-error' : failure ? 'transport-error' : reason === 'max_tokens' || reason === 'length' ? 'single-response-limit'
    : ledger.uncertain ? 'usage-uncertain' : blocks.some(b => b.type === 'tool_use' && b.argsTruncated) ? 'invalid-tool-arguments'
      : ['tool_use', 'end_turn', 'stop'].includes(reason) ? blocks.some(b => b.type === 'tool_use') ? 'tools' : 'final' : 'unexpected-finish'
  return { status, blocks, reason, usage, reasoningChars, elapsedMs: Date.now() - started, errorName: failure?.name, errorMessage: failure?.message }
}
export function assistantMessage(blocks: ContentBlock[]) {
  const tools = blocks.filter(b => b.type === 'tool_use')
  return { role: 'assistant' as const, content: blocks.filter(b => b.type === 'text').map(b => b.text).join(''),
    reasoning_content: blocks.filter(b => b.type === 'thinking').map(b => b.thinking).join(''),
    ...(tools.length ? { tool_calls: tools.map(b => ({ id: b.id, type: 'function' as const, function: { name: b.name, arguments: JSON.stringify(b.input) }, ...(b.providerMetadata ? { providerMetadata: b.providerMetadata } : {}) })) } : {}) }
}

/** Offline production-client round trip: fail before billing if dispatch assembly regresses. */
export async function qualifyTransport(provider: ProviderConfig, model: string) {
  const original = globalThis.fetch, { client, profile, policy } = productionClient(provider, 'fixture-only', model, 'offline-dispatch-qualification')
  const ledger = new CompletionLedger(profile.maxTokens), wire: OaiChatRequest['messages'] = [{ role: 'user', content: 'offline fixture' }]
  const template: OaiChatRequest = { model, max_tokens: profile.maxTokens, messages: wire,
    tools: [{ type: 'function', function: { name: 'list_files', description: 'offline fixture', parameters: { type: 'object', properties: {} } } }] }
  let sends = 0
  globalThis.fetch = async (url, init) => {
    if (new URL(String(url)).origin !== new URL(provider.baseUrl).origin) throw new Error('Unexpected qualification endpoint')
    const body = JSON.parse(String(init?.body))
    if (body.max_tokens !== profile.maxTokens) throw new Error('Qualification wire budget mismatch')
    const first = ++sends === 1
    const row = { id: 'offline-' + sends, model, choices: [{ delta: first ? { tool_calls: [{ index: 0, id: 'offline-call', type: 'function', function: { name: 'list_files', arguments: '{}' } }] } : { content: 'offline complete' }, finish_reason: first ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }
    return new Response('data: ' + JSON.stringify(row) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }
  try {
    const signal = AbortSignal.timeout(5000)
    const firstRequest = experimentRequest(template, wire, model, profile.maxTokens), length = firstRequest.messages.length
    const first = await streamAttempt(client, firstRequest, ledger, signal, policy)
    wire.push(assistantMessage(first.blocks), { role: 'tool', tool_call_id: 'offline-call', content: 'fixture' })
    const second = await streamAttempt(client, experimentRequest(template, wire, model, profile.maxTokens), ledger, signal, policy)
    return { passed: first.status === 'tools' && second.status === 'final' && sends === 2 && firstRequest.messages.length === length && ledger.spent === 4 && ledger.reserved === 0,
      first: first.status, second: second.status, sends, budget: ledger.snapshot(), error: second.errorMessage, network: 'intercepted offline fixture, no provider request' }
  } finally { globalThis.fetch = original }
}
