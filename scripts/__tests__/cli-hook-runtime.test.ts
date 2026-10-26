import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stageCliHookRuntime, verifyCliHookRuntime } from '../cli-hook-runtime.mjs'

test('CLI hook staging validates both architectures and pins bytes to one source commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rivet-hook-pack-'))
  try {
    for (const [arch, machine] of [['x64', 0x8664], ['arm64', 0xaa64]] as const) {
      const folder = join(root, 'source', `win32-${arch}`)
      await mkdir(folder, { recursive: true })
      const pe = Buffer.alloc(128); pe.writeUInt16LE(0x5a4d); pe.writeUInt32LE(64, 0x3c)
      pe.writeUInt32LE(0x4550, 64); pe.writeUInt16LE(machine, 68)
      await writeFile(join(folder, 'job-launch.exe'), pe)
    }
    const commit = 'a'.repeat(40)
    await stageCliHookRuntime(root, join(root, 'source'), commit)
    assert.equal((await verifyCliHookRuntime(root)).sourceCommit, commit)
    const x64 = join(root, 'dist/hook-runtime/win32-x64/job-launch.exe')
    const bytes = await readFile(x64); bytes[100] = 1; await writeFile(x64, bytes)
    await assert.rejects(verifyCliHookRuntime(root), /checksum/)
    await rm(join(root, 'dist/hook-runtime/win32-arm64/job-launch.exe'))
    await assert.rejects(verifyCliHookRuntime(root))
  } finally { await rm(root, { recursive: true, force: true }) }
})
