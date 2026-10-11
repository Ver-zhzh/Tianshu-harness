/** Minimal headers for format tests; deliberately not loadable native addons. */
export function nativeHeader(os: string, arch: string): Buffer {
  const buffer = Buffer.alloc(256)
  if (os === 'darwin') {
    buffer.writeUInt32LE(0xfeedfacf, 0)
    buffer.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4)
  } else if (os === 'win32') {
    buffer.write('MZ')
    buffer.writeUInt32LE(128, 0x3c)
    buffer.write('PE\0\0', 128)
    buffer.writeUInt16LE(arch === 'arm64' ? 0xaa64 : 0x8664, 132)
  } else {
    buffer.writeUInt32BE(0x7f454c46, 0)
    buffer[4] = 2; buffer[5] = 1
    buffer.writeUInt16LE(arch === 'arm64' ? 183 : 62, 18)
  }
  return buffer
}
