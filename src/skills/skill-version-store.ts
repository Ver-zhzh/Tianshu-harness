import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, constants, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { sessionsDir } from '../config/paths.js'
import { inside, validateResourcePath, type PackageFile } from './skill-package.js'
import { assertStorageMaintenance, registerStorageRuntime } from '../storage/maintenance-gate.js'

interface StoredFile { path: string; size: number; hash: string; executable: boolean }
interface PackageIndex { v: 1; files: StoredFile[] }
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const keyOf = (index: PackageIndex) => digest(JSON.stringify(index))

/** Refuse symlinks in managed paths, including a replaced parent directory. */
export function assertSkillStoragePath(path: string, boundary = sessionsDir()): void {
  const absolute = resolve(path), root = resolve(boundary)
  inside(root, relative(root, absolute))
  let current = root
  for (const segment of ['', ...relative(root, absolute).split(/[\\/]/).filter(Boolean)]) {
    if (segment) current = join(current, segment)
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error('Symbolic links are not supported in skill storage')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

export class SkillVersionStore {
  constructor(readonly root = join(sessionsDir(), '_skill-store', 'v1'), private readonly boundary = sessionsDir(), private readonly options: { maintenance?: boolean } = {}) {}

  private directory(ref: string): string {
    if (!/^[a-f0-9]{64}$/.test(ref)) throw new Error('Invalid skill package reference')
    const path = join(this.root, ref)
    assertSkillStoragePath(path, this.boundary)
    return path
  }

  private index(ref: string): PackageIndex {
    const directory = this.directory(ref), path = join(directory, 'index.json')
    assertSkillStoragePath(path, this.boundary)
    const index = JSON.parse(readFileSync(path, 'utf8')) as PackageIndex
    if (index.v !== 1 || !Array.isArray(index.files) || !index.files.length || index.files.length > 2048) throw new Error('Invalid skill package index')
    const seen = new Set<string>()
    let size = 0
    for (const file of index.files) {
      validateResourcePath(file.path)
      if (seen.has(file.path) || typeof file.executable !== 'boolean' || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.hash)) throw new Error('Invalid skill package file')
      seen.add(file.path); size += file.size
    }
    if (size > 32 * 1024 * 1024 || keyOf(index) !== ref || !seen.has('SKILL.md')) throw new Error('Skill package integrity check failed')
    return index
  }

  private describe(files: PackageFile[]): PackageIndex {
    const sorted = [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    const index: PackageIndex = { v: 1, files: sorted.map(file => {
      validateResourcePath(file.path)
      if (typeof file.data !== 'string' || typeof file.executable !== 'boolean') throw new Error('Invalid skill resource')
      const bytes = Buffer.from(file.data, 'base64')
      if (bytes.toString('base64') !== file.data) throw new Error('Invalid skill resource encoding')
      return { path: file.path, size: bytes.length, hash: digest(bytes), executable: file.executable }
    }) }
    const paths = index.files.map(file => file.path)
    if (!paths.includes('SKILL.md') || new Set(paths).size !== paths.length || paths.length > 2048
      || index.files.reduce((sum, file) => sum + file.size, 0) > 32 * 1024 * 1024) throw new Error('Invalid skill package')
    return index
  }

  reference(files: PackageFile[]): string {
    return keyOf(this.describe(files))
  }

  /** Binary contents live once per version. Publishing a complete directory is atomic. */
  put(files: PackageFile[]): string {
    if (this.options.maintenance) assertStorageMaintenance(this.boundary)
    else registerStorageRuntime(this.boundary)
    const index = this.describe(files), ref = keyOf(index), destination = this.directory(ref)
    if (existsSync(destination)) { this.verify(ref); return ref }
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const staging = join(this.root, '_staging-' + randomUUID())
    mkdirSync(staging, { mode: 0o700 })
    try {
      for (const file of files) {
        const target = inside(join(staging, 'files'), file.path)
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
        writeFileSync(target, Buffer.from(file.data, 'base64'), { mode: file.executable ? 0o700 : 0o600, flag: 'wx' })
      }
      writeFileSync(join(staging, 'index.json'), JSON.stringify(index), { mode: 0o600, flag: 'wx' })
      // Validate before publication as well as when reusing a competing writer's result.
      const stagingRef = join(this.root, ref)
      try { renameSync(staging, stagingRef) }
      catch (error) {
        if (!existsSync(stagingRef)) throw error
        this.verify(ref)
      }
      return ref
    } finally { rmSync(staging, { recursive: true, force: true }) }
  }

  verify(ref: string): void {
    const index = this.index(ref), directory = this.directory(ref)
    for (const file of index.files) this.readVerified(directory, file)
  }

  /** A compactor must sync canonical bytes and directory entries before deleting any fallback. */
  sync(ref: string): void {
    const directory = this.directory(ref), directories = new Set<string>([this.boundary, dirname(this.root), this.root, directory, join(directory, 'files')])
    const paths = this.index(ref).files.map(file => inside(join(directory, 'files'), file.path)).concat(join(directory, 'index.json'))
    for (const path of paths) {
      assertSkillStoragePath(path, this.boundary)
      const fd = openSync(path, process.platform === 'win32' ? 'r+' : 'r')
      try { fsyncSync(fd) } finally { closeSync(fd) }
      let parent = dirname(path)
      while (parent.startsWith(directory)) { directories.add(parent); if (parent === directory) break; parent = dirname(parent) }
    }
    if (process.platform !== 'win32') for (const path of [...directories].sort((a, b) => b.length - a.length)) {
      const fd = openSync(path, 'r')
      try { fsyncSync(fd) } finally { closeSync(fd) }
    }
  }

  private readVerified(directory: string, file: StoredFile): Buffer {
    const path = inside(join(directory, 'files'), file.path)
    assertSkillStoragePath(path, this.boundary)
    if (!lstatSync(path).isFile()) throw new Error('Invalid skill resource file')
    const bytes = readFileSync(path)
    if (bytes.length !== file.size || digest(bytes) !== file.hash) throw new Error('Skill resource integrity check failed')
    return bytes
  }

  materialize(ref: string, destination: string): void {
    registerStorageRuntime(this.boundary)
    const index = this.index(ref), directory = this.directory(ref)
    assertSkillStoragePath(destination)
    for (const file of index.files) {
      const bytes = this.readVerified(directory, file)
      const target = inside(destination, file.path)
      assertSkillStoragePath(target)
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
      if (!existsSync(target) || !readFileSync(target).equals(bytes)) {
        const temporary = target + '.skill-copy-' + randomUUID()
        try {
          // COPYFILE_FICLONE attempts CoW and falls back to an independent copy. Never link.
          copyFileSync(inside(join(directory, 'files'), file.path), temporary, constants.COPYFILE_FICLONE)
          if (!readFileSync(temporary).equals(bytes)) throw new Error('Skill resource changed during copy')
          chmodSync(temporary, file.executable ? 0o700 : 0o600)
          renameSync(temporary, target)
        } finally { rmSync(temporary, { force: true }) }
      }
      chmodSync(target, file.executable ? 0o700 : 0o600)
    }
  }

  /** Portable bundles contain v1-style resources; importing them reuses the same version key. */
  export(ref: string): PackageFile[] {
    return this.index(ref).files.map(file => ({ path: file.path, executable: file.executable, data: this.readVerified(this.directory(ref), file).toString('base64') }))
  }
}
