/** Retain early errors up to the existing 8 MiB capture budget. */
export class BoundedLog {
  private chunks: string[] = []
  private captured = 0
  omittedBytes = 0
  append(text: string) {
    const bytes = Buffer.from(text)
    const count = Math.min(bytes.length, Math.max(0, 8 * 1024 * 1024 - this.captured))
    if (count) this.chunks.push(bytes.subarray(0, count).toString('utf8'))
    this.captured += count; this.omittedBytes += bytes.length - count
  }
  text() { return this.chunks.join('') + (this.omittedBytes ? `\n[omittedBytes=${this.omittedBytes}; capture limit reached]` : '') }
}
