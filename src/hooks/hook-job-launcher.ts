import { execFile } from 'node:child_process'
import { access, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const checked = new Map<string, Promise<boolean>>()
async function compatible(path: string): Promise<boolean> {
  try {
    const file = await open(path, 'r')
    try {
      const header = Buffer.alloc(64)
      await file.read(header, 0, 64, 0)
      if (header.readUInt16LE(0) !== 0x5a4d) return false
      const pe = Buffer.alloc(6)
      await file.read(pe, 0, 6, header.readUInt32LE(0x3c))
      if (pe.readUInt32LE(0) !== 0x4550 || pe.readUInt16LE(4) !== (process.arch === 'arm64' ? 0xaa64 : 0x8664)) return false
    } finally { await file.close() }
    return await new Promise<boolean>(resolve => {
      execFile(path, ['--hook-capabilities'], { timeout: 500, maxBuffer: 1024, windowsHide: true }, (error, stdout) => {
        try { resolve(!error && JSON.parse(stdout).hookProtocol === 1) } catch { resolve(false) }
      })
    })
  } catch { return false }
}

export async function resolveHookLauncher(): Promise<string | null> {
  const candidates: string[] = []
  if (process.env.RIVET_JOB_LAUNCHER) {
    const override = process.env.RIVET_JOB_LAUNCHER
    let pending = checked.get(override)
    if (!pending) { pending = compatible(override); checked.set(override, pending) }
    return await pending ? override : null
  }
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth <= 5; depth++) {
    candidates.push(join(dir, 'native', 'job-launch.exe'), join(dir, 'dist', 'native', 'job-launch.exe'),
      join(dir, 'hook-runtime', `win32-${process.arch}`, 'job-launch.exe'),
      join(dir, 'dist', 'hook-runtime', `win32-${process.arch}`, 'job-launch.exe'))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  for (const path of candidates) {
    try { await access(path) } catch { continue }
    let pending = checked.get(path)
    if (!pending) { pending = compatible(path); checked.set(path, pending) }
    if (await pending) return path
    // An explicit override is an instruction, not permission to run another binary.
    if (path === process.env.RIVET_JOB_LAUNCHER) return null
  }
  return null
}
