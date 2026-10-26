import { createHash } from 'node:crypto'
import type { ArtifactStore } from '../artifact/store.js'
import type { OaiMessage, OaiContentPart } from '../api/oai-types.js'
import { archiveContextImages } from './context-image-archive.js'
import { prepareVisionImages } from './vision-image-preparation.js'

export const IMAGE_BUDGET_TRIGGER_BYTES = 8_000_000
export const IMAGE_BUDGET_TARGET_BYTES = 6_000_000
const imageHashes = new WeakMap<OaiContentPart, { url: string; digest: string }>()

export function imageBudgetSignature(messages: OaiMessage[], protectedUser?: OaiMessage): string {
  const hash = createHash('sha256')
  for (const message of messages) if (message.role === 'user' && Array.isArray(message.content)) {
    for (const part of message.content) if (part.type === 'image_url') {
      const url = part.image_url.url
      let cached = imageHashes.get(part)
      if (!cached || cached.url !== url) {
        cached = { url, digest: createHash('sha256').update(url).digest('hex') }
        imageHashes.set(part, cached)
      }
      hash.update(cached.digest)
    }
  }
  hash.update(String(messages.indexOf(protectedUser!)))
  return hash.digest('hex')
}

export async function prepareImageBudgetCandidate(store: ArtifactStore, messages: OaiMessage[], options: {
  protectedUser?: OaiMessage; wireBytes: number; sourceBytes?: number; signal?: AbortSignal
  prepare?: typeof prepareVisionImages
}): Promise<{ messages: OaiMessage[]; reclaimedBytes: number; targetReached: boolean } | undefined> {
  const signal = options.signal
  const eligible: Array<{ message: OaiMessage; part: OaiContentPart }> = []
  let lastAssistant = -1
  for (let index = 0; index < messages.length; index++) if (messages[index]!.role === 'assistant') lastAssistant = index
  for (const [index, message] of messages.entries()) if (message !== options.protectedUser && message.role === 'user'
    && !(message.imagePolicy === 'original' && index > lastAssistant) && Array.isArray(message.content)) {
    for (const part of message.content) if (part.type === 'image_url' && part.image_url.url.startsWith('data:image/')) eligible.push({ message, part })
  }
  if (!eligible.length) return undefined
  const originals = eligible.map(entry => (entry.part as Extract<OaiContentPart, { type: 'image_url' }>).image_url.url)
  const refs = await archiveContextImages(store, [{ role: 'user', content: originals.map(url => ({ type: 'image_url', image_url: { url } })) }])
  const distinct = [...new Set(originals)]
  const byUrl = new Map(distinct.map((url, index) => [url, refs[index]!]))
  signal?.throwIfAborted()
  const replacements = new Map<OaiContentPart, OaiContentPart[]>()
  for (let i = 0; i < eligible.length; i++) {
    const { part } = eligible[i]!, url = originals[i]!, id = byUrl.get(url)!
    if (!id) throw new Error('Original image archive reference missing')
    const reference = { type: 'text' as const, text: `[Earlier image archived as ${id}; use ask_image(imageId="${id}") to inspect it. Do not describe omitted pixels from memory.]` }
    if (i < eligible.length - 3) replacements.set(part, [reference])
    else {
      const prepared = await (options.prepare ?? prepareVisionImages)(store, [url], { signal })
      replacements.set(part, [reference, { type: 'image_url', image_url: { ...(part as Extract<OaiContentPart, { type: 'image_url' }>).image_url, url: prepared.images[0]! } },
        ...(prepared.notice ? [{ type: 'text' as const, text: prepared.notice }] : [])])
    }
  }
  const render = () => messages.map(message => message.role === 'user' && Array.isArray(message.content) && message !== options.protectedUser
    && message.content.some(part => replacements.has(part))
    ? { ...message, content: message.content.flatMap(part => replacements.get(part) ?? [part]) } : message)
  const beforeBytes = options.sourceBytes ?? Buffer.byteLength(JSON.stringify(messages))
  const candidate = render()
  const candidateBytes = Buffer.byteLength(JSON.stringify(candidate))
  // Keep recent visual evidence even when it prevents reaching the soft target.
  signal?.throwIfAborted()
  const reclaimedBytes = beforeBytes - candidateBytes
  if (reclaimedBytes <= 0) return undefined
  return { messages: candidate, reclaimedBytes, targetReached: options.wireBytes - reclaimedBytes <= IMAGE_BUDGET_TARGET_BYTES }
}
