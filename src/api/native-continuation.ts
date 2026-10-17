import { createHash } from 'node:crypto'
import { stableStringify } from './stable-json.js'
import { LocalWorkerPolicyError, type ContinuationPrefixProof } from './continuation-prefix.js'

export interface NativeCacheAnnotation {
  kind: 3 | 4
  messageIndex: number
  blockIndex: number
  valueHash: string
}

export interface NativeSourceBoundaries {
  source: string[]
  boundaries: Array<{ messageIndex: number; blockCount: number; sourceCount: number }>
  cacheLayout: NativeCacheAnnotation[]
}

type NativeMessage = { role: string; content: unknown[] }
const cacheValue = { type: 'ephemeral' }
const hash = (value: unknown): string => createHash('sha256').update(stableStringify(value)).digest('hex')
const byteHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const cacheHash = hash(cacheValue)
const nativeOwners = new WeakMap<NativeSourceBoundaries, string>()
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

function validLayout(layout: unknown, messages: Array<{ role: string }>, tail?: ContinuationPrefixProof['nativeTail']): layout is NativeCacheAnnotation[] {
  if (!Array.isArray(layout) || layout.length > 2) return false
  const kinds = new Set<number>()
  return Array.from(layout).every(entry => {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).some(key => !['kind', 'messageIndex', 'blockIndex', 'valueHash'].includes(key))) return false
    if ((entry.kind !== 3 && entry.kind !== 4) || kinds.has(entry.kind) || entry.valueHash !== cacheHash
      || !Number.isSafeInteger(entry.messageIndex) || entry.messageIndex < 0 || entry.messageIndex >= messages.length
      || !Number.isSafeInteger(entry.blockIndex) || entry.blockIndex < 0) return false
    kinds.add(entry.kind)
    return (entry.kind === 3 ? entry.messageIndex === messages.findIndex(message => message.role === 'user') : messages[entry.messageIndex]?.role === 'assistant')
      && (!tail || entry.messageIndex !== messages.length - 1 || entry.blockIndex < tail.blockCount)
  })
}

export function isValidNativeProof(proof: ContinuationPrefixProof): boolean {
  if (proof.canonicalSource !== undefined && (!Array.isArray(proof.canonicalSource)
    || (proof.messages.length > 0 && proof.canonicalSource.length === 0) || !Array.from(proof.canonicalSource).every(isHash))) return false
  if (proof.nativeTail !== undefined) {
    const tail = proof.nativeTail
    if (!tail || typeof tail !== 'object' || Array.isArray(tail) || Object.keys(tail).some(key => key !== 'blockCount' && key !== 'hash')
      || !Number.isSafeInteger(tail.blockCount) || tail.blockCount <= 0 || !isHash(tail.hash) || proof.messages.at(-1)?.role !== 'user') return false
  }
  return proof.nativeCacheLayout === undefined || validLayout(proof.nativeCacheLayout, proof.messages, proof.nativeTail)
}

function validMapping(body: Record<string, unknown>, mapping: NativeSourceBoundaries): boolean {
  const messages = body.messages as Array<Record<string, unknown>>
  if (!mapping || nativeOwners.get(mapping) !== hash(mapping) || !Array.isArray(messages) || !Array.isArray(mapping.source) || !Array.from(mapping.source).every(isHash)
    || !validLayout(mapping.cacheLayout, messages as Array<{ role: string }>) || !Array.isArray(mapping.boundaries)) return false
  if (!Array.from(mapping.boundaries).every(boundary => {
    if (!boundary || typeof boundary !== 'object' || Object.keys(boundary).some(key => !['messageIndex', 'blockCount', 'sourceCount'].includes(key))) return false
    const message = messages[boundary.messageIndex]
    return Number.isSafeInteger(boundary.messageIndex) && boundary.messageIndex >= 0 && message?.role === 'user'
      && Array.isArray(message.content) && Number.isSafeInteger(boundary.blockCount) && boundary.blockCount >= 0 && boundary.blockCount <= message.content.length
      && Number.isSafeInteger(boundary.sourceCount) && boundary.sourceCount > 0 && boundary.sourceCount <= mapping.source.length
  })) return false
  let annotations = 0
  let allAnnotations = Array.isArray(body.tools) ? body.tools.filter(tool => record(tool)?.cache_control !== undefined).length : 0
  for (const [messageIndex, message] of messages.entries()) {
    if (!Array.isArray(message.content)) continue
    for (const [blockIndex, value] of message.content.entries()) {
      const block = record(value)
      if (block?.cache_control === undefined) continue
      allAnnotations++
      if (message.role !== 'user' && message.role !== 'assistant') continue
      annotations++
      const owner = mapping.cacheLayout.find(entry => entry.messageIndex === messageIndex && entry.blockIndex === blockIndex)
      if (!owner || hash(block.cache_control) !== owner.valueHash || blockIndex !== message.content.length - 1
        || (owner.kind === 3 && !mapping.boundaries.some(boundary => boundary.messageIndex === messageIndex && boundary.blockCount === blockIndex + 1))) return false
    }
  }
  return allAnnotations <= 4 && annotations === mapping.cacheLayout.length
}

export function captureNativeProof(body: Record<string, unknown>, mapping: NativeSourceBoundaries): Pick<ContinuationPrefixProof, 'canonicalSource' | 'nativeTail' | 'nativeCacheLayout'> {
  if (!validMapping(body, mapping)) throw new LocalWorkerPolicyError('Native conversion evidence is invalid; request not sent')
  const tail = (body.messages as Array<Record<string, unknown>>).at(-1)
  return { canonicalSource: [...mapping.source], nativeCacheLayout: mapping.cacheLayout.map(entry => ({ ...entry })),
    ...(tail?.role === 'user' && Array.isArray(tail.content) && tail.content.length
      ? { nativeTail: { blockCount: tail.content.length, hash: byteHash(tail) } } : {}) }
}

export function recordNativeCacheLayout(mapping: NativeSourceBoundaries | undefined, messages: readonly NativeMessage[], offset: number): void {
  if (!mapping) return
  mapping.cacheLayout = []
  for (const [messageIndex, message] of messages.entries()) {
    for (const [blockIndex, value] of message.content.entries()) {
      const block = record(value)
      if (block?.cache_control !== undefined) mapping.cacheLayout.push({ kind: message.role === 'user' ? 3 : 4,
        messageIndex: messageIndex + offset, blockIndex, valueHash: hash(block.cache_control) })
    }
  }
  nativeOwners.set(mapping, hash(mapping))
}

function restorePreviousBp3(previous: ContinuationPrefixProof, view: Array<Record<string, unknown>>, mapping: NativeSourceBoundaries): boolean {
  const messageIndex = previous.messages.findIndex(message => message.role === 'user')
  if (messageIndex < 0) return true
  const message = view[messageIndex]
  if (message?.role !== 'user' || !Array.isArray(message.content)) return false
  const saved = previous.nativeCacheLayout?.find(entry => entry.kind === 3)
  if (previous.nativeCacheLayout !== undefined) {
    if (!saved) return true
    const block = record(message.content[saved.blockIndex])
    if (!block || block.cache_control !== undefined || !mapping.boundaries.some(boundary => boundary.messageIndex === messageIndex
      && boundary.blockCount === saved.blockIndex + 1 && (!previous.canonicalSource || boundary.sourceCount <= previous.canonicalSource.length))) return false
    message.content[saved.blockIndex] = { ...block, cache_control: { ...cacheValue } }
    return true
  }
  if (hash(message) === previous.messages[messageIndex]!.hash) return true
  if (Object.keys(message).some(key => key !== 'role' && key !== 'content')) return false
  const oldCount = messageIndex === previous.messages.length - 1 ? previous.nativeTail?.blockCount : undefined
  const candidates = new Set(mapping.boundaries.filter(boundary => boundary.messageIndex === messageIndex
    && (!previous.canonicalSource || boundary.sourceCount <= previous.canonicalSource.length)
    && (oldCount === undefined || boundary.blockCount === oldCount)).map(boundary => boundary.blockCount))
  const rolling = createHash('sha256').update('{"content":[')
  for (const [index, value] of message.content.entries()) {
    if (index) rolling.update(',')
    if (candidates.has(index + 1) && rolling.copy().update(stableStringify({ ...record(value), cache_control: cacheValue }))
      .update('],"role":"user"}').digest('hex') === previous.messages[messageIndex]!.hash) {
      message.content[index] = { ...record(value), cache_control: { ...cacheValue } }
      return true
    }
    rolling.update(stableStringify(value))
  }
  return false
}

function restorePreviousBp4(previous: ContinuationPrefixProof, view: Array<Record<string, unknown>>): boolean {
  if (previous.nativeCacheLayout !== undefined) {
    const old = previous.nativeCacheLayout.find(entry => entry.kind === 4)
    if (!old) return true
    const blocks = view[old.messageIndex]?.content
    if (!Array.isArray(blocks) || old.blockIndex !== blocks.length - 1) return false
    const block = record(blocks[old.blockIndex])
    if (!block || block.cache_control !== undefined) return false
    blocks[old.blockIndex] = { ...block, cache_control: { ...cacheValue } }
    return true
  }
  let recovered = 0
  for (const [index, old] of previous.messages.entries()) {
    if (old.role !== 'assistant') continue
    const message = view[index]
    if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) return false
    if (hash(message) === old.hash) continue
    const block = record(message.content.at(-1))
    if (!block || block.cache_control !== undefined || ++recovered > 1) return false
    message.content[message.content.length - 1] = { ...block, cache_control: { ...cacheValue } }
    if (hash(message) !== old.hash) return false
  }
  return true
}

function previousUserTail(previous: ContinuationPrefixProof, next: ContinuationPrefixProof, current: Record<string, unknown>, mapping: NativeSourceBoundaries): Record<string, unknown> | undefined {
  if (current.role !== 'user' || !Array.isArray(current.content) || Object.keys(current).some(key => key !== 'role' && key !== 'content')) return
  const source = previous.canonicalSource
  const tail = previous.nativeTail
  if (source && tail) {
    if (!next.canonicalSource || next.canonicalSource.length <= source.length || current.content.length <= tail.blockCount) return
    const prefix = { ...current, content: current.content.slice(0, tail.blockCount) }
    return hash(prefix) === previous.messages.at(-1)!.hash && byteHash(prefix) === tail.hash ? prefix : undefined
  }
  const candidates = new Set(mapping.boundaries.filter(boundary => boundary.messageIndex === previous.messages.length - 1
    && boundary.sourceCount < mapping.source.length && (!source || boundary.sourceCount === source.length)
    && (!tail || boundary.blockCount === tail.blockCount)).map(boundary => boundary.blockCount))
  const rolling = createHash('sha256').update('{"content":[')
  for (let blockCount = 0; blockCount < current.content.length; blockCount++) {
    if (blockCount) rolling.update(`${blockCount > 1 ? ',' : ''}${stableStringify(current.content[blockCount - 1])}`)
    if (candidates.has(blockCount) && rolling.copy().update('],"role":"user"}').digest('hex') === previous.messages.at(-1)!.hash) {
      const prefix = { ...current, content: current.content.slice(0, blockCount) }
      return !tail || byteHash(prefix) === tail.hash ? prefix : undefined
    }
  }
}

export function isProvenNativeContinuation(previous: ContinuationPrefixProof, next: ContinuationPrefixProof, body: Record<string, unknown>, mapping?: NativeSourceBoundaries): boolean {
  if (!mapping || !isValidNativeProof(previous) || !isValidNativeProof(next) || !validMapping(body, mapping)
    || hash(next.canonicalSource) !== hash(mapping.source) || hash(next.nativeCacheLayout) !== hash(mapping.cacheLayout)
    || previous.canonicalSource?.some((entry, index) => next.canonicalSource?.[index] !== entry)) return false
  const view: Array<Record<string, unknown>> = (body.messages as Array<Record<string, unknown>>).map(message => ({ ...message,
    ...(Array.isArray(message.content) ? { content: [...message.content] } : {}) }))
  for (const annotation of mapping.cacheLayout) {
    const blocks = view[annotation.messageIndex]!.content as unknown[]
    const { cache_control: _cache, ...content } = record(blocks[annotation.blockIndex])!
    blocks[annotation.blockIndex] = content
  }
  if (!restorePreviousBp3(previous, view, mapping) || !restorePreviousBp4(previous, view)) return false
  for (const [index, old] of previous.messages.entries()) {
    const current = view[index]
    if (!current) return false
    if (hash(current) === old.hash) continue
    const tail = index === previous.messages.length - 1 && old.role === 'user' ? previousUserTail(previous, next, current, mapping) : undefined
    if (!tail) return false
    view[index] = tail
  }
  if (previous.nativeCacheLayout !== undefined) {
    const layout: NativeCacheAnnotation[] = []
    for (const [messageIndex, message] of view.slice(0, previous.messages.length).entries()) {
      if (!Array.isArray(message.content) || (message.role !== 'user' && message.role !== 'assistant')) continue
      for (const [blockIndex, value] of message.content.entries()) {
        const block = record(value)
        if (block?.cache_control !== undefined) layout.push({ kind: message.role === 'user' ? 3 : 4,
          messageIndex, blockIndex, valueHash: hash(block.cache_control) })
      }
    }
    if (hash(layout) !== hash(previous.nativeCacheLayout)) return false
  }
  return true
}
