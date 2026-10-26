import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { resolve, relative } from 'node:path'
import { realpathSync } from 'node:fs'
import { currentFileVersion } from '../agent/file-version.js'
import { classifyFingerprintPath } from '../agent/task-state-persist.js'
import { getResolvedEnv } from './resolved-env.js'
import { loadConfig } from '../config/manager.js'
import type { ToolCallParams } from './types.js'

export interface VerificationIdentity { requestKey: string; requestVersion: string; environmentFingerprint: string }
export function verificationIdentity(params: ToolCallParams, tool: 'bash' | 'run_tests'): VerificationIdentity | undefined {
  try {
    const version = params.currentVerificationFingerprint?.()
    if (!version) return undefined
    const hash = createHash('sha256').update(version)
    const canonicalCwd = realpathSync(params.cwd)
    const rootResult = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: params.cwd, encoding: 'utf8', windowsHide: true })
    if (rootResult.status !== 0) return undefined
    const root = rootResult.stdout.trim()
    const status = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=no'], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true })
    if (status.status !== 0) return undefined
    // Dirty tracked bytes only: no runnable-test discovery or snapshot creation.
    const paths = new Set<string>()
    for (const entry of status.stdout.split('\0')) {
      if (!/^[ MADRCU?!]{2} /.test(entry)) continue
      const path = entry.slice(3)
      if (!path.startsWith('.rivet/')) paths.add(resolve(root, path))
    }
    for (const key of ['files', 'deliveryFiles']) if (Array.isArray(params.input[key])) {
      for (const file of params.input[key] as unknown[]) if (typeof file === 'string') {
        const path = resolve(canonicalCwd, file)
        try { paths.add(realpathSync(path)) } catch { paths.add(path) }
      }
    }
    for (const path of [...paths].sort()) {
      if (classifyFingerprintPath(root, path) !== 'in-project') return undefined
      hash.update(relative(root, path)); hash.update(currentFileVersion(path) ?? 'missing')
    }
    const keys = tool === 'bash' ? ['command'] : ['files', 'filter', 'deliveryFiles', 'check', 'projects', 'shard', 'full', 'environment']
    const normalized: Record<string, unknown> = Object.fromEntries(keys.filter(key => params.input[key] !== undefined).map(key => [key, params.input[key]]))
    normalized.environment = params.input.environment ?? (params.input.deliveryFiles ? 'candidate' : 'workspace')
    for (const key of ['files', 'deliveryFiles', 'projects'] as const) if (Array.isArray(normalized[key])) {
      normalized[key] = [...new Set((normalized[key] as string[]).map(value => key === 'projects' ? value : resolve(canonicalCwd, value)))].sort()
    }
    const input = Object.fromEntries(Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b)))
    const requestKey = createHash('sha256').update(JSON.stringify([tool, canonicalCwd, input])).digest('hex')
    const env = getResolvedEnv(params.cwd)
    const environmentFingerprint = createHash('sha256').update(JSON.stringify([process.platform, process.version,
      Object.entries(env).sort(([a], [b]) => a.localeCompare(b)), loadConfig({ cwd: params.cwd }).verify])).digest('hex')
    return { requestKey, requestVersion: hash.digest('hex'), environmentFingerprint }
  } catch { return undefined }
}
