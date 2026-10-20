import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { SkillEnvironmentManager, type PrepareInput } from '../environment-manager.js'
import { createLockFileExclusive, removeLockFile } from '../../../server/cron-lock.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'runtime-leases-'))
  const pkg = join(root, 'pkg'), home = join(root, 'home')
  mkdirSync(join(pkg, 'scripts'), { recursive: true })
  writeFileSync(join(pkg, 'scripts/run.py'), 'print(1)\n')
  const input: PrepareInput = { workspace: root, skill: { scope: 'project', name: 'calc', skillId: 'fixture' }, packageRef: 'f'.repeat(64), interpreter: { found: true, path: '/python', realPath: '/python', version: '3.12.4', abi: 'test', venvOk: true, pipOk: true }, declaration: { version: 1, python: { entries: { run: { script: 'scripts/run.py' } } } }, packageRoot: pkg, mirrors: { enabled: false } as any }
  return { root, home, input }
}
const ok = async () => ({ exitCode: 0, cancelled: false, timedOut: false, stdout: 'Python 3.12.4', stderr: '', durationMs: 1 })

it('incomplete shared lease identities never permit environment deletion', async () => {
  const f = fixture()
  try {
    const manager = new SkillEnvironmentManager({ home: f.home, exec: ok })
    const prepared = await manager.prepare(f.input)
    assert.equal(prepared.status, 'ready')
    const dir = join(f.home, 'skill-runtimes', '.leases', prepared.envKey)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'a.json')
    for (const lease of [
      { pid: 99999999, nonce: 'test' },
      { pid: -1, nonce: 'test', phase: 'idle' },
      { pid: 99999999, nonce: 'test', phase: 'unknown' },
      { pid: 99999999, nonce: 'test', phase: 'running', childPid: -1 },
    ]) {
      writeFileSync(path, JSON.stringify(lease))
      assert.equal(manager.remove(f.input).removed, false, JSON.stringify(lease))
    }
    rmSync(path)
    assert.equal(manager.remove(f.input).removed, true)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

it('legacy exclusive leases with unknown execution phase cannot permit deletion', async () => {
  const f = fixture()
  try {
    const manager = new SkillEnvironmentManager({ home: f.home, exec: ok })
    const prepared = await manager.prepare(f.input)
    assert.equal(prepared.status, 'ready')
    const path = join(f.home, 'skill-runtimes', `${prepared.envKey}.lock`)
    assert.equal(createLockFileExclusive(path, { pid: 99999999, acquiredAt: new Date().toISOString(), hostname: 'test' }).ok, true)
    assert.equal(manager.remove(f.input).removed, false)
    removeLockFile(path)
    assert.equal(manager.remove(f.input).removed, true)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

it('separate processes exclude run/delete and prepare/delete; dead known run leases recover', { timeout: 20_000 }, async () => {
  const f = fixture()
  const manager = new SkillEnvironmentManager({ home: f.home, exec: ok })
  const moduleUrl = new URL('../environment-manager.ts', import.meta.url).href
  const children: ReturnType<typeof spawn>[] = []
  async function worker(kind: 'run' | 'prepare') {
    const source = `import {SkillEnvironmentManager} from ${JSON.stringify(moduleUrl)};
      const input=${JSON.stringify(f.input)};
      let release;
      const unblock=new Promise(resolve=>{process.stdin.resume();process.stdin.on('end',resolve)});
      const manager=new SkillEnvironmentManager({home:${JSON.stringify(f.home)},exec:async o=>{
        if(o.argv.includes('venv')){console.log('ready');await unblock}
        return {exitCode:0,cancelled:false,timedOut:false,stdout:'Python 3.12.4',stderr:'',durationMs:1};
      }});
      if(${JSON.stringify(kind)}==='run'){release=manager.beginRun(manager.envKey(input));release.onSpawn(process.pid);console.log('ready');await unblock;release()}
      else await manager.prepare({...input,rebuild:true});`
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    children.push(child)
    let stderr = ''
    child.stderr!.on('data', data => { stderr += data })
    await Promise.race([once(child.stdout!, 'data'), once(child, 'exit').then(() => { throw new Error('worker exited: ' + stderr) })])
    return child
  }
  try {
    assert.equal((await manager.prepare(f.input)).status, 'ready')
    const running = await worker('run')
    assert.equal(manager.remove(f.input).removed, false)
    assert.equal((await manager.prepare({ ...f.input, rebuild: true })).result.errorCode, 'environment_busy')
    const exited = once(running, 'exit'); running.stdin!.end(); await exited
    assert.equal(manager.remove(f.input).removed, true)
    const preparing = await worker('prepare')
    assert.equal(manager.remove(f.input).removed, false)
    const prepared = once(preparing, 'exit'); preparing.stdin!.end(); await prepared
    const abandoned = await worker('run')
    const dead = once(abandoned, 'exit'); abandoned.kill('SIGKILL'); await dead
    assert.equal(manager.remove(f.input).removed, true)
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    rmSync(f.root, { recursive: true, force: true })
  }
})

it('venv uses per-call executor; schema 1 is stale until explicitly rebuilt', async () => {
  const f = fixture()
  try {
    const raw: string[][] = [], wrapped: string[][] = []
    const manager = new SkillEnvironmentManager({ home: f.home, exec: async o => { raw.push(o.argv); return ok() } })
    const prepared = await manager.prepare({ ...f.input, exec: async o => { wrapped.push(o.argv); return ok() } })
    assert.equal(prepared.status, 'ready')
    assert.equal(raw.length, 0)
    assert.ok(wrapped.some(argv => argv.includes('venv')))
    const path = join(prepared.envDir, 'ready.json')
    const marker = JSON.parse(readFileSync(path, 'utf8'))
    marker.schemaVersion = 1; delete marker.runtimePolicyVersion; delete marker.requirementsDigest
    writeFileSync(path, JSON.stringify(marker))
    assert.equal(manager.status(f.input).status, 'environment_stale')
    assert.equal((await manager.prepare(f.input)).status, 'environment_stale')
    assert.equal((await manager.prepare({ ...f.input, rebuild: true })).status, 'ready')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
