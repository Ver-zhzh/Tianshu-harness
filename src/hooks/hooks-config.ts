import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { isProjectTrusted, notifyUntrustedOnce } from '../config/project-trust.js'
import type { HookEntry, HooksConfig } from './user-hooks-runner.js'

export const VALID_EVENTS = new Set(['preTurn', 'postTurn', 'postTool', 'postSession', 'onError'])
export function validHookTimeout(value: unknown): value is number | undefined {
  return value === undefined || typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export async function loadHooksConfig(cwd: string, signal?: AbortSignal): Promise<HooksConfig> {
  if (!isProjectTrusted(cwd)) {
    notifyUntrustedOnce('hooks', cwd)
    return { hooks: [] }
  }
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    if (signal?.aborted) return { hooks: [] }
    file = await open(join(cwd, '.rivet', 'hooks.json'), 'r')
    const buffer = Buffer.alloc(262_145)
    let bytes = 0
    while (bytes < buffer.length) {
      if (signal?.aborted) return { hooks: [] }
      const read = await file.read(buffer, bytes, buffer.length - bytes, null)
      if (!read.bytesRead) break
      bytes += read.bytesRead
    }
    if (bytes > 262_144) return { hooks: [], diagnostics: ['Hook configuration exceeds 256KiB'] }
    const value = JSON.parse(buffer.subarray(0, bytes).toString('utf8')) as { hooks?: unknown }
    if (!Array.isArray(value.hooks) || value.hooks.length > 128) return { hooks: [], diagnostics: ['Invalid hook list (maximum 128)'] }
    const hooks: HookEntry[] = []
    const diagnostics: string[] = []
    for (const entry of value.hooks) {
      if (!entry || typeof entry !== 'object' || !VALID_EVENTS.has(entry.event) || typeof entry.script !== 'string' || !entry.script.trim() || !validHookTimeout(entry.timeoutMs)) {
        diagnostics.push('Skipped invalid hook entry; timeoutMs must be a positive integer')
      } else hooks.push({ event: entry.event, script: entry.script.trim(), ...(entry.timeoutMs === undefined ? {} : { timeoutMs: entry.timeoutMs }) })
    }
    return { hooks, ...(diagnostics.length ? { diagnostics } : {}) }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' || signal?.aborted
      ? { hooks: [] } : { hooks: [], diagnostics: ['Could not read hook configuration'] }
  } finally { await file?.close().catch(() => {}) }
}
