import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { cloneWithFallback, clearMirrorMemory, isGithubUrl } from '../github-mirror-fallback.js'
import type { MirrorsConfig } from '../../config/schema.js'

// 最小 MirrorsConfig，无 autoFallback 字段（向后兼容）
function baseConfig(overrides?: Partial<MirrorsConfig>): MirrorsConfig {
  return {
    enabled: false,
    preset: 'default',
    github: 'default',
    npm: 'default',
    pypi: 'default',
    go: 'default',
    rust: 'default',
    autoFallback: true,
    fallbackMemoryMinutes: 10,
    fallbackTimeoutSec: 60,
    ...overrides,
  }
}

// 一次成功的 clone（直接 resolve）
function okClone(): (url: string, timeoutMs: number) => Promise<void> {
  return async (_url, _timeoutMs) => {
    // succeeds immediately
  }
}

// 失败若干次后才成功的 clone
function flakyClone(failCount: number): (url: string, timeoutMs: number) => Promise<void> {
  let calls = 0
  return async (_url, _timeoutMs) => {
    calls++
    if (calls <= failCount) throw new Error(`simulated failure #${calls}`)
  }
}

// 永远失败的 clone
function failClone(msg?: string): (url: string, timeoutMs: number) => Promise<void> {
  return async (_url, _timeoutMs) => {
    throw new Error(msg ?? 'simulated failure')
  }
}

describe('github-mirror-fallback', () => {
  beforeEach(() => {
    clearMirrorMemory()
  })

  describe('isGithubUrl', () => {
    it('detects https github url', () => {
      assert.equal(isGithubUrl('https://github.com/foo/bar.git'), true)
      assert.equal(isGithubUrl('https://github.com/foo/bar'), true)
    })

    it('detects ssh scp-style github url', () => {
      assert.equal(isGithubUrl('git@github.com:foo/bar.git'), true)
    })

    it('rejects non-github urls', () => {
      assert.equal(isGithubUrl('https://gitlab.com/foo/bar.git'), false)
      assert.equal(isGithubUrl('https://example.com/repo.git'), false)
      assert.equal(isGithubUrl('/tmp/local/path'), false)
    })
  })

  describe('cloneWithFallback', () => {
    it('direct success → reason: direct', async () => {
      const attempts: string[] = []
      const result = await cloneWithFallback({
        originalUrl: 'https://github.com/alice/repo.git',
        config: baseConfig(),
        cwd: '/tmp/proj',
        cloneFn: okClone(),
        onAttempt: (info) => attempts.push(info.url),
      })
      assert.equal(result.reason, 'direct')
      assert.equal(result.mirrorId, undefined)
      assert.equal(result.url, 'https://github.com/alice/repo.git')
      assert.equal(attempts.length, 1)
    })

    it('direct fail + mirror success → reason: fallback + memory', async () => {
      const attempts: { url: string; mirrorId?: string }[] = []
      const result = await cloneWithFallback({
        originalUrl: 'https://github.com/alice/repo.git',
        config: baseConfig(),
        cwd: '/tmp/proj',
        cloneFn: flakyClone(1), // direct fails, first mirror (ghproxy, table order) succeeds
        fallbackMemoryMinutes: 10,
        onAttempt: (info) => attempts.push(info),
      })
      assert.equal(result.reason, 'fallback')
      assert.equal(result.mirrorId, 'ghproxy')
      assert.equal(result.triedFailures.length, 1)
      assert.equal(result.triedFailures[0]?.mirrorId, 'direct')
      assert.ok(attempts.length >= 2)

      // Memory: next call should skip direct and hit ghproxy
      const result2 = await cloneWithFallback({
        originalUrl: 'https://github.com/alice/repo.git',
        config: baseConfig(),
        cwd: '/tmp/proj',
        cloneFn: okClone(),
        fallbackMemoryMinutes: 10,
      })
      assert.equal(result2.reason, 'memory')
      assert.equal(result2.mirrorId, 'ghproxy')
    })

    it('all fail → aggregate error', async () => {
      await assert.rejects(
        cloneWithFallback({
          originalUrl: 'https://github.com/alice/repo.git',
          config: baseConfig(),
          cwd: '/tmp/proj',
          cloneFn: failClone('network error'),
          fallbackTimeoutMs: 500,
        }),
        (err: Error) => {
          assert.ok(err.message.includes('All clone attempts failed'))
          return true
        },
      )
    })

    it('memory hit → reason: memory, skips direct', async () => {
      // First, make gitcode succeed (simulate a prior fallback)
      await cloneWithFallback({
        originalUrl: 'https://github.com/alice/repo.git',
        config: baseConfig(),
        cwd: '/tmp/proj',
        cloneFn: flakyClone(1), // direct fails, gitcode works
        fallbackMemoryMinutes: 10,
      })

      // Now, even with a clone that would fail on direct, memory should hit
      const attempts: { url: string; mirrorId?: string }[] = []
      const result = await cloneWithFallback({
        originalUrl: 'https://github.com/alice/repo.git',
        config: baseConfig(),
        cwd: '/tmp/proj',
        cloneFn: okClone(),
        fallbackMemoryMinutes: 10,
        onAttempt: (info) => attempts.push(info),
      })
      assert.equal(result.reason, 'memory')
      assert.equal(result.mirrorId, 'ghproxy')
      // Only one attempt — memory hit, no direct try
      assert.equal(attempts.length, 1)
    })

    it('memory expired → falls through to normal fallback', async () => {
      // Seed memory with 0 TTL (immediately expired)
      await cloneWithFallback({
        originalUrl: 'https://github.com/alice/repo.git',
        config: baseConfig(),
        cwd: '/tmp/proj',
        cloneFn: flakyClone(1),
        fallbackMemoryMinutes: 0,
      })

      // Next call: memory expired, should try direct first
      const result = await cloneWithFallback({
        originalUrl: 'https://github.com/alice/repo.git',
        config: baseConfig(),
        cwd: '/tmp/proj',
        cloneFn: okClone(), // direct succeeds
        fallbackMemoryMinutes: 10,
      })
      assert.equal(result.reason, 'direct')
    })

    it('user explicit mirror → only that mirror, no fallback', async () => {
      // User chose gitcode explicitly (post-#524 table: ghproxy/gitcode alive;
      // legacy kkgithub/fastgit resolve to undefined → auto-fallback path)
      const config = baseConfig({ enabled: true, github: 'gitcode' })
      const attempts: string[] = []

      // gitcode succeeds
      const result = await cloneWithFallback({
        originalUrl: 'https://github.com/alice/repo.git',
        config,
        cwd: '/tmp/proj',
        cloneFn: okClone(),
        onAttempt: (info) => attempts.push(info.url),
      })
      assert.equal(result.reason, 'direct')
      assert.equal(result.mirrorId, 'gitcode')
      assert.ok(attempts[0]?.includes('gitcode.com'))
    })

    it('user explicit mirror fails → throws, no retry', async () => {
      const config = baseConfig({ enabled: true, github: 'gitcode' })

      await assert.rejects(
        cloneWithFallback({
          originalUrl: 'https://github.com/alice/repo.git',
          config,
          cwd: '/tmp/proj',
          cloneFn: failClone('mirror down'),
        }),
        (err: Error) => {
          assert.ok(err.message.includes('user-selected mirror gitcode'))
          return true
        },
      )
    })

    it('legacy dead mirror id (kkgithub) resolves to auto-fallback path', async () => {
      // issue #524: kkgithub dropped from the table → resolveGithubMirrorId
      // returns undefined → the user-respect branch is skipped and normal
      // auto-fallback (direct first) applies instead of a dead mirror.
      const config = baseConfig({ enabled: true, github: 'kkgithub' })
      const result = await cloneWithFallback({
        originalUrl: 'https://github.com/alice/repo.git',
        config,
        cwd: '/tmp/proj',
        cloneFn: okClone(),
      })
      assert.equal(result.reason, 'direct')
      assert.equal(result.mirrorId, undefined)
    })

    it('autoFallback=false → only direct, no mirrors', async () => {
      const config = baseConfig({ autoFallback: false })

      await assert.rejects(
        cloneWithFallback({
          originalUrl: 'https://github.com/alice/repo.git',
          config,
          cwd: '/tmp/proj',
          cloneFn: failClone('network error'),
        }),
        (err: Error) => {
          assert.ok(err.message.includes('network error'))
          assert.ok(!err.message.includes('All clone attempts'))
          return true
        },
      )
    })

    it('non-github url → tries original only, no fallback', async () => {
      const result = await cloneWithFallback({
        originalUrl: 'https://gitlab.com/team/repo.git',
        config: baseConfig(),
        cwd: '/tmp/proj',
        cloneFn: okClone(),
      })
      assert.equal(result.reason, 'direct')
      assert.equal(result.url, 'https://gitlab.com/team/repo.git')
    })
  })
})
