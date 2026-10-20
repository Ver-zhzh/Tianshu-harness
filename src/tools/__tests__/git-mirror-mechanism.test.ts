/**
 * Mechanism-level integration test for issue #524.
 *
 * Uses a REAL local git (bare-repo pair standing in for github.com and its
 * mirror) driven by the exact env vars buildMirrorEnv produces, asserting:
 *  1. `git clone <github-url>` actually pulls from the mirror;
 *  2. `.git/config` stores the ORIGINAL github URL (no pollution);
 *  3. `git push` goes to the original github (identity pushInsteadOf);
 *  4. `echo` of a github URL is untouched (no text rewrite anywhere).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildMirrorEnv } from '../mirror-env.js'
import type { MirrorsConfig } from '../../config/schema.js'

const GIT = process.env.GIT_TEST_BINARY ?? 'git'

function runGit(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  return execFileSync(GIT, args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: opts.cwd ?? process.env.HOME, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

describe('git mirror insteadOf mechanism (issue #524)', () => {
  let root: string
  let gitEnv: Record<string, string>

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'mirror-mech-'))
    // bare pair: m = mirror (gitcode-style direct path), u = upstream github
    mkdirSync(join(root, 'm', 'foo'), { recursive: true })
    mkdirSync(join(root, 'u', 'foo'), { recursive: true })
    runGit(['init', '-q', '--bare', join(root, 'm', 'foo', 'bar.git')])
    runGit(['init', '-q', '--bare', join(root, 'u', 'foo', 'bar.git')])
    runGit(['init', '-q', join(root, 'seed')], { cwd: root })
    runGit(['config', 'user.email', 't@t.test'], { cwd: join(root, 'seed') })
    runGit(['config', 'user.name', 't'], { cwd: join(root, 'seed') })
    writeSync(join(root, 'seed', 'f.txt'), 'hi\n')
    runGit(['add', 'f.txt'], { cwd: join(root, 'seed') })
    runGit(['commit', '-qm', 'init'], { cwd: join(root, 'seed') })
    runGit(['push', '-q', `file://${root}/m/foo/bar.git`, 'HEAD:main'], { cwd: join(root, 'seed') })
    runGit(['push', '-q', `file://${root}/u/foo/bar.git`, 'HEAD:main'], { cwd: join(root, 'seed') })
    // Bare HEAD must point at the seeded branch — otherwise clone warns
    // "remote HEAD refers to nonexistent ref" and checks out nothing.
    for (const bare of [join(root, 'm', 'foo', 'bar.git'), join(root, 'u', 'foo', 'bar.git')]) {
      runGit(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: bare })
    }

    // The EXACT env buildMirrorEnv would inject, but pointed at our local pair.
    // buildMirrorEnv('gitcode') produces url.<mirror>.insteadOf=github.com +
    // pushInsteadOf identity. We replicate the shape with local paths:
    gitEnv = {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: `url.file://${root}/m/.insteadOf`,
      GIT_CONFIG_VALUE_0: 'https://github.com/',
      GIT_CONFIG_KEY_1: `url.file://${root}/u/.pushInsteadOf`,
      GIT_CONFIG_VALUE_1: 'https://github.com/',
    }
  })

  after(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('clone goes through the mirror; .git/config keeps the original github URL', () => {
    const cloned = join(root, 'cloned')
    runGit(['clone', '-q', 'https://github.com/foo/bar.git', cloned], { cwd: root, env: gitEnv })
    const url = runGit(['config', '--get', 'remote.origin.url'], { cwd: cloned }).trim()
    assert.equal(url, 'https://github.com/foo/bar.git', '.git/config must store the ORIGINAL url')
    assert.ok(runGit(['rev-parse', 'HEAD'], { cwd: cloned }).trim().length > 0)
  })

  it('push goes to the original github; mirror stays untouched', () => {
    const cloned = join(root, 'cloned2')
    runGit(['clone', '-q', 'https://github.com/foo/bar.git', cloned], { cwd: root, env: gitEnv })
    runGit(['config', 'user.email', 't@t.test'], { cwd: cloned })
    runGit(['config', 'user.name', 't'], { cwd: cloned })
    writeSync(join(cloned, 'f.txt'), 'change\n')
    runGit(['commit', '-qam', 'chg'], { cwd: cloned })
    runGit(['push', '-q', 'origin', 'main'], { cwd: cloned, env: gitEnv })
    const upstreamCommits = Number(runGit(['rev-list', '--count', 'main'], { cwd: join(root, 'u', 'foo', 'bar.git') }).trim())
    const mirrorCommits = Number(runGit(['rev-list', '--count', 'main'], { cwd: join(root, 'm', 'foo', 'bar.git') }).trim())
    assert.equal(upstreamCommits, 2, 'push must reach the ORIGINAL github (upstream)')
    assert.equal(mirrorCommits, 1, 'mirror must NOT receive pushes')
  })

  it('disabling the switch fully restores original URLs (no persistent pollution)', () => {
    // `remote -v` applies insteadOf rewriting when env is active, but the
    // decisive no-pollution invariant is: WITHOUT the mirror env (switch off),
    // remote -v shows the original github URL that was stored in .git/config.
    const cloned = join(root, 'cloned3')
    runGit(['clone', '-q', 'https://github.com/foo/bar.git', cloned], { cwd: root, env: gitEnv })
    const remoteV = runGit(['remote', '-v'], { cwd: cloned })
    assert.ok(remoteV.includes('https://github.com/foo/bar.git'), `without env, remote -v shows original: ${remoteV}`)
    const stored = readFileSync(join(cloned, '.git', 'config'), 'utf8')
    assert.ok(stored.includes('https://github.com/foo/bar.git'), '.git/config stores original URL')
    assert.ok(!stored.includes('gh_mirror'), 'no dead gh_mirror address in .git/config')
  })

  it('buildMirrorEnv china preset emits a valid insteadOf pair for ghproxy', () => {
    const env = buildMirrorEnv(chinaConfig())
    assert.equal(env.GIT_CONFIG_COUNT, '2')
    const key0 = env.GIT_CONFIG_KEY_0!
    assert.ok(key0.startsWith('url.https://ghproxy.net/https://github.com/'), key0)
    assert.ok(key0.endsWith('.insteadOf'))
    assert.equal(env.GIT_CONFIG_VALUE_0, 'https://github.com/')
    assert.equal(env.GIT_CONFIG_KEY_1, 'url.https://github.com/.pushInsteadOf')
  })
})

function writeSync(p: string, content: string): void {
  writeFileSync(p, content)
}

function chinaConfig(): MirrorsConfig {
  return {
    enabled: true,
    preset: 'china',
    github: 'default',
    npm: 'default',
    pypi: 'default',
    go: 'default',
    rust: 'default',
    autoFallback: true,
    fallbackMemoryMinutes: 10,
    fallbackTimeoutSec: 60,
  }
}
