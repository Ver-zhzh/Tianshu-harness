import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { ArtifactStore } from '../store.js'

const SAVE_INPUT = {
  tool: 'read_file',
  target: '/etc/passwd',
  rawContent: 'PWNED',
  summary: 'traversal probe payload',
  sections: [],
}

/** A baseDir one level below the temp root, so a `../../` escape lands inside
 *  the temp tree (writable) instead of at `/`. */
function makeLayout(): { root: string; baseDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'artifact-traversal-'))
  const baseDir = join(root, 'artifacts')
  mkdirSync(baseDir, { recursive: true })
  return { root, baseDir }
}

describe('ArtifactStore path traversal defense', () => {
  it('refuses a session id that still escapes baseDir after sanitization', () => {
    const { root, baseDir } = makeLayout()
    try {
      // `..` survives the character filter ([^a-zA-Z0-9._-] never matches it),
      // so only the resolve assertion can reject it.
      assert.throws(() => new ArtifactStore(baseDir, '..'), /escapes base directory/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('sanitizes a traversal session id so save() stays under baseDir', async () => {
    const { root, baseDir } = makeLayout()
    const escaped = resolve(baseDir, '../../PWNED-artifact-traversal')
    try {
      const store = new ArtifactStore(baseDir, '../../PWNED-artifact-traversal')
      const id = await store.save(SAVE_INPUT)
      const artifact = store.get(id)
      assert.ok(artifact)

      const base = resolve(baseDir)
      assert.ok(
        artifact.rawPath.startsWith(base + sep),
        `rawPath ${artifact.rawPath} must stay under ${base}`,
      )
      assert.ok(existsSync(artifact.rawPath))
      assert.equal(existsSync(escaped), false, `nothing may be created at ${escaped}`)
    } finally {
      rmSync(escaped, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps a sanitized (formerly illegal) session id usable across restarts', async () => {
    const { root, baseDir } = makeLayout()
    try {
      const store = new ArtifactStore(baseDir, 'worker-../../x/y')
      const id = await store.save(SAVE_INPUT)
      assert.equal(await store.readRaw(id), 'PWNED')

      // Same raw input → same sanitized session id → index reloads and resolves.
      const restarted = new ArtifactStore(baseDir, 'worker-../../x/y')
      assert.equal(await restarted.readRaw(id), 'PWNED')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses an escaping id on addFallbackSession (read-side sink)', () => {
    const { root, baseDir } = makeLayout()
    try {
      const primary = new ArtifactStore(baseDir, 'primary-session')
      assert.throws(() => primary.addFallbackSession('..'), /escapes base directory/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses empty and degenerate session ids (审查 L1)', () => {
    // 空串 / "." / ".." 经字符过滤不变，resolve 后落在 baseDir 根（或逃逸）——
    // 会让该会话的制品与 _index.jsonl 直接写进共享根、与别的会话串味。
    const { root, baseDir } = makeLayout()
    try {
      for (const id of ['', '.', '..']) {
        assert.throws(
          () => new ArtifactStore(baseDir, id),
          /session id/i,
          `expected rejection: ${JSON.stringify(id)}`,
        )
      }
      const primary = new ArtifactStore(baseDir, 'primary-session')
      assert.throws(() => primary.addFallbackSession(''), /session id/i)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('cannot read an index planted outside baseDir via a traversal fallback id', async () => {
    const { root, baseDir } = makeLayout()
    // `../victim` resolves to <root>/victim — outside baseDir.
    const victimDir = resolve(baseDir, '..', 'victim')
    try {
      mkdirSync(victimDir, { recursive: true })
      const rawPath = join(victimDir, 'read_file-abc12345.raw')
      writeFileSync(rawPath, 'LEAKED', 'utf-8')
      writeFileSync(
        join(victimDir, '_index.jsonl'),
        `${JSON.stringify({
          id: 'read_file:abc12345',
          tool: 'read_file',
          target: 'x',
          sessionId: '../victim',
          createdAt: 0,
          summary: 'outside artifact',
          sections: [],
          rawPath,
          charCount: 6,
          lineCount: 1,
          sha256: 'deadbeef',
        })}\n`,
        'utf-8',
      )

      const primary = new ArtifactStore(baseDir, 'primary-session')
      primary.addFallbackSession('../victim')

      assert.equal(primary.get('read_file:abc12345'), null)
    } finally {
      rmSync(victimDir, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })
})
