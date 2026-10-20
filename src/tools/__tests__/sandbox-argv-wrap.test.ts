import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { wrapArgvSandbox, wrapSandboxCommand } from '../sandbox-profile.js'

const ENV_WITH_SANDBOX = { RIVET_SANDBOX: '1', PATH: '/usr/bin', HOME: '/home/x' } as NodeJS.ProcessEnv

describe('wrapArgvSandbox — per-call extraWritableRoots（issue #523）', () => {
  it('seatbelt：附加根进入 profile（与会话 grants 并集）', () => {
    const decision = wrapArgvSandbox(['/venv/bin/python', 'run.py'], {
      cwd: '/ws',
      env: ENV_WITH_SANDBOX,
      platform: 'darwin',
      which: () => true,
      extraWritableRoots: ['/home/x/.rivet/skill-runtimes/abc123'],
    })
    assert.equal(decision.sandboxed, true)
    assert.equal(decision.backend, 'seatbelt')
    assert.deepEqual(decision.argv.slice(0, 3), ['sandbox-exec', '-p', decision.argv[2]!])
    assert.match(decision.argv[2]!, /skill-runtimes\/abc123/)
    assert.deepEqual(decision.argv.slice(3), ['/venv/bin/python', 'run.py'])
  })

  it('bwrap：附加根进 bind 列表（不存在路径被过滤）', () => {
    mkdirSync('/tmp/rt523-env-dir', { recursive: true })
    try {
      const decision = wrapArgvSandbox(['/venv/bin/python', '-m', 'pip', 'install'], {
        cwd: '/ws',
        env: ENV_WITH_SANDBOX,
        platform: 'linux',
        which: bin => bin === 'bwrap',
        extraWritableRoots: ['/tmp/rt523-env-dir', '/tmp/rt523-not-created'],
      })
      assert.equal(decision.sandboxed, true)
      assert.equal(decision.backend, 'bwrap')
      const i = decision.argv.indexOf('--')
      assert.deepEqual(decision.argv.slice(i + 1), ['/venv/bin/python', '-m', 'pip', 'install'])
      assert.ok(decision.argv.includes('/tmp/rt523-env-dir'), '存在目录被 bind')
      assert.ok(!decision.argv.includes('/tmp/rt523-not-created'), '不存在目录被过滤')
    } finally { rmSync('/tmp/rt523-env-dir', { recursive: true, force: true }) }
  })

  it('未请求沙箱 → argv 原样返回，backend none（不冒称隔离）', () => {
    const decision = wrapArgvSandbox(['python', 'x.py'], { cwd: '/ws', env: { PATH: '/usr/bin' } as NodeJS.ProcessEnv, platform: 'darwin' })
    assert.equal(decision.sandboxed, false)
    assert.equal(decision.backend, 'none')
    assert.deepEqual(decision.argv, ['python', 'x.py'])
  })

  it('无后端（win32）→ 如实报 none', () => {
    const decision = wrapArgvSandbox(['python', 'x.py'], { cwd: 'C:\\ws', env: ENV_WITH_SANDBOX, platform: 'win32' })
    assert.equal(decision.sandboxed, false)
    assert.equal(decision.backend, 'none')
    assert.match(decision.note!, /no sandbox backend/)
  })

  it('shell 路径（wrapSandboxCommand）同样消费 extraWritableRoots', () => {
    const decision = wrapSandboxCommand('echo hi', {
      cwd: '/ws',
      env: ENV_WITH_SANDBOX,
      platform: 'darwin',
      which: () => true,
      extraWritableRoots: ['/tmp/rt523-extra'],
    })
    assert.equal(decision.sandboxed, true)
    assert.ok(decision.writableRoots!.includes('/tmp/rt523-extra'))
  })
})
