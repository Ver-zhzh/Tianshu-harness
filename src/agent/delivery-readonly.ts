import { readFileSync } from 'node:fs'
import { detectWroteButNeverRead, detectReadButNeverProduced } from './wiring-nudge.js'
import { scanFilesForProbes } from './probe-detector.js'
import { checkStructureGate } from './structure-gate.js'
import { evidenceProcess } from '../workers/evidence-process.js'

/** Invoked only in the disposable process; individual advisory failures stay isolated. */
export function scanDeliveryFiles(cwd: string, files: string[]) {
  const attempt = <T>(fn: () => T): T | undefined => { try { return fn() } catch { return undefined } }
  return {
    dead: attempt(() => detectWroteButNeverRead(cwd, files)),
    falseGreen: attempt(() => detectReadButNeverProduced(cwd, files)),
    probes: attempt(() => scanFilesForProbes(files, cwd, path => { try { return readFileSync(path, 'utf8') } catch { return null } })),
    structure: attempt(() => checkStructureGate(files, cwd)),
  }
}

export async function scanDeliveryFilesAsync(cwd: string, files: string[], signal?: AbortSignal): Promise<ReturnType<typeof scanDeliveryFiles>> {
  const worker = evidenceProcess(Date.now() + 10_000, signal)
  try { return await worker.call('delivery-scan', [cwd, files]) }
  finally { worker.dispose() }
}
