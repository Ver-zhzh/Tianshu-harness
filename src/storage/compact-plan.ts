import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import { sessionsDir } from '../config/paths.js'
import { canonicalStoragePath } from '../platform/test-session-isolation.js'
import { inside, type PackageFile } from '../skills/skill-package.js'
import { parseSkillSnapshot, type SkillSnapshot, type LegacySnapshot } from '../skills/session-skill-snapshot.js'
import { assertSkillStoragePath, SkillVersionStore } from '../skills/skill-version-store.js'
import { scanStorage, type ScanError } from './scan.js'

export const hash = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
export interface FileIdentity { dev: number; ino: number; size: number; mtimeMs: number }
export interface PruneCandidate { path: string; hash: string; identity: FileIdentity; allocatedBytes: number }
export interface CompactEntry {
  manifest: string; beforeHash: string; afterHash: string; identity: FileIdentity; afterBytes: number; version: 1 | 2
  packages: string[]; prune: PruneCandidate[]
}
export interface CompactPlan {
  v: 1; root: string; rootIdentity: { dev: number; ino: number }; createdAt: string; entries: CompactEntry[]
  skipped: ScanError[]; estimate: { manifestSavings: number; privateSavings: number; newSharedBytes: number; netLogicalBytes: number; removableAllocatedBytes: number }
}
export const identity = (st: { dev: number; ino: number; size: number; mtimeMs: number }): FileIdentity => ({ dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs })
export const sameIdentity = (a: FileIdentity, b: FileIdentity): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs

export function previewUpgrade(snapshot: SkillSnapshot | LegacySnapshot, store: SkillVersionStore): SkillSnapshot {
  return snapshot.v === 2 ? snapshot : { v: 2, skills: snapshot.skills.map(({ resources, ...skill }) => ({ ...skill, packageRef: resources.length ? store.reference(resources) : undefined })) }
}

/** Only authoritative manifest resources may produce delete candidates. No directory heuristics. */
export function resourcesFor(snapshot: SkillSnapshot | LegacySnapshot, store: SkillVersionStore): Array<{ name: string; files: PackageFile[] }> {
  return snapshot.skills.map(skill => ({ name: skill.name, files: snapshot.v === 1 ? (skill as LegacySnapshot['skills'][number]).resources : skill.packageRef ? store.export(skill.packageRef) : [] }))
}

export async function buildCompactPlan(options: { root?: string; signal?: AbortSignal; onProgress?: (snapshots: number) => void } = {}): Promise<CompactPlan> {
  const root = canonicalStoragePath(options.root ?? sessionsDir()), rootStat = await lstat(root)
  const store = new SkillVersionStore(join(root, '_skill-store/v1'), root)
  const plan: CompactPlan = { v: 1, root, rootIdentity: { dev: rootStat.dev, ino: rootStat.ino }, createdAt: new Date().toISOString(), entries: [], skipped: [],
    estimate: { manifestSavings: 0, privateSavings: 0, newSharedBytes: 0, netLogicalBytes: 0, removableAllocatedBytes: 0 } }
  const newVersions = new Map<string, number>()
  for await (const entry of scanStorage([root], plan.skipped, options.signal, { skipControl: true })) {
    if (!entry.path.endsWith('.skills.json') || entry.symlink || entry.relative.split('/').length > 2) continue
    try {
      assertSkillStoragePath(entry.path, root)
      if (entry.bytes > 128 * 1024 * 1024) throw new Error('Snapshot exceeds bounded migration size')
      const original = await readFile(entry.path), snapshot = parseSkillSnapshot(original.toString('utf8'))
      const upgraded = previewUpgrade(snapshot, store), serialized = snapshot.v === 2 ? original : Buffer.from(JSON.stringify(upgraded))
      const item: CompactEntry = { manifest: entry.relative, beforeHash: hash(original), afterHash: hash(serialized), identity: identity({ ...entry, size: entry.bytes }), afterBytes: serialized.length,
        version: snapshot.v, packages: upgraded.skills.flatMap(s => s.packageRef ? [s.packageRef] : []), prune: [] }
      const id = basename(entry.path).slice(0, -'.skills.json'.length), parent = dirname(entry.path)
      for (const resource of resourcesFor(snapshot, store)) {
        const ref = resource.files.length ? store.reference(resource.files) : undefined
        if (ref) {
          const shared = join(store.root, ref)
          try { await lstat(shared); store.verify(ref) }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || snapshot.v === 2) throw error
            // Include the new index as well as raw payloads in the net savings estimate.
            const index = { v: 1, files: resource.files.map(f => ({ path: f.path, size: Buffer.from(f.data, 'base64').length,
              hash: hash(Buffer.from(f.data, 'base64')), executable: f.executable })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) }
            newVersions.set(ref, resource.files.reduce((n, f) => n + Buffer.from(f.data, 'base64').length, 0) + Buffer.byteLength(JSON.stringify(index)))
          }
        }
        for (const file of resource.files) {
          const path = inside(join(parent, id, 'skills', resource.name), file.path)
          assertSkillStoragePath(path, root)
          let st
          try { st = await lstat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
          if (!st.isFile() || st.isSymbolicLink()) { plan.skipped.push({ path, error: 'Not a regular resource file' }); continue }
          const expected = Buffer.from(file.data, 'base64')
          if (st.size !== expected.length || !await readFile(path).then(bytes => bytes.equals(expected)) || ((st.mode & 0o111) !== 0) !== file.executable) {
            plan.skipped.push({ path, error: 'Modified resource retained' }); continue
          }
          item.prune.push({ path: relative(root, path).replaceAll('\\', '/'), hash: hash(expected), identity: identity(st), allocatedBytes: typeof st.blocks === 'number' ? st.blocks * 512 : st.size })
        }
      }
      if (!sameIdentity(item.identity, identity(await lstat(entry.path)))) throw new Error('Snapshot changed during preview')
      if (snapshot.v === 1 || item.prune.length) {
        plan.entries.push(item)
        plan.estimate.manifestSavings += original.length - serialized.length
        plan.estimate.privateSavings += item.prune.reduce((n, p) => n + p.identity.size, 0)
        plan.estimate.removableAllocatedBytes += item.prune.reduce((n, p) => n + p.allocatedBytes, 0)
      }
    } catch (error) { plan.skipped.push({ path: entry.path, error: String(error) }) }
    options.onProgress?.(plan.entries.length)
    await yieldToLoop()
  }
  plan.estimate.newSharedBytes = [...newVersions.values()].reduce((n, size) => n + size, 0)
  plan.estimate.netLogicalBytes = plan.estimate.manifestSavings + plan.estimate.privateSavings - plan.estimate.newSharedBytes
  return plan
}
