import { lstat, mkdir, readFile, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { writeFileAtomicDurableAsync } from '../fs-atomic.js'
import { sessionsDir } from '../config/paths.js'
import { canonicalStoragePath } from '../platform/test-session-isolation.js'
import { inside } from '../skills/skill-package.js'
import { parseSkillSnapshot, upgradeSkillSnapshot } from '../skills/session-skill-snapshot.js'
import { assertSkillStoragePath, SkillVersionStore } from '../skills/skill-version-store.js'
import { assertValidSessionId } from '../validation.js'
import { acquireStorageMaintenance } from './maintenance-gate.js'
import { hash, identity, previewUpgrade, resourcesFor, sameIdentity, type CompactPlan, type CompactEntry } from './compact-plan.js'

interface EntryProgress { status: 'prepared' | 'done' | 'skipped'; manifestSavings: number; privateSavings: number; reason?: string }
interface Progress { v: 1; planHash: string; entries: Record<string, EntryProgress> }
export interface ApplyResult { completed: number; skipped: number; manifestSavings: number; privateSavings: number; journal: string }

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

function manifestPath(root: string, item: CompactEntry): string {
  if (typeof item.manifest !== 'string' || item.manifest.split('/').length > 2 || !item.manifest.endsWith('.skills.json')) throw new Error('Invalid planned manifest')
  const id = basename(item.manifest).slice(0, -'.skills.json'.length)
  assertValidSessionId(id)
  const path = inside(root, item.manifest)
  assertSkillStoragePath(path, root)
  return path
}

/** Only removes empty resource ancestors, stopping at the skill cache root. */
async function removeEmptyAncestors(path: string, stop: string): Promise<void> {
  let directory = dirname(path)
  while (directory !== stop && directory.startsWith(stop + (process.platform === 'win32' ? '\\' : '/'))) {
    try { await rmdir(directory) }
    catch (error) {
      if (['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) return
      throw error
    }
    directory = dirname(directory)
  }
}

export async function applyCompactPlan(planFile: string, options: { root?: string; signal?: AbortSignal; onProgress?: (result: ApplyResult) => void } = {}): Promise<ApplyResult> {
  const root = canonicalStoragePath(options.root ?? sessionsDir()), raw = await readFile(planFile), plan = JSON.parse(raw.toString()) as CompactPlan
  const st = await lstat(root)
  if (plan.v !== 1 || plan.root !== root || !Array.isArray(plan.entries) || plan.rootIdentity?.dev !== st.dev || plan.rootIdentity?.ino !== st.ino) throw new Error('Plan root does not match current storage; create a new preview')
  const seen = new Set<string>()
  for (const item of plan.entries) {
    manifestPath(root, item)
    if (seen.has(item.manifest) || !Array.isArray(item.prune) || !Array.isArray(item.packages)) throw new Error('Invalid or duplicate compaction entry')
    seen.add(item.manifest)
  }
  const release = acquireStorageMaintenance(root)
  try {
    const lockedRoot = await lstat(root)
    if (lockedRoot.dev !== plan.rootIdentity.dev || lockedRoot.ino !== plan.rootIdentity.ino) throw new Error('Storage root changed during maintenance acquisition')
    const journal = planFile + '.progress'
    const journalMeta = join(journal, 'index.json')
    assertSkillStoragePath(journalMeta, dirname(planFile))
    const progress: Progress = { v: 1, planHash: hash(raw), entries: {} }
    if (await exists(journalMeta)) {
      const meta = JSON.parse(await readFile(journalMeta, 'utf8')) as Progress
      if (meta.v !== 1 || meta.planHash !== hash(raw)) throw new Error('Progress journal belongs to a different plan')
      for (const item of plan.entries) {
        const entryFile = join(journal, hash(item.manifest) + '.json')
        assertSkillStoragePath(entryFile, dirname(planFile))
        if (await exists(entryFile)) {
          const state = JSON.parse(await readFile(entryFile, 'utf8')) as EntryProgress
          if (!['prepared', 'done', 'skipped'].includes(state.status) || !Number.isFinite(state.manifestSavings) || !Number.isFinite(state.privateSavings)) throw new Error('Invalid compaction progress')
          progress.entries[item.manifest] = state
        }
      }
    }
    const save = (manifest: string) => writeFileAtomicDurableAsync(join(journal, hash(manifest) + '.json'), JSON.stringify(progress.entries[manifest]))
    const result = (): ApplyResult => {
      const values = Object.values(progress.entries)
      return { completed: values.filter(e => e.status === 'done').length, skipped: values.filter(e => e.status === 'skipped').length,
        manifestSavings: values.reduce((n, e) => n + (e.status === 'done' ? e.manifestSavings : 0), 0),
        privateSavings: values.reduce((n, e) => n + (e.status === 'done' ? e.privateSavings : 0), 0), journal }
    }
    const store = new SkillVersionStore(join(root, '_skill-store/v1'), root, { maintenance: true })
    const synced = new Set<string>()
    await mkdir(journal, { recursive: true, mode: 0o700 })
    if (!await exists(journalMeta)) await writeFileAtomicDurableAsync(journalMeta, JSON.stringify({ v: 1, planHash: hash(raw) }))
    let processed = 0
    for (const item of plan.entries) {
      options.signal?.throwIfAborted()
      if (progress.entries[item.manifest]?.status === 'done' || progress.entries[item.manifest]?.status === 'skipped') continue
      const path = manifestPath(root, item)
      if (!await exists(path)) {
        progress.entries[item.manifest] = { status: 'skipped', manifestSavings: 0, privateSavings: 0, reason: 'Snapshot disappeared; create a new preview' }
        await save(item.manifest); continue
      }
      const original = await readFile(path), currentHash = hash(original)
      const resumed = progress.entries[item.manifest]?.status === 'prepared'
      if (currentHash !== item.beforeHash && !(resumed && currentHash === item.afterHash)
        || !resumed && !sameIdentity(item.identity, identity(await lstat(path)))) {
        progress.entries[item.manifest] = { status: 'skipped', manifestSavings: 0, privateSavings: 0, reason: 'Snapshot changed; create a new preview' }
        await save(item.manifest); continue
      }
      const snapshot = parseSkillSnapshot(original.toString()), upgradedPreview = previewUpgrade(snapshot, store)
      const serialized = snapshot.v === 2 ? original : Buffer.from(JSON.stringify(upgradedPreview))
      if (hash(serialized) !== item.afterHash || serialized.length !== item.afterBytes
        || JSON.stringify(upgradedPreview.skills.flatMap(s => s.packageRef ? [s.packageRef] : [])) !== JSON.stringify(item.packages)) throw new Error('Plan does not match authoritative snapshot resources')
      const id = basename(path).slice(0, -'.skills.json'.length), cache = join(dirname(path), id, 'skills')
      const allowed = new Map<string, { hash: string; executable: boolean }>()
      for (const resource of resourcesFor(snapshot, store)) for (const file of resource.files) {
        allowed.set(relative(root, inside(join(cache, resource.name), file.path)).replaceAll('\\', '/'), { hash: hash(Buffer.from(file.data, 'base64')), executable: file.executable })
      }
      let drift = false
      for (const candidate of item.prune) {
        if (allowed.get(candidate.path)?.hash !== candidate.hash) throw new Error('Planned deletion is not an authoritative skill resource')
        const target = inside(root, candidate.path)
        assertSkillStoragePath(target, root)
        if (resumed && !await exists(target)) continue
        if (!await exists(target)) { drift = true; break }
        const file = await lstat(target)
        if (!file.isFile() || file.isSymbolicLink() || !sameIdentity(candidate.identity, identity(file)) || ((file.mode & 0o111) !== 0) !== allowed.get(candidate.path)!.executable
          || hash(await readFile(target)) !== candidate.hash) { drift = true; break }
      }
      if (drift) {
        progress.entries[item.manifest] = { status: 'skipped', manifestSavings: 0, privateSavings: 0, reason: 'Resource changed; create a new preview' }
        await save(item.manifest); continue
      }
      // Persist intent first. Both old-v1 and committed-v2 states are valid on restart.
      progress.entries[item.manifest] = { status: 'prepared', manifestSavings: item.identity.size - item.afterBytes,
        privateSavings: item.prune.reduce((n, p) => n + p.identity.size, 0) }
      await save(item.manifest)
      const upgraded = upgradeSkillSnapshot(snapshot, store)
      for (const ref of item.packages) {
        store.verify(ref)
        if (!synced.has(ref)) { store.sync(ref); synced.add(ref) }
      }
      const statePath = join(dirname(path), id, 'skill-resources.json')
      assertSkillStoragePath(statePath, root)
      let names: string[] = []
      if (await exists(statePath)) {
        const state = JSON.parse(await readFile(statePath, 'utf8')) as { v: number; names: string[] }
        if (state.v !== 1 || !Array.isArray(state.names) || state.names.some(n => typeof n !== 'string')) throw new Error('Invalid resource usage state')
        names = state.names
      }
      if (snapshot.v === 1) names.push(...upgraded.skills.filter(s => s.files?.length).map(s => s.name))
      await writeFileAtomicDurableAsync(statePath, JSON.stringify({ v: 1, names: [...new Set(names)].sort() }))
      if (hash(await readFile(path)) !== currentHash) throw new Error('Snapshot changed during maintenance')
      if (snapshot.v === 1) await writeFileAtomicDurableAsync(path, serialized)
      // Every shared version is durable and checked before any private byte is removed.
      for (const candidate of item.prune) {
        options.signal?.throwIfAborted()
        const target = inside(root, candidate.path)
        assertSkillStoragePath(target, root)
        if (!await exists(target)) continue
        const current = await lstat(target)
        if (!sameIdentity(candidate.identity, identity(current)) || ((current.mode & 0o111) !== 0) !== allowed.get(candidate.path)!.executable
          || hash(await readFile(target)) !== candidate.hash) throw new Error('Resource changed during maintenance; stopped')
        await unlink(target)
        await removeEmptyAncestors(target, cache)
      }
      progress.entries[item.manifest]!.status = 'done'
      await save(item.manifest)
      if (++processed % 128 === 0) options.onProgress?.(result())
    }
    return result()
  } finally { release() }
}
