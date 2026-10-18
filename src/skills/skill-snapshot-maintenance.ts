import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSessionDir } from '../agent/session-persist.js'
import { assertValidSessionId } from '../validation.js'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { parseSkillSnapshot, upgradeSkillSnapshot } from './session-skill-snapshot.js'
import { assertSkillStoragePath, SkillVersionStore } from './skill-version-store.js'
import { acquireStorageMaintenance } from '../storage/maintenance-gate.js'
import { sessionsDir } from '../config/paths.js'

/** Explicit maintenance only. Never delete private skill directories or unreferenced versions. */
export function migrateSessionSkillSnapshot(cwd: string, sessionId: string, apply = false) {
  assertValidSessionId(sessionId)
  const path = join(getSessionDir(cwd), `${sessionId}.skills.json`)
  assertSkillStoragePath(path)
  const original = readFileSync(path, 'utf8'), snapshot = parseSkillSnapshot(original)
  if (snapshot.v === 2) return { sessionId, version: 2, applied: false, beforeBytes: Buffer.byteLength(original), afterBytes: Buffer.byteLength(original), reclaimableBytes: 0 }
  const store = new SkillVersionStore(undefined, undefined, { maintenance: apply })
  const resources = snapshot.skills.reduce((sum, skill) => sum + skill.resources.reduce((n, file) => n + Buffer.from(file.data, 'base64').length, 0), 0)
  if (!apply) {
    const preview = { v: 2, skills: snapshot.skills.map(({ resources, ...skill }) => ({ ...skill, packageRef: resources.length ? store.reference(resources) : undefined })) }
    const afterBytes = Buffer.byteLength(JSON.stringify(preview))
    return { sessionId, version: 1, applied: false, beforeBytes: Buffer.byteLength(original), afterBytes,
      reclaimableBytes: Buffer.byteLength(original) - afterBytes, inlineResourceBytes: resources }
  }
  const release = acquireStorageMaintenance(sessionsDir())
  try {
    const upgraded = upgradeSkillSnapshot(snapshot, store)
    const serialized = JSON.stringify(upgraded)
    // Legacy sessions may refer to every old path. Persist this before dropping inline bytes.
    const statePath = join(getSessionDir(cwd), sessionId, 'skill-resources.json')
    assertSkillStoragePath(statePath)
    writeFileAtomicSync(statePath, JSON.stringify({ v: 1, names: upgraded.skills.filter(s => s.files?.length).map(s => s.name).sort() }))
    // Do not overwrite a concurrent writer's snapshot with our earlier observation.
    if (readFileSync(path, 'utf8') !== original) throw new Error('Session snapshot changed during migration')
    writeFileAtomicSync(path, serialized)
    return { sessionId, version: 2, applied: true, beforeBytes: Buffer.byteLength(original), afterBytes: Buffer.byteLength(serialized), reclaimableBytes: Buffer.byteLength(original) - Buffer.byteLength(serialized) }
  } finally { release() }
}

/** A self-contained v1 skill snapshot can be restored without the original shared store. */
export function exportSessionSkillSnapshot(cwd: string, sessionId: string, output: string) {
  assertValidSessionId(sessionId)
  const path = join(getSessionDir(cwd), `${sessionId}.skills.json`)
  assertSkillStoragePath(path)
  if (existsSync(output)) throw new Error('Skill snapshot export destination already exists')
  const snapshot = parseSkillSnapshot(readFileSync(path, 'utf8')), store = new SkillVersionStore()
  const portable = snapshot.v === 1 ? snapshot : { v: 1, skills: snapshot.skills.map(({ packageRef, ...skill }) => ({ ...skill, skillDir: undefined, resources: packageRef ? store.export(packageRef) : [] })) }
  writeFileAtomicSync(output, JSON.stringify(portable))
  return { sessionId, output, version: 1 }
}
