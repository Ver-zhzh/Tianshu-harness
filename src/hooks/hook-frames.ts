export const HOOK_PROTOCOL = 1
export const HookFrame = { hello: 1, input: 2, cancel: 3, stdout: 4, stderr: 5, done: 6 } as const
export function hookFrame(kind: number, payload = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(5)
  header[0] = kind; header.writeUInt32LE(payload.length, 1)
  return Buffer.concat([header, payload])
}

export function hookFrameDecoder(onFrame: (kind: number, payload: Buffer) => void) {
  let buffer = Buffer.alloc(0)
  return (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 5) {
      const length = buffer.readUInt32LE(1)
      if (length > 65_536) throw new Error('Hook supervisor frame exceeds 64KiB')
      if (buffer.length < 5 + length) return
      const kind = buffer[0]!
      const payload = buffer.subarray(5, 5 + length)
      buffer = buffer.subarray(5 + length)
      onFrame(kind, payload)
    }
  }
}
