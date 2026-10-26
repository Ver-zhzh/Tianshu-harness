import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, existsSync, chmodSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { gitCommand } from '../git-command.js'

test('cancelled Git waits for its hook process to exit before returning and never retries', { timeout: 15_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'git-cancel-'))
  const git = (args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
  try {
    git(['init', '-q']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.com'])
    writeFileSync(join(cwd, 'a'), 'base'); git(['add', '--', 'a']); git(['commit', '-qm', 'base'])
    const head = git(['rev-parse', 'HEAD'])
    writeFileSync(join(cwd, 'a'), 'edit'); git(['add', '--', 'a'])
    const hook = join(cwd, '.git/hooks/pre-commit')
    writeFileSync(hook, `#!/bin/sh\n"${process.execPath.replaceAll('"', '\\"')}" -e 'require("fs").writeFileSync("hook.pid",String(process.pid));setTimeout(()=>{},30000)'\n`)
    chmodSync(hook, 0o755)
    const controller = new AbortController()
    const operation = gitCommand(cwd, ['commit', '-m', 'cancelled'], { signal: controller.signal })
    const until = Date.now() + 5000
    while (!existsSync(join(cwd, 'hook.pid')) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(existsSync(join(cwd, 'hook.pid')))
    const pid = Number(readFileSync(join(cwd, 'hook.pid'), 'utf8'))
    const cancelledAt = Date.now()
    controller.abort()
    const result = await operation
    assert.equal(result.interrupted, true)
    assert.ok(Date.now() - cancelledAt < 2500, 'cancellation must not wait for the command timeout')
    // 杀钩子进程与 ESRCH 可见之间存在收割竞态（高负载批内实测偶发）——
    // 短轮询确认终态，不放松「必须被杀死」的契约。
    const reapDeadline = Date.now() + 2000
    const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
    while (alive() && Date.now() < reapDeadline) await new Promise(resolve => setTimeout(resolve, 25))
    assert.ok(!alive(), 'cancelled commit must kill its hook process')
    assert.equal(git(['rev-parse', 'HEAD']), head)
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})
