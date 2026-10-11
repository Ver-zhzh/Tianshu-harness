import { openSync, readSync, closeSync } from 'node:fs'

export interface NativeBinaryInfo {
  format: 'Mach-O' | 'PE' | 'ELF' | 'unknown'
  architectures: string[]
}

const MACHO_CPU: Record<number, string> = { 7: 'ia32', 12: 'arm', 0x01000007: 'x64', 0x0100000c: 'arm64' }
const PE_MACHINE: Record<number, string> = { 0x8664: 'x64', 0xaa64: 'arm64', 0x14c: 'ia32' }
const ELF_64: Record<number, string> = { 62: 'x64', 183: 'arm64' }
const ELF_32: Record<number, string> = { 3: 'ia32', 40: 'arm' }
const FORMATS: Record<string, NativeBinaryInfo['format']> = {
  darwin: 'Mach-O', win32: 'PE', linux: 'ELF', android: 'ELF', freebsd: 'ELF', openbsd: 'ELF', netbsd: 'ELF', sunos: 'ELF',
}

/** Read headers only; never dlopen a binary belonging to another platform. */
export function inspectNativeBinary(path: string): NativeBinaryInfo {
  const fd = openSync(path, 'r')
  const unknown: NativeBinaryInfo = { format: 'unknown', architectures: [] }
  const read = (size: number, offset = 0) => {
    const buffer = Buffer.alloc(size)
    return buffer.subarray(0, readSync(fd, buffer, 0, size, offset))
  }
  try {
    const header = read(64)
    if (header.length < 8) return unknown
    const magic = header.readUInt32BE(0)
    if ([0xcefaedfe, 0xcffaedfe, 0xfeedface, 0xfeedfacf].includes(magic)) {
      const cpu = magic === 0xcefaedfe || magic === 0xcffaedfe
        ? header.readUInt32LE(4) : header.readUInt32BE(4)
      const arch = MACHO_CPU[cpu]
      return { format: 'Mach-O', architectures: arch ? [arch] : [] }
    }
    if ([0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca].includes(magic)) {
      const little = magic === 0xbebafeca || magic === 0xbfbafeca
      const count = little ? header.readUInt32LE(4) : header.readUInt32BE(4)
      const stride = magic === 0xcafebabf || magic === 0xbfbafeca ? 32 : 20
      if (count === 0 || count > 64) return unknown
      const entries = read(count * stride, 8)
      if (entries.length !== count * stride) return unknown
      const architectures: string[] = []
      for (let i = 0; i < count; i++) {
        const cpu = little ? entries.readUInt32LE(i * stride) : entries.readUInt32BE(i * stride)
        const arch = MACHO_CPU[cpu]
        if (arch) architectures.push(arch)
      }
      return { format: 'Mach-O', architectures }
    }
    if (header[0] === 0x4d && header[1] === 0x5a && header.length >= 64) {
      const pe = read(6, header.readUInt32LE(0x3c))
      if (pe.length !== 6 || pe.readUInt32LE(0) !== 0x00004550) return unknown
      const machine = pe.readUInt16LE(4)
      const arch = PE_MACHINE[machine]
      return { format: 'PE', architectures: arch ? [arch] : [] }
    }
    if (magic === 0x7f454c46 && header.length >= 20 && [1, 2].includes(header[5]!)) {
      const machine = header[5] === 1 ? header.readUInt16LE(18) : header.readUInt16BE(18)
      const arch = header[4] === 2
        ? ELF_64[machine]
        : header[4] === 1 ? ELF_32[machine] : undefined
      return { format: 'ELF', architectures: arch ? [arch] : [] }
    }
    return unknown
  } finally {
    closeSync(fd)
  }
}

export function assertNativeBinary(
  path: string,
  target: { os: string; arch: string } = { os: process.platform, arch: process.arch },
): NativeBinaryInfo {
  const expected = FORMATS[target.os]
  let info: NativeBinaryInfo
  try { info = inspectNativeBinary(path) } catch { info = { format: 'unknown', architectures: [] } }
  if (!expected || info.format !== expected || !info.architectures.includes(target.arch)) {
    throw Object.assign(new Error(
      `[native] ${path}: expected ${expected ?? target.os} ${target.arch}, ` +
      `received ${info.format} ${info.architectures.join('/') || 'unknown architecture'}. ` +
      '重新构建对应平台的原生模块：npm rebuild better-sqlite3 && npm run build；安装包请重新安装对应平台版本。',
    ), { code: 'ENATIVE_BINARY_MISMATCH' })
  }
  return info
}
