import { grantPath } from '../tools/path-grants.js'
import { projectSurfaceAllowed } from '../config/project-trust.js'
import { applySessionSkillModes } from './session-skill-policy.js'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getSessionDir } from '../agent/session-persist.js'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { SkillRegistry, skillRegistry, BUILTIN_SKILLS, type SkillDefinition } from './skill-loader.js'
import { SkillManagement, type SkillOrigin } from './skill-management.js'
import { isSafeFileName } from '../utils/safe-path.js'
import { assertValidSessionId } from '../validation.js'
import { validateResourcePath, type PackageFile, type SkillPackage } from './skill-package.js'
import { assertSkillStoragePath, SkillVersionStore } from './skill-version-store.js'
import { sessionsDir } from '../config/paths.js'
import { registerStorageRuntime } from '../storage/maintenance-gate.js'

interface FrozenSkill extends Omit<SkillDefinition, 'triggers'> { triggers: string[]; origin?: SkillOrigin; packageRef?: string }
interface LegacySkill extends FrozenSkill { resources: PackageFile[] }
export interface SkillSnapshot { v: 2; skills: FrozenSkill[] }
export interface LegacySnapshot { v: 1; skills: LegacySkill[] }

export function parseSkillSnapshot(text: string): SkillSnapshot | LegacySnapshot {
  const snapshot = JSON.parse(text) as SkillSnapshot | LegacySnapshot
  if (!snapshot || ![1, 2].includes(snapshot.v) || !Array.isArray(snapshot.skills)) throw new Error('Invalid session skill snapshot; refusing to replace its pinned versions')
  const names = new Set<string>()
  for (const skill of snapshot.skills) {
    validateResourcePath(skill.name)
    if (!isSafeFileName(skill.name) || names.has(skill.name) || typeof skill.body !== 'string' || !Array.isArray(skill.triggers)
      || skill.triggers.some(t => typeof t !== 'string') || skill.packageRef !== undefined && !/^[a-f0-9]{64}$/.test(skill.packageRef)) throw new Error('Invalid snapshot skill')
    names.add(skill.name)
    if (skill.files !== undefined) {
      if (!Array.isArray(skill.files)) throw new Error('Invalid snapshot files')
      for (const file of skill.files) validateResourcePath(file.path)
    }
    if (snapshot.v === 1 && !Array.isArray((skill as LegacySkill).resources)) throw new Error('Invalid snapshot resources')
    if (snapshot.v === 2 && 'resources' in skill) throw new Error('Inline resources are not allowed in v2 snapshots')
  }
  return snapshot
}

/** v1 bytes remain authoritative, including old caches. Never consult today's installed source. */
export function upgradeSkillSnapshot(snapshot: SkillSnapshot | LegacySnapshot, store: SkillVersionStore): SkillSnapshot {
  if (snapshot.v === 2) return snapshot
  return { v: 2, skills: snapshot.skills.map(({ resources, ...skill }) => ({ ...skill, packageRef: resources.length ? store.put(resources) : undefined })) }
}

function activeNames(path: string): string[] {
  assertSkillStoragePath(path)
  if (!existsSync(path)) return []
  const state = JSON.parse(readFileSync(path, 'utf8')) as { v: number; names: string[] }
  if (state.v !== 1 || !Array.isArray(state.names) || state.names.some(name => typeof name !== 'string' || !isSafeFileName(name))) throw new Error('Invalid session skill resource state')
  return state.names
}

/** A registry belongs to a session. Catalog updates cannot replace pinned definitions or resources. */
export function sessionSkillSnapshot(cwd: string, sessionId?: string, management = new SkillManagement(), options: { purpose: 'catalog' | 'execute' } = { purpose: 'catalog' }): SkillRegistry {
  if (sessionId) assertValidSessionId(sessionId)
  const path = sessionId ? join(getSessionDir(cwd), `${sessionId}.skills.json`) : undefined
  const store = new SkillVersionStore()
  let snapshot: SkillSnapshot | LegacySnapshot, legacy = false
  let pendingPackages: Map<string, SkillPackage> | undefined
  const execute = options.purpose === 'execute'
  if (execute && path) registerStorageRuntime(sessionsDir())
  if (path && existsSync(path)) {
    assertSkillStoragePath(path)
    const saved = parseSkillSnapshot(readFileSync(path, 'utf8'))
    legacy = saved.v === 1
    snapshot = saved
  } else {
    const listCwd = projectSurfaceAllowed(cwd, 'skills') ? cwd : undefined
    const packages = new Map<string, SkillPackage>()
    if (!execute && path) pendingPackages = packages
    const catalog = management.list(listCwd, (source, pkg) => packages.set(source, pkg))
    snapshot = { v: 2, skills: catalog.skills.filter(s => !s.shadowedBy).map(s => {
      const pkg = s.path ? packages.get(s.path) : undefined
      const definition = pkg?.definition ?? skillRegistry.get(s.name) ?? BUILTIN_SKILLS.find(def => def.name === s.name)
      if (!definition) throw new Error(`Missing skill definition: ${s.name}`)
      return { ...definition, skillId: s.skillId, version: pkg?.fingerprint ?? s.version, origin: s.origin, name: s.name, source: s.source,
        bodyPath: s.path, skillDir: undefined, mode: s.mode, triggers: definition.triggers.map(t => t.source),
        packageRef: path && pkg ? execute ? store.put(pkg.files) : store.reference(pkg.files) : undefined,
        files: (pkg?.files.map(f => f.path) ?? []).filter(p => p !== 'SKILL.md').map(p => ({ path: p, kind: 'file' as const })) }
    }) }
    if (path && execute) { assertSkillStoragePath(path); writeFileAtomicSync(path, JSON.stringify(snapshot)) }
  }
  const registry = new SkillRegistry()
  const statePath = sessionId ? join(getSessionDir(cwd), sessionId, 'skill-resources.json') : undefined
  const used = statePath ? activeNames(statePath) : []
  const pinPending = () => {
    if (!pendingPackages || !path) return
    registerStorageRuntime(sessionsDir())
    assertSkillStoragePath(path)
    for (const skill of snapshot.skills) {
      const pkg = skill.bodyPath ? pendingPackages.get(skill.bodyPath) : undefined
      if (pkg) store.put(pkg.files)
    }
    const serialized = JSON.stringify(snapshot)
    if (existsSync(path) && readFileSync(path, 'utf8') !== serialized) throw new Error('Session skill snapshot changed; retry invocation')
    if (!existsSync(path)) writeFileAtomicSync(path, serialized)
    pendingPackages = undefined
  }
  for (const raw of snapshot.skills) {
    const { resources, ...skill } = raw as LegacySkill
    const skillDir = skill.files?.length ? path ? join(getSessionDir(cwd), sessionId!, 'skills', skill.name) : skill.bodyPath ? dirname(skill.bodyPath) : undefined : undefined
    registry.register({ ...skill, skillDir, triggers: skill.triggers.map(t => new RegExp(t, 'i')) })
    if (pendingPackages) registry.setResourceLoader(skill.name, pinPending)
    if (!skillDir || !path || !(skill.packageRef || resources?.length) || !statePath) continue
    let ready = false
    registry.setResourceLoader(skill.name, () => {
      if (ready && existsSync(skillDir)) return
      registerStorageRuntime(sessionsDir())
      pinPending()
      const ref = skill.packageRef ?? store.put(resources!)
      store.materialize(ref, skillDir)
      // Keep all ever-used names, even after complete/compact, so historical paths survive resume.
      const names = new Set(activeNames(statePath))
      if (!names.has(skill.name)) {
        names.add(skill.name)
        writeFileAtomicSync(statePath, JSON.stringify({ v: 1, names: [...names].sort() }))
      }
      grantPath(skillDir, 'read', { cwd, persist: false })
      ready = true
    })
    // v1 eagerly exposed every directory; retain historical paths even if they were deleted.
    if (execute && (legacy || used.includes(skill.name) || existsSync(skillDir))) registry.ensureResources(skill.name)
  }
  applySessionSkillModes(cwd, sessionId, registry)
  return registry
}
