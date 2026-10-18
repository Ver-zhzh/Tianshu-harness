import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { StorageEntry } from './scan.js'

export const AUDIT_MANIFEST_LIMIT = 8 * 1024 * 1024
export const AUDIT_PARSE_TIMEOUT_MS = 2000
const CHUNK = 64 * 1024

export class AuditManifestError extends Error {
  constructor(readonly code: string, message: string, readonly version?: number | 'unknown') { super(message) }
}

// Plain JavaScript runs identically from TS source and bundled CLI. Never send
// complete manifest objects back to the parent or parse them on its event loop.
const PARSER = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', bytes => {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes));
    if (!value || value.v !== 2 || !Array.isArray(value.skills) || value.skills.length > 8192) throw Error('Invalid v2 manifest');
    const refs = new Set();
    for (const skill of value.skills) {
      if (!skill || typeof skill !== 'object' || Array.isArray(skill)) throw Error('Invalid skill');
      if (skill.packageRef !== undefined) {
        if (typeof skill.packageRef !== 'string' || !/^[a-f0-9]{64}$/.test(skill.packageRef)) throw Error('Invalid package reference');
        refs.add(skill.packageRef);
      }
    }
    parentPort.postMessage({refs:[...refs]});
  } catch (error) { parentPort.postMessage({error:String(error)}); }
});`

/** One sequential parser per audit; cancellation always awaits worker exit. */
export class AuditManifestReader {
  private worker?: Worker
  private unavailable?: AuditManifestError
  constructor(private readonly timeout = AUDIT_PARSE_TIMEOUT_MS, private readonly source = PARSER) {}

  async close(): Promise<void> { const worker = this.worker; this.worker = undefined; if (worker) await worker.terminate() }

  private async parse(bytes: Uint8Array, signal?: AbortSignal): Promise<string[]> {
    signal?.throwIfAborted()
    let worker: Worker
    try { worker = this.worker ??= new Worker(this.source, { eval: true, execArgv: [], env: {}, resourceLimits: { maxOldGenerationSizeMb: 64 } }) }
    catch (error) { throw this.unavailable = new AuditManifestError('parser_unavailable', String(error), 2) }
    try {
      return await new Promise<string[]>((accept, reject) => {
        const finish = (error?: unknown, refs?: string[]) => {
          clearTimeout(timer); signal?.removeEventListener('abort', abort)
          worker.removeListener('message', message); worker.removeListener('error', failed); worker.removeListener('exit', exited)
          if (error) reject(error); else accept(refs!)
        }
        const abort = () => finish(signal!.reason)
        const failed = (error: Error) => finish(new AuditManifestError('parser_unavailable', String(error), 2))
        const exited = () => failed(new Error('Audit parser exited'))
        const message = (reply: { refs?: string[]; error?: string }) => reply.error
          ? finish(new AuditManifestError('invalid_manifest', reply.error, 2)) : finish(undefined, reply.refs)
        const timer = setTimeout(() => finish(new AuditManifestError('parse_timeout', 'Manifest parsing exceeded its time budget', 2)), this.timeout)
        signal?.addEventListener('abort', abort, { once: true })
        worker.once('message', message); worker.once('error', failed); worker.once('exit', exited)
        worker.postMessage(bytes, [bytes.buffer as ArrayBuffer])
      })
    } catch (error) {
      if (error instanceof AuditManifestError && error.code === 'parser_unavailable') this.unavailable = error
      await this.close(); throw error
    }
  }

  async read(entry: StorageEntry, signal?: AbortSignal): Promise<{ version: number | 'unknown'; refs: string[] }> {
    signal?.throwIfAborted()
    const same = (st: { dev: number; ino: number; size: number; mtimeMs: number }) => st.dev === entry.dev && st.ino === entry.ino && st.size === entry.bytes && st.mtimeMs === entry.mtimeMs
    const changed = () => new AuditManifestError('manifest_changed', 'Manifest changed or contains a symbolic path')
    const before = await lstat(entry.path)
    if (!before.isFile() || !same(before) || await realpath(entry.path) !== resolve(entry.path)) throw changed()
    const file = await open(entry.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    let version: number | 'unknown' = 'unknown'
    try {
      if (!same(await file.stat())) throw changed()
      const header = Buffer.alloc(128), first = await file.read(header, 0, header.length, 0)
      const match = /^\s*\{\s*"v"\s*:\s*(\d+)/.exec(header.subarray(0, first.bytesRead).toString())
      version = match ? Number(match[1]) : 'unknown'
      if (first.bytesRead > entry.bytes) throw changed()
      if (version !== 2) return { version, refs: [] }
      if (entry.bytes > AUDIT_MANIFEST_LIMIT) throw new AuditManifestError('manifest_too_large', 'Manifest exceeds 8 MiB audit limit', version)
      if (this.unavailable) throw this.unavailable
      const bytes = new Uint8Array(entry.bytes + 1)
      bytes.set(header.subarray(0, first.bytesRead))
      let offset = first.bytesRead
      while (offset < bytes.length) {
        signal?.throwIfAborted()
        const { bytesRead } = await file.read(bytes, offset, Math.min(CHUNK, bytes.length - offset), offset)
        if (!bytesRead) break
        offset += bytesRead
      }
      if (offset !== entry.bytes || !same(await file.stat()) || !same(await lstat(entry.path)) || await realpath(entry.path) !== resolve(entry.path)) throw changed()
      signal?.throwIfAborted()
      // Include only the exact JSON bytes, excluding the growth sentinel.
      return { version, refs: await this.parse(bytes.subarray(0, offset), signal) }
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof AuditManifestError && error.version === undefined) throw new AuditManifestError(error.code, error.message, version)
      throw error
    } finally { await file.close() }
  }
}
