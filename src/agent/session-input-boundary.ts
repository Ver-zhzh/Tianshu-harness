import type { OaiMessage } from '../api/oai-types.js'
import { estimateOaiMessageTokens } from '../compact/micro.js'

export class SessionInputBoundary {
  private published?: (userOrdinal: number) => boolean
  private prepared?: (userOrdinal: number) => boolean
  private replacements = new WeakMap<OaiMessage, OaiMessage>()

  setProbes(published: (userOrdinal: number) => boolean, prepared?: (userOrdinal: number) => boolean): void {
    this.published = published
    this.prepared = prepared
  }

  private ordinal(messages: readonly OaiMessage[], index: number): number {
    let ordinal = -1
    for (let sourceIndex = 0; sourceIndex <= index; sourceIndex++) {
      if (messages[sourceIndex]?.role === 'user') ordinal++
    }
    return ordinal
  }

  isPublished(messages: readonly OaiMessage[], index = messages.length - 1): boolean {
    return this.published?.(this.ordinal(messages, index)) ?? false
  }

  mergeProtected(messages: readonly OaiMessage[]): boolean {
    const ordinal = this.ordinal(messages, messages.length - 1)
    return !!(this.published?.(ordinal) || this.prepared?.(ordinal))
  }

  trackReplacement(previous: OaiMessage, next: OaiMessage): void {
    if (previous !== next) this.replacements.set(previous, next)
  }

  resolve(messages: readonly OaiMessage[], input?: OaiMessage): OaiMessage | undefined {
    while (input && !messages.includes(input)) input = this.replacements.get(input)
    return input?.role === 'user' ? input : undefined
  }

  rollbackTarget(messages: readonly OaiMessage[], active?: OaiMessage, prepared?: OaiMessage): OaiMessage | undefined {
    const current = this.resolve(messages, active)
    if (!current) return undefined
    const assembled = this.resolve(messages, prepared)
    const target = assembled && messages.indexOf(assembled) >= messages.indexOf(current) ? assembled : current
    return this.isPublished(messages, messages.indexOf(target)) ? undefined : target
  }
}

export function removeUserMessageAt(state: {
  oaiMessages: OaiMessage[]; estimatedTokens: number; tailEstimate: number; turnCount: number
}, index: number, changed: (messages: OaiMessage[]) => void): OaiMessage | undefined {
  const message = state.oaiMessages[index]
  if (!message) return undefined
  if (message.role !== 'user') throw new Error(
    `removeLastMessage: expected user message but top was ${message.role}. ` +
    'This method may only be used to roll back user messages on abort/error.',
  )
  state.oaiMessages.splice(index, 1)
  const tokens = estimateOaiMessageTokens(message)
  state.estimatedTokens -= tokens
  state.tailEstimate = Math.max(0, state.tailEstimate - tokens)
  state.turnCount--
  changed(state.oaiMessages.slice())
  return message
}
