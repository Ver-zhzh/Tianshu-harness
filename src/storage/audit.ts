import { access } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { desktopSessionsDir, sessionsDir } from '../config/paths.js'
import { canonicalStoragePath } from '../platform/test-session-isolation.js'
import { scanStorage, distinctStorageRoots, type ScanError, type StorageEntry } from './scan.js'
import { AuditManifestReader, AuditManifestError } from './audit-manifest.js'

interface Usage { files: number; logicalBytes: number; allocatedBytes: number }
const usage = (): Usage => ({ files: 0, logicalBytes: 0, allocatedBytes: 0 })
export interface StorageAudit {
  roots: string[]; totals: Usage; categories: Record<string, Usage>; projects: Record<string, Usage>; roles: Record<string, Usage>
  snapshotVersions: Record<string, number>; suspectedOrphans: Usage; sharedVersions: { total: number; unreferenced: number; referenceScanComplete: boolean }
  errors: ScanError[]; completed: boolean
}
export function storageCategory(entry: StorageEntry, desktopRoot: string): string {
  const parts = entry.relative.split('/'), name = basename(entry.path)
  if (parts[0] === '_storage-control') return 'maintenanceControl'
  if (parts[0] === '_skill-store') return 'sharedSkills'
  if (name.endsWith('.skills.json')) return 'skillManifests'
  if (parts[1] === 'skills' || parts[2] === 'skills') return 'expandedSkills'
  if (name === 'cache-log.jsonl') return 'cacheLogs'
  if (name === 'sensorium.jsonl') return 'telemetry'
  if (parts.includes('backups')) return 'backups'
  if (name.endsWith('.frozen.json')) return 'frozenPrefixes'
  if (entry.path.startsWith(desktopRoot + '/') || entry.path.startsWith(desktopRoot + '\\')) return 'desktopEvents'
  if (name.endsWith('.meta.json')) return 'metadata'
  if (name.endsWith('.jsonl')) return 'transcriptsAndOtherJsonl'
  return entry.symlink ? 'symlinks' : 'other'
}
function add(total: Usage, entry: StorageEntry) { total.files++; total.logicalBytes += entry.bytes; total.allocatedBytes += entry.allocatedBytes }
async function present(path: string) {
  try { await access(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

export async function auditStorage(options: { root?: string; desktopRoot?: string; signal?: AbortSignal; onProgress?: (files: number) => void } = {}): Promise<StorageAudit> {
  const root = canonicalStoragePath(options.root ?? sessionsDir()), desktopRoot = canonicalStoragePath(options.desktopRoot ?? desktopSessionsDir())
  const report: StorageAudit = { roots: distinctStorageRoots([root, desktopRoot]), totals: usage(), categories: {}, projects: {}, roles: {}, snapshotVersions: {}, suspectedOrphans: usage(),
    sharedVersions: { total: 0, unreferenced: 0, referenceScanComplete: true }, errors: [], completed: false }
  const referenced = new Set<string>(), stored = new Set<string>()
  const reader = new AuditManifestReader()
  try {
  for await (const entry of scanStorage(report.roots, report.errors, options.signal)) {
    add(report.totals, entry)
    const category = storageCategory(entry, desktopRoot)
    add(report.categories[category] ??= usage(), entry)
    add(report.projects[entry.relative.split('/')[0]!] ??= usage(), entry)
    const parts = entry.relative.split('/')
    const flatSessionChild = ['skills', 'backups', 'cache-log.jsonl', 'sensorium.jsonl', 'skill-resources.json'].includes(parts[1] ?? '')
    const owner = category === 'desktopEvents' ? relative(desktopRoot, entry.path).split(/[\\/]/)[0]! : parts.length === 1 || flatSessionChild ? parts[0]! : parts[1]!
    const role = category === 'sharedSkills' || category === 'maintenanceControl' ? 'sharedOrMaintenance' : owner.startsWith('worker-') ? 'worker' : 'mainOrOther'
    add(report.roles[role] ??= usage(), entry)
    if (category === 'sharedSkills' && basename(entry.path) === 'index.json') stored.add(basename(dirname(entry.path)))
    if (category === 'skillManifests' && entry.symlink) {
      report.errors.push({ path: entry.path, code: 'manifest_symbolic', error: 'Symbolic manifest skipped' })
      report.sharedVersions.referenceScanComplete = false
    }
    if (category === 'skillManifests' && !entry.symlink) {
      try {
        const id = basename(entry.path).slice(0, -'.skills.json'.length), directory = dirname(entry.path)
        if (!await present(join(directory, id + '.jsonl')) && !await present(join(directory, id + '.meta.json')) && !await present(join(desktopRoot, id, 'index.json'))) add(report.suspectedOrphans, entry)
        const { version, refs } = await reader.read(entry, options.signal)
        report.snapshotVersions[version] = (report.snapshotVersions[version] ?? 0) + 1
        if (version === 2) {
          for (const ref of refs) referenced.add(ref)
        } else if (version !== 1) report.sharedVersions.referenceScanComplete = false
      } catch (error) {
        options.signal?.throwIfAborted()
        if (error instanceof AuditManifestError && error.version !== undefined) report.snapshotVersions[error.version] = (report.snapshotVersions[error.version] ?? 0) + 1
        report.errors.push({ path: entry.path, error: String(error), ...(error instanceof AuditManifestError ? { code: error.code } : {}) })
        report.sharedVersions.referenceScanComplete = false
      }
    }
    if (report.totals.files % 128 === 0) options.onProgress?.(report.totals.files)
  }
  } finally { await reader.close() }
  options.signal?.throwIfAborted()
  report.sharedVersions.total = stored.size
  report.sharedVersions.referenceScanComplete &&= report.errors.length === 0 && !((report.snapshotVersions['1'] ?? 0) > 0)
  report.sharedVersions.unreferenced = report.sharedVersions.referenceScanComplete ? [...stored].filter(ref => !referenced.has(ref)).length : 0
  report.completed = true
  return report
}
