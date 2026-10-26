import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const targets = { x64: 0x8664, arm64: 0xaa64 }
export async function verifyCliHookRuntime(root) {
  const base = join(root, 'dist', 'hook-runtime')
  const manifest = JSON.parse(await readFile(join(base, 'manifest.json'), 'utf8'))
  if (manifest.hookProtocol !== 1 || !/^[0-9a-f]{40}$/.test(manifest.sourceCommit)) throw new Error('Invalid hook runtime manifest')
  for (const [arch, machine] of Object.entries(targets)) {
    const path = `win32-${arch}/job-launch.exe`
    const bytes = await readFile(join(base, path))
    if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) throw new Error(`Invalid PE: ${path}`)
    const offset = bytes.readUInt32LE(0x3c)
    if (offset + 6 > bytes.length || bytes.readUInt32LE(offset) !== 0x4550 || bytes.readUInt16LE(offset + 4) !== machine) throw new Error(`Hook helper architecture mismatch: ${path}`)
    const entry = manifest.files?.[arch]
    if (entry?.path !== path || entry.sha256 !== createHash('sha256').update(bytes).digest('hex')) throw new Error(`Hook helper checksum mismatch: ${path}`)
    if (entry.sourceCommit !== manifest.sourceCommit || entry.hookProtocol !== 1) throw new Error(`Hook helper version mismatch: ${path}`)
  }
  return manifest
}

export async function stageCliHookRuntime(root, source, sourceCommit) {
  if (!/^[0-9a-f]{40}$/.test(sourceCommit ?? '')) throw new Error('A full source commit is required')
  const base = join(root, 'dist', 'hook-runtime')
  const manifest = { hookProtocol: 1, sourceCommit, files: {} }
  for (const arch of Object.keys(targets)) {
    const path = `win32-${arch}/job-launch.exe`
    await mkdir(join(base, `win32-${arch}`), { recursive: true })
    const from = join(source, `win32-${arch}`, 'job-launch.exe')
    const bytes = await readFile(from)
    await copyFile(from, join(base, path))
    manifest.files[arch] = { path, sha256: createHash('sha256').update(bytes).digest('hex'), sourceCommit, hookProtocol: 1 }
  }
  await writeFile(join(base, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return verifyCliHookRuntime(root)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(process.env.HOOK_RUNTIME_ROOT ?? '.')
  if (process.argv[2] === 'prepare') {
    const source = resolve(process.env.HOOK_RUNTIME_SOURCE ?? 'native')
    const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
    await stageCliHookRuntime(root, source, sourceCommit)
  } else if (process.argv[2] === 'stage') await stageCliHookRuntime(root, resolve(process.argv[3] ?? 'native'), process.argv[4])
  else await verifyCliHookRuntime(root)
}
