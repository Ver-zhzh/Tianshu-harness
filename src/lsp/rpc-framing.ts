export const MAX_LSP_MESSAGE_BYTES = 16 * 1024 * 1024
export const MAX_LSP_HEADER_BYTES = 8 * 1024
const DELIMITER = Buffer.from('\r\n\r\n')

function bodyLength(header: Buffer): number {
  const lengths = header.toString('ascii').split('\r\n')
    .filter(line => /^content-length:/i.test(line))
  if (lengths.length !== 1) throw new Error('Invalid LSP Content-Length header')
  const match = /^content-length:\s*(\d+)\s*$/i.exec(lengths[0]!)
  if (!match) throw new Error('Invalid LSP Content-Length header')
  const length = Number(match[1])
  if (!Number.isSafeInteger(length) || length > MAX_LSP_MESSAGE_BYTES) {
    throw new Error(`LSP message body too large (limit ${MAX_LSP_MESSAGE_BYTES} bytes)`)
  }
  return length
}

function parseBody(body: Buffer): Record<string, unknown> | undefined {
  try {
    const message: unknown = JSON.parse(body.toString('utf8'))
    if (message && typeof message === 'object' && !Array.isArray(message)) return message as Record<string, unknown>
  } catch { /* Skip malformed JSON without losing the next frame boundary. */ }
  return undefined
}

/** Compatibility decoder for complete buffers; the transport uses the streaming decoder. */
export function decodeFrames(buffer: Buffer): { messages: Record<string, unknown>[]; rest: Buffer } {
  const messages: Record<string, unknown>[] = []
  let offset = 0
  while (offset < buffer.length) {
    const end = buffer.indexOf(DELIMITER, offset)
    if (end === -1) {
      if (buffer.length - offset > MAX_LSP_HEADER_BYTES) throw new Error('LSP header buffer exceeded limit')
      break
    }
    if (end + 4 - offset > MAX_LSP_HEADER_BYTES) throw new Error('LSP header buffer exceeded limit')
    const length = bodyLength(buffer.subarray(offset, end))
    const start = end + 4
    if (buffer.length - start < length) break
    const message = parseBody(buffer.subarray(start, start + length))
    if (message) messages.push(message)
    offset = start + length
  }
  return { messages, rest: buffer.subarray(offset) }
}

/** Retain at most one bounded header/body, irrespective of transport chunk size.
 * Allocate the body once after validating its header; fragmented UTF-8 stays bytes. */
export class LspMessageDecoder {
  private header = Buffer.alloc(MAX_LSP_HEADER_BYTES)
  private headerUsed = 0
  private body: Buffer | undefined
  private bodyUsed = 0

  clear(): void {
    this.headerUsed = 0
    this.body = undefined
    this.bodyUsed = 0
  }

  push(chunk: Buffer, receive: (message: Record<string, unknown>) => void): void {
    let offset = 0
    while (offset < chunk.length) {
      if (!this.body) {
        if (this.headerUsed === MAX_LSP_HEADER_BYTES) throw new Error('LSP header buffer exceeded limit')
        this.header[this.headerUsed++] = chunk[offset++]!
        if (this.headerUsed < 4 || !this.header.subarray(this.headerUsed - 4, this.headerUsed).equals(DELIMITER)) continue
        const length = bodyLength(this.header.subarray(0, this.headerUsed - 4))
        this.headerUsed = 0
        this.body = Buffer.alloc(length)
      }
      const take = Math.min(this.body.length - this.bodyUsed, chunk.length - offset)
      chunk.copy(this.body, this.bodyUsed, offset, offset + take)
      this.bodyUsed += take
      offset += take
      if (this.bodyUsed === this.body.length) {
        const message = parseBody(this.body)
        this.body = undefined
        this.bodyUsed = 0
        if (message) receive(message)
      }
    }
  }
}
