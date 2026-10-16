import { constants, createWriteStream } from 'node:fs'
import { lstat, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { isPrivateContextPath } from './file-context-policy.js'
import { MAX_ARCHIVE_BYTES } from './attachment-limits.js'
import { detectSensitiveFile } from '../tools/sensitive-file-detector.js'
import { assertSingleLinkFile } from '../utils/file-links.js'

interface ArchiveSource { srcPath: string; bytes: number; sha256hex: string }

function assertPublicPath(path: string): void {
  if (isPrivateContextPath(path) || detectSensitiveFile(path).sensitive) {
    throw new Error('archive path must not be a private/secret file')
  }
}

/** Hash and stage one verified descriptor; persistence never reopens the user path. */
export async function withArchiveSource<T>(input: string, consume: (source: ArchiveSource) => T | Promise<T>): Promise<T> {
  assertPublicPath(input)
  const source = await realpath(input)
  assertPublicPath(source)
  const expected = await lstat(source)
  if (!expected.isFile()) throw new Error('not a regular file')
  assertSingleLinkFile(input, expected)
  const tooLarge = () => new Error(`archive exceeds ${Math.round(MAX_ARCHIVE_BYTES / 1024 / 1024)}MB limit`)
  if (expected.size > MAX_ARCHIVE_BYTES) throw tooLarge()
  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK)
  const file = await open(source, flags)
  let scratch: string | undefined
  try {
    const actual = await file.stat()
    assertSingleLinkFile(input, actual)
    if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino
      || await realpath(source) !== source || await realpath(input) !== source) {
      throw new Error('archive source changed while opening')
    }
    scratch = await mkdtemp(join(tmpdir(), 'rivet-archive-source-'))
    const stagedPath = join(scratch, 'source')
    const hash = createHash('sha256')
    let bytes = 0
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length
        if (bytes > MAX_ARCHIVE_BYTES) { done(tooLarge()); return }
        hash.update(chunk)
        done(null, chunk)
      },
    })
    await pipeline(file.createReadStream({ autoClose: false }), meter, createWriteStream(stagedPath, { flags: 'wx', mode: 0o600 }))
    const final = await file.stat()
    assertSingleLinkFile(input, final)
    if (final.size !== bytes || final.mtimeMs !== actual.mtimeMs || final.ctimeMs !== actual.ctimeMs) {
      throw new Error('archive source changed while reading')
    }
    return await consume({ srcPath: stagedPath, bytes, sha256hex: hash.digest('hex') })
  } finally {
    try { await file.close() } finally {
      if (scratch) await rm(scratch, { recursive: true, force: true })
    }
  }
}
