/**
 * Write-behind batch writer for session transcripts.
 *
 * Lines queue in memory and flush as one checksummed zstd frame per batch —
 * either after a 200ms timer window, an explicit flush barrier (LLM request,
 * /cd migration, shutdown drain), or compaction. The first line of a
 * brand-new session flushes synchronously so the session file exists
 * immediately (listSessions resolves sessions by .jsonl presence).
 */

import { appendFileSync, copyFileSync, existsSync, readFileSync, statSync, truncateSync, openSync, fsyncSync, closeSync } from 'node:fs'
import { appendFile, open } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { encodeBatch, decodeTranscriptText, isZstdFrameStream, scanZstdFrames } from './session-transcript-codec.js'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { randomUUID } from 'node:crypto'

export class SessionBatchWriter {
  /** Write-behind batch: JSONL text waiting for the next flush. */
  private pendingBuffer = ''
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private flushPromise: Promise<void> | null = null
  private inFlight: { start: number; text: string } | null = null
  /** Set once the transcript file is known to be zstd-frame format. */
  private codecReady = false
  private failedAppend?: { start: number; frame: Buffer }

  constructor(
    private readonly filePath: string,
    private readonly backupDirProvider: () => string,
  ) {}

  /**
   * Queue a JSONL line into the batch. The batch is flushed by a 200ms timer,
   * an explicit flush barrier, or compaction — whichever comes first.
   *
   * Exception: the first line of a brand-new session flushes synchronously so
   * the session file exists immediately, and a crash within the first 200ms
   * cannot lose the entire session.
   */
  enqueueLine(line: string): void {
    this.pendingBuffer += line
    if (this.flushTimer === null) {
      if (!this.codecReady && !existsSync(this.filePath)) {
        this.flushSync()
        return
      }
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null
        void this.flush().catch(err => {
          // eslint-disable-next-line no-console
          console.error('[session-persist] batch flush failed:', err)
        })
      }, 200)
      this.flushTimer.unref?.()
    }
  }

  /**
   * Flush barrier: cancel the timer, drain the pending batch into one
   * checksummed zstd frame append + datasync. Concurrent callers share the
   * in-flight drain promise; a drain that arrives while one is already in
   * flight still drains whatever queued in the meantime (the awaited promise
   * only covers the batch it started with).
   *
   * On write failure the batch is put back at the head of the buffer so the
   * next flush / shutdown drain retries it — a failed append must not
   * permanently drop queued lines (ENOSPC etc.).
   */
  async flush(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.flushPromise !== null) return this.flushPromise
    this.flushPromise = this.drainPending().finally(() => { this.flushPromise = null })
    return this.flushPromise
  }

  private async drainPending(): Promise<void> {
    while (this.pendingBuffer.length > 0) {
      const text = this.pendingBuffer
      this.pendingBuffer = ''
      try {
        await this.writeBatch(text)
      } catch (err) {
        this.pendingBuffer = text + this.pendingBuffer
        throw err
      }
    }
  }

  /** Synchronous flush variant for the sync compaction paths. */
  flushSync(): void {
    // A synchronous rewrite cannot overtake an append still owned by the OS.
    if (this.flushPromise) throw Object.assign(new Error('Session transcript write is in progress'), { code: 'EBUSY' })
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    const text = this.pendingBuffer
    this.pendingBuffer = ''
    if (text.length > 0) try {
      this.ensureCodecFormat()
      const frame = encodeBatch(text)
      this.failedAppend = { start: existsSync(this.filePath) ? statSync(this.filePath).size : 0, frame }
      // mode 仅在文件创建时生效——首次落盘即 0600（转录含未脱敏对话，
      // fs-atomic 的 0600 只覆盖后续重写路径）。
      if (frame.length > 0) appendFileSync(this.filePath, frame, { mode: 0o600 })
      this.syncFile()
      this.failedAppend = undefined
    } catch (error) {
      this.pendingBuffer = text + this.pendingBuffer
      this.codecReady = false
      throw error
    }
  }

  /**
   * Merge the on-disk transcript text with lines still queued in the batch —
   * in-process readers must see un-flushed lines (append followed by load
   * without a flush is valid).
   */
  mergePending(onDiskText: string): string {
    return this.pendingBuffer.length > 0 ? onDiskText + this.pendingBuffer : onDiskText
  }

  captureReadSnapshot(): { committedBytes?: number; tail: string } {
    return {
      committedBytes: this.inFlight?.start,
      tail: (this.inFlight?.text ?? '') + this.pendingBuffer,
    }
  }

  private async writeBatch(text: string): Promise<void> {
    this.ensureCodecFormat()
    const frame = encodeBatch(text)
    if (frame.length === 0) return
    this.inFlight = { start: existsSync(this.filePath) ? statSync(this.filePath).size : 0, text }
    this.failedAppend = { start: this.inFlight.start, frame }
    try {
      await appendFile(this.filePath, frame, { mode: 0o600 })
      await this.syncFileAsync()
      this.failedAppend = undefined
    } catch (error) {
      // A failed append may have written a partial frame. Inspect before retry.
      this.codecReady = false
      throw error
    } finally {
      this.inFlight = null
    }
  }

  /**
   * One-time migration: on the first write, a legacy plain-text transcript is
   * backed up and transcoded to a single zstd frame so subsequent appends can
   * stay frame-aligned. New files and already-compressed files are untouched.
   */
  private ensureCodecFormat(): void {
    if (this.failedAppend) {
      const { start, frame } = this.failedAppend
      const current = existsSync(this.filePath) ? readFileSync(this.filePath) : Buffer.alloc(0)
      const tail = current.subarray(start)
      if (current.length < start || tail.length > frame.length || !frame.subarray(0, tail.length).equals(tail)) {
        throw new Error('Session transcript changed after a failed append; refusing to truncate unrelated history')
      }
      if (current.length > start) truncateSync(this.filePath, start)
      if (existsSync(this.filePath)) this.syncFile()
      this.failedAppend = undefined
    }
    if (this.codecReady) return
    if (!existsSync(this.filePath)) { this.codecReady = true; return }
    const head = readFileSync(this.filePath)
    const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
    if (isZstdFrameStream(head) || (head.length > 0 && head.length < magic.length && head.equals(magic.subarray(0, head.length)))) {
      const { tornStart } = scanZstdFrames(head)
      if (tornStart !== undefined) {
        // Validate every complete frame before changing bytes; middle corruption
        // must never be misclassified as a discardable tail.
        decodeTranscriptText(head.subarray(0, tornStart))
        const backup = join(this.backupDirProvider(), `${basename(this.filePath)}.torn-${randomUUID()}`)
        copyFileSync(this.filePath, backup)
        this.syncFile(backup)
        truncateSync(this.filePath, tornStart)
        this.syncFile()
      }
      else decodeTranscriptText(head)
      this.codecReady = true
      return
    }
    try {
      // basename 而非 split('/')：Windows 的 filePath 是反斜杠路径，按 '/' 切
      // 得到整条路径——join 后成为非法目标，copyFileSync 抛错被下方 catch 静默
      // 吞掉，迁移备份（pre-zstd）在 Windows 上永远不创建（POSIX 可见、CI 绿）。
      copyFileSync(this.filePath, join(this.backupDirProvider(), basename(this.filePath) + '.pre-zstd'))
    } catch { /* best-effort backup; transcode still proceeds */ }
    const frame = encodeBatch(head.toString('utf-8'))
    writeFileAtomicSync(this.filePath, frame.length > 0 ? frame : Buffer.alloc(0))
    this.codecReady = true
  }

  private syncFile(path = this.filePath): void {
    const fd = openSync(path, 'r+')
    try { fsyncSync(fd) } finally { closeSync(fd) }
  }

  private async syncFileAsync(): Promise<void> {
    const fh = await open(this.filePath, 'r+')
    try { await fh.datasync() } finally { await fh.close() }
  }
}
