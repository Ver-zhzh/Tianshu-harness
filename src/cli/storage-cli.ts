import { writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { sessionsDir } from '../config/paths.js'
import { auditStorage } from '../storage/audit.js'
import { buildCompactPlan } from '../storage/compact-plan.js'
import { applyCompactPlan } from '../storage/compact-apply.js'
import { canonicalStoragePath } from '../platform/test-session-isolation.js'

export async function runStorageCLI(args: string[], options: { signal?: AbortSignal } = {}): Promise<{ output: string; exitCode: number }> {
  const value = (flag: string) => { const at = args.indexOf(flag); return at < 0 ? undefined : args[at + 1] }
  const root = canonicalStoragePath(value('--root') ?? sessionsDir())
  try {
    let result: unknown
    if (args[0] === 'audit') result = await auditStorage({ root, signal: options.signal })
    else if (args[0] === 'compact') {
      const planFile = value('--apply')
      if (args.includes('--apply')) {
        if (!planFile || planFile.startsWith('--') || args.includes('--dry-run')) throw new Error('Use storage compact --apply <reviewed-plan-file>')
        result = await applyCompactPlan(resolve(planFile), { root, signal: options.signal })
      } else {
        const plan = await buildCompactPlan({ root, signal: options.signal }), output = value('--output')
        if (output) {
          const path = canonicalStoragePath(output), rel = relative(root, path)
          if (rel === '' || !rel.startsWith('..') && !isAbsolute(rel)) throw new Error('Save the maintenance plan outside the session data root')
          // Exclusive creation: a preview never replaces an existing file.
          await writeFile(path, JSON.stringify(plan), { mode: 0o600, flag: 'wx' })
        }
        result = { dryRun: true, root, snapshots: plan.entries.length, skipped: plan.skipped.length, estimate: plan.estimate, planFile: output ? resolve(output) : undefined,
          note: output ? 'No session data changed. Stop all runtimes, review this plan, then apply explicitly.' : 'No files written. Use --output <new-plan-file> to save a reviewable plan.' }
      }
    } else throw new Error('Usage: storage audit --json | storage compact --dry-run [--output <new-plan-file>] | storage compact --apply <plan-file>')
    return { output: JSON.stringify(result, null, 2), exitCode: 0 }
  } catch (error) { return { output: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), exitCode: 1 } }
}
