/**
 * hook 脚本的解释器解析（issue #198）。
 *
 * 锁死的是这件事：Windows 上**绝不**把脚本路径直接交给 shell（`shell: true` 即
 * `cmd /d /s /c "<script>"`）——`.sh` 没有关联处理程序时会弹「选取应用」并阻塞。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveHookCommand, runHooksForEvent } from '../user-hooks-runner.js'

const win = 'win32' as NodeJS.Platform
const noExists = () => false
const envWith = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ PATH: '', ...extra })

describe('resolveHookCommand —— Windows 按扩展名选解释器', () => {
  it('.sh：命中 Git 已知安装位置（不依赖 PATH）', () => {
    const exists = (p: string) => p.toLowerCase().endsWith('git\\bin\\bash.exe')
    const r = resolveHookCommand('C:\\proj\\post-tool.sh', {
      platform: win,
      env: envWith({ ProgramFiles: 'C:\\Program Files' }),
      exists,
    })
    assert.equal(r.ok, true)
    assert.match(r.ok ? r.cmd : '', /Git\\bin\\bash\.exe$/i)
    assert.deepEqual(r.ok ? r.args : [], ['C:\\proj\\post-tool.sh'])
    assert.equal(r.ok ? r.shell : true, false, '绝不能走 shell')
  })

  it('.sh：已知位置没有时退回 PATH 上的 bash.exe', () => {
    const exists = (p: string) => p.toLowerCase() === 'c:\\tools\\bash.exe'
    const r = resolveHookCommand('C:\\proj\\x.sh', {
      platform: win,
      env: envWith({ PATH: 'C:\\tools' }),
      exists,
    })
    assert.equal(r.ok, true)
    assert.equal(r.ok ? r.cmd : '', 'C:\\tools\\bash.exe')
    assert.equal(r.ok ? r.shell : true, false)
  })

  it('.sh：找不到 bash → fail-closed 报错，不 spawn、不交给 shell', () => {
    const r = resolveHookCommand('C:\\proj\\x.sh', { platform: win, env: envWith(), exists: noExists })
    assert.equal(r.ok, false)
    assert.match(r.ok ? '' : r.error, /找不到 bash/)
  })

  it('.bat/.cmd：显式 cmd.exe，且 shell=false（不再靠 shell 二次解析）', () => {
    const r = resolveHookCommand('C:\\proj\\x.bat', { platform: win, env: envWith(), exists: noExists })
    assert.equal(r.ok, true)
    assert.equal(r.ok ? r.cmd : '', 'cmd.exe')
    assert.deepEqual(r.ok ? r.args : [], ['/d', '/s', '/c', 'C:\\proj\\x.bat'])
    assert.equal(r.ok ? r.shell : true, false)
  })

  it('.js/.mjs/.cjs/.ts：用运行中的 node，必然存在', () => {
    for (const name of ['a.js', 'a.mjs', 'a.cjs', 'a.ts']) {
      const r = resolveHookCommand(`C:\\proj\\${name}`, {
        platform: win,
        env: envWith(),
        exists: noExists,
        execPath: 'C:\\node\\node.exe',
      })
      assert.equal(r.ok, true, name)
      assert.equal(r.ok ? r.cmd : '', 'C:\\node\\node.exe', name)
      assert.equal(r.ok ? r.shell : true, false, name)
    }
  })

  it('.py：PATH 上有 python 就用，没有则 fail-closed', () => {
    const r1 = resolveHookCommand('C:\\proj\\x.py', {
      platform: win,
      env: envWith({ PATH: 'C:\\py' }),
      exists: (p) => p.toLowerCase() === 'c:\\py\\python.exe',
    })
    assert.equal(r1.ok, true)
    assert.equal(r1.ok ? r1.shell : true, false)

    const r2 = resolveHookCommand('C:\\proj\\x.py', { platform: win, env: envWith(), exists: noExists })
    assert.equal(r2.ok, false)
    assert.match(r2.ok ? '' : r2.error, /找不到 python/)
  })

  it('未知扩展名 → fail-closed，且错误里点明原因（不再弹选取应用）', () => {
    const r = resolveHookCommand('C:\\proj\\x.zzq', { platform: win, env: envWith(), exists: noExists })
    assert.equal(r.ok, false)
    assert.match(r.ok ? '' : r.error, /没有为 ".zzq" 注册解释器/)
    assert.match(r.ok ? '' : r.error, /#198/)
  })

  it('无扩展名 → 同样 fail-closed', () => {
    const r = resolveHookCommand('C:\\proj\\noext', { platform: win, env: envWith(), exists: noExists })
    assert.equal(r.ok, false)
    assert.match(r.ok ? '' : r.error, /无扩展名/)
  })

  it('POSIX：参数化脚本路径并保留 shebang', () => {
    for (const platform of ['darwin', 'linux'] as NodeJS.Platform[]) {
      const r = resolveHookCommand('/proj/x.sh', { platform, env: envWith(), exists: noExists })
      assert.equal(r.ok, true, platform)
      assert.equal(r.ok ? r.cmd : '', '/bin/sh', platform)
      assert.deepEqual(r.ok ? r.args : [], ['-c', 'exec "$1"', 'rivet-hook', '/proj/x.sh'], platform)
      assert.equal(r.ok ? r.shell : true, false, platform)
    }
  })
})

describe('runHooksForEvent —— 环境隔离（issue #137 同族）', () => {
  function setupDumpHook(scriptBody = 'env'): { dir: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-hook-env-'))
    mkdirSync(join(dir, '.rivet'), { recursive: true })
    const script = join(dir, 'dump.sh')
    writeFileSync(script, `#!/bin/sh\n${scriptBody}\n`)
    chmodSync(script, 0o755)
    writeFileSync(join(dir, '.rivet', 'hooks.json'), JSON.stringify({ hooks: [{ event: 'preTurn', script: 'dump.sh' }] }))
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
  }

  it('不把父进程的 NODE_OPTIONS / 启动即执行类变量泄漏给 hook 子进程', async () => {
    const prev = { ...process.env }
    const { dir, cleanup } = setupDumpHook()
    process.env.RIVET_TRUST_PROJECT = '1'
    process.env.NODE_OPTIONS = '--require=/tmp/malware.js'
    process.env.LD_PRELOAD = '/tmp/evil.so'
    try {
      const out = (await runHooksForEvent(dir, { event: 'preTurn', cwd: dir, turn: 1 })).map(r => r.output).join('\n')
      assert.doesNotMatch(out, /^NODE_OPTIONS=/m, 'NODE_OPTIONS 必须被剥离')
      assert.doesNotMatch(out, /^LD_PRELOAD=/m, 'LD_PRELOAD 必须被剥离')
    } finally {
      cleanup()
      process.env = prev
    }
  })

  it('不把父进程的密钥类变量泄漏给 hook 子进程', async () => {
    const prev = { ...process.env }
    const { dir, cleanup } = setupDumpHook()
    process.env.RIVET_TRUST_PROJECT = '1'
    process.env.MY_FAKE_SECRET_TOKEN = 'super-secret-value-123'
    try {
      const out = (await runHooksForEvent(dir, { event: 'preTurn', cwd: dir, turn: 1 })).map(r => r.output).join('\n')
      assert.doesNotMatch(out, /super-secret-value-123/, '密钥值不得出现在子进程环境')
      assert.doesNotMatch(out, /^MY_FAKE_SECRET_TOKEN=/m, '密钥变量不得传出')
    } finally {
      cleanup()
      process.env = prev
    }
  })

  it('仍向 hook 送达事件上下文（RIVET_HOOK_EVENT 等）与基础变量', async () => {
    const prev = { ...process.env }
    const { dir, cleanup } = setupDumpHook()
    process.env.RIVET_TRUST_PROJECT = '1'
    try {
      const out = (await runHooksForEvent(dir, { event: 'preTurn', cwd: dir, turn: 7, sessionId: 's1' })).map(r => r.output).join('\n')
      assert.match(out, /^RIVET_HOOK_EVENT=preTurn$/m)
      assert.match(out, /^RIVET_SESSION_ID=s1$/m)
      assert.match(out, /^RIVET_TURN=7$/m)
      assert.match(out, /^PATH=/m, 'PATH 是子进程运行必需的，必须保留')
    } finally {
      cleanup()
      process.env = prev
    }
  })
})
