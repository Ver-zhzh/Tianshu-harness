import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeEnvKey, SkillEnvironmentManager, type PrepareInput } from '../environment-manager.js'
import { createLockFileExclusive, removeLockFile } from '../../../server/cron-lock.js'
import type { PythonInterpreter } from '../interpreter.js'
import type { RuntimeDeclaration } from '../declaration.js'
import type { MirrorsConfig } from '../../../config/schema.js'
import type { ProcessExecOptions, ProcessExecResult } from '../../../tools/process-exec.js'

const interpreter: PythonInterpreter = { found: true, path: '/usr/bin/python3', realPath: '/usr/bin/python3.12', version: '3.12.4', abi: 'cpython-312', venvOk: true, pipOk: true }
const mirrorsOff = { enabled: false } as MirrorsConfig

function declarationWith(requirements?: string): RuntimeDeclaration {
  return { version: 1, python: { ...(requirements ? { requirements } : {}), entries: { run: { script: 'scripts/run.py' } } } }
}

function fixture(): { root: string; home: string; packageRoot: string; workspace: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'skill-env-mgr-'))
  const home = join(root, 'home'), packageRoot = join(root, 'pkg'), workspace = join(root, 'ws')
  mkdirSync(join(packageRoot, 'scripts'), { recursive: true })
  writeFileSync(join(packageRoot, 'scripts', 'run.py'), 'print(1)\n')
  mkdirSync(workspace)
  return { root, home, packageRoot, workspace, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function inputOf(f: ReturnType<typeof fixture>, overrides: Partial<PrepareInput> = {}): PrepareInput {
  return {
    workspace: f.workspace, skill: { scope: 'project', name: 'calc', skillId: 'abc123' },
    packageRef: 'f'.repeat(64), interpreter, declaration: declarationWith(),
    packageRoot: f.packageRoot, mirrors: mirrorsOff, ...overrides,
  }
}

const okExec = async (_options: ProcessExecOptions): Promise<ProcessExecResult> =>
  ({ exitCode: 0, timedOut: false, cancelled: false, stdout: 'Python 3.12.4\n', stderr: '', durationMs: 1 })

describe('computeEnvKey — 隔离矩阵', () => {
  const base = {
    workspace: '/ws', skillIdentity: 'project:abc123', packageRef: 'f'.repeat(64),
    interpreterRealPath: '/usr/bin/python3.12', interpreterVersion: '3.12.4', interpreterAbi: 'cpython-312',
    platform: 'darwin', arch: 'arm64', buildPolicy: 'wheel' as 'wheel' | 'source',
  }
  it('32 hex；任一要素变化 → key 全不同', () => {
    const key = computeEnvKey(base)
    assert.match(key, /^[0-9a-f]{32}$/)
    const variants: Array<[string, Partial<typeof base>]> = [
      ['workspace', { workspace: '/ws2' }],
      ['skillIdentity', { skillIdentity: 'personal:abc123' }],
      ['packageRef', { packageRef: 'e'.repeat(64) }],
      ['interpreterRealPath', { interpreterRealPath: '/opt/python3.12' }],
      ['interpreterVersion', { interpreterVersion: '3.12.5' }],
      ['interpreterAbi', { interpreterAbi: undefined }],
      ['platform', { platform: 'linux' }],
      ['arch', { arch: 'x64' }],
      ['buildPolicy', { buildPolicy: 'source' }],
    ]
    for (const [name, patch] of variants) {
      assert.notEqual(computeEnvKey({ ...base, ...patch }), key, name)
    }
  })

  it('workspace 规范路径：symlink 与真实路径同 key', () => {
    const f = fixture()
    try {
      const manager = new SkillEnvironmentManager({ home: f.home, exec: okExec })
      const link = join(f.root, 'ws-link')
      symlinkSync(f.workspace, link)
      assert.equal(manager.envKey(inputOf(f, { workspace: link })), manager.envKey(inputOf(f)))
    } finally { f.cleanup() }
  })
})

describe('SkillEnvironmentManager — prepare 状态机', () => {
  it('stdlib-only prepare → ready；ready.json 原子落盘；二次 prepare 走 ready 快路径', async () => {
    const f = fixture()
    try {
      const calls: string[] = []
      const exec = async (options: ProcessExecOptions): Promise<ProcessExecResult> => {
        calls.push(options.argv.join(' '))
        return { exitCode: 0, timedOut: false, cancelled: false, stdout: 'Python 3.12.4\n', stderr: '', durationMs: 1 }
      }
      const manager = new SkillEnvironmentManager({ home: f.home, exec })
      const input = inputOf(f)
      const outcome = await manager.prepare(input)
      assert.equal(outcome.status, 'ready')
      const ready = JSON.parse(readFileSync(join(outcome.envDir, 'ready.json'), 'utf8'))
      assert.equal(ready.schemaVersion, 2)
      assert.equal(ready.interpreter.version, '3.12.4')
      assert.equal(ready.packageRef, 'f'.repeat(64))
      assert.ok(ready.python.includes(outcome.envDir))
      assert.deepEqual(calls.map(c => c.split(' ').slice(1).join(' ')), ['-m venv ' + outcome.envDir, '--version'])

      // 二次 prepare：ready 快路径只探解释器版本，不再建 venv。
      const again = await manager.prepare(input)
      assert.equal(again.status, 'ready')
      assert.equal(calls.length, 3, '仅多一次解释器 --version 校验')
      assert.equal(manager.status(input).status, 'ready')
    } finally { f.cleanup() }
  })

  it('并发 prepare 同 envKey 单建（join 同一 Promise）', async () => {
    const f = fixture()
    try {
      let venvCount = 0
      const exec = async (options: ProcessExecOptions): Promise<ProcessExecResult> => {
        if (options.argv.includes('-m') && options.argv.includes('venv')) {
          venvCount++
          await new Promise(r => setTimeout(r, 50))
        }
        return { exitCode: 0, timedOut: false, cancelled: false, stdout: 'Python 3.12.4\n', stderr: '', durationMs: 1 }
      }
      const manager = new SkillEnvironmentManager({ home: f.home, exec })
      const input = inputOf(f)
      const [a, b] = await Promise.all([manager.prepare(input), manager.prepare(input)])
      assert.equal(a.status, 'ready')
      assert.equal(b.status, 'ready')
      assert.equal(venvCount, 1, '并发只建一次 venv')
    } finally { f.cleanup() }
  })

  it('installer 抛错/失败 → 无 ready.json，半成品目录清理，status 回 not-prepared', async () => {
    const f = fixture()
    try {
      writeFileSync(join(f.packageRoot, 'requirements.txt'), 'httpx==0.27.2\n')
      const exec = async (options: ProcessExecOptions): Promise<ProcessExecResult> => {
        // 只失败真实安装调用（带 -r）；`install --help` 能力探测与 pip list 照常成功。
        if (options.argv.includes('-r')) {
          return { exitCode: 1, timedOut: false, cancelled: false, stdout: '', stderr: 'ERROR: Could not find a version that satisfies the requirement httpx (from versions: none)\nERROR: No matching distribution found for httpx', durationMs: 1 }
        }
        if (options.argv.includes('--help')) {
          return { exitCode: 0, timedOut: false, cancelled: false, stdout: 'Usage: pip install [options] --report <file>', stderr: '', durationMs: 1 }
        }
        return okExec(options)
      }
      const manager = new SkillEnvironmentManager({ home: f.home, exec })
      const input = inputOf(f, { declaration: declarationWith('requirements.txt') })
      const outcome = await manager.prepare(input)
      assert.equal(outcome.status, 'failed')
      assert.equal(outcome.result.errorCode, 'no_wheel')
      assert.equal(existsSync(join(outcome.envDir, 'ready.json')), false, '失败绝不留 ready')
      // 半成品清空但目录保留（沙箱 bind 目标的存在性约束——bwrap/landlock 对
      // 不存在路径建规则即失败；空目录不等于 ready，状态由 ready.json 决定）。
      assert.deepEqual(readdirSync(outcome.envDir), [], '半成品内容清空')
      assert.equal(manager.status(input).status, 'not-prepared')
    } finally { f.cleanup() }
  })

  it('解释器二进制漂移 → environment_stale（不自动重建）', async () => {
    const f = fixture()
    try {
      let binaryVersion = '3.12.4'
      const exec = async (options: ProcessExecOptions): Promise<ProcessExecResult> => {
        const isProbe = options.argv.length === 2 && options.argv[1] === '--version' && options.argv[0] === interpreter.realPath
        return { exitCode: 0, timedOut: false, cancelled: false, stdout: isProbe ? `Python ${binaryVersion}\n` : 'Python 3.12.4\n', stderr: '', durationMs: 1 }
      }
      const manager = new SkillEnvironmentManager({ home: f.home, exec })
      const input = inputOf(f)
      assert.equal((await manager.prepare(input)).status, 'ready')
      binaryVersion = '3.13.0' // 解释器原地升级
      const again = await manager.prepare(input)
      assert.equal(again.status, 'environment_stale')
      assert.equal(again.result.errorCode, 'environment_stale')
      assert.match(again.result.message, /需重建/)
      assert.equal(existsSync(join(again.envDir, 'ready.json')), true, 'stale 不删旧环境（由显式删除处理）')
    } finally { f.cleanup() }
  })

  it('venv 模块缺失 → venv_missing；无 ready', async () => {
    const f = fixture()
    try {
      const exec = async (options: ProcessExecOptions): Promise<ProcessExecResult> => {
        if (options.argv.includes('-m') && options.argv.includes('venv')) {
          return { exitCode: 1, timedOut: false, cancelled: false, stdout: '', stderr: 'No module named venv', durationMs: 1 }
        }
        return okExec(options)
      }
      const manager = new SkillEnvironmentManager({ home: f.home, exec })
      const outcome = await manager.prepare(inputOf(f))
      assert.equal(outcome.status, 'failed')
      assert.equal(outcome.result.errorCode, 'venv_missing')
      assert.equal(existsSync(join(outcome.envDir, 'ready.json')), false)
    } finally { f.cleanup() }
  })

  it('跨进程锁：陈旧锁（死 PID）回收后重建；活锁时 status 报 preparing', async () => {
    const f = fixture()
    try {
      const manager = new SkillEnvironmentManager({ home: f.home, exec: okExec })
      const input = inputOf(f)
      const envKey = manager.envKey(input)
      const lockPath = join(f.home, 'skill-runtimes', `${envKey}.lock`)
      mkdirSync(join(f.home, 'skill-runtimes'), { recursive: true })

      // 活锁（本进程 PID 存活）→ status = preparing
      const alive = createLockFileExclusive(lockPath, { pid: process.pid, acquiredAt: new Date().toISOString(), hostname: 'test' })
      assert.ok(alive.ok)
      assert.equal(manager.status(input).status, 'preparing')
      removeLockFile(lockPath)

      // 已知无执行树的陈旧锁 → prepare 回收并建成 ready
      const dead = createLockFileExclusive(lockPath, { pid: 99999999, acquiredAt: new Date().toISOString(), hostname: 'test', ...{ phase: 'idle', nonce: envKey } })
      assert.ok(dead.ok)
      const outcome = await manager.prepare(input)
      assert.equal(outcome.status, 'ready')
      assert.equal(existsSync(lockPath), false, 'prepare 结束后锁释放')
    } finally { f.cleanup() }
  })

  it('remove：活跃 run 拒绝；活锁拒绝；就绪后可删', async () => {
    const f = fixture()
    try {
      const manager = new SkillEnvironmentManager({ home: f.home, exec: okExec })
      const input = inputOf(f)
      const outcome = await manager.prepare(input)
      assert.equal(outcome.status, 'ready')

      const release = manager.beginRun(outcome.envKey)
      const refused = manager.remove(input)
      assert.equal(refused.removed, false)
      assert.match(refused.reason ?? '', /活跃运行/)
      release()

      const envKey = manager.envKey(input)
      const lockPath = join(f.home, 'skill-runtimes', `${envKey}.lock`)
      createLockFileExclusive(lockPath, { pid: process.pid, acquiredAt: new Date().toISOString(), hostname: 'test' })
      const refusedByLock = manager.remove(input)
      assert.equal(refusedByLock.removed, false)
      removeLockFile(lockPath)

      const removed = manager.remove(input)
      assert.equal(removed.removed, true)
      assert.equal(existsSync(outcome.envDir), false)
      assert.equal(manager.status(input).status, 'not-prepared')
    } finally { f.cleanup() }
  })

  it('verifyReady：二进制漂移后 status 仍 ready（文件级）但 verifyReady 报 stale', async () => {
    const f = fixture()
    try {
      let binaryVersion = '3.12.4'
      const exec = async (options: ProcessExecOptions): Promise<ProcessExecResult> => {
        const isProbe = options.argv.length === 2 && options.argv[1] === '--version' && options.argv[0] === interpreter.realPath
        return { exitCode: 0, timedOut: false, cancelled: false, stdout: isProbe ? `Python ${binaryVersion}\n` : 'Python 3.12.4\n', stderr: '', durationMs: 1 }
      }
      const manager = new SkillEnvironmentManager({ home: f.home, exec })
      const input = inputOf(f)
      await manager.prepare(input)
      binaryVersion = '3.13.0'
      assert.equal(manager.status(input).status, 'ready', 'status 无子进程探测')
      assert.equal((await manager.verifyReady(input)).status, 'environment_stale')
    } finally { f.cleanup() }
  })
})

it('an explicit rebuild never joins an ordinary idempotent prepare', async () => {
  const f = fixture()
  try {
    let creations = 0
    const manager = new SkillEnvironmentManager({ home: f.home, exec: async options => { if (options.argv.includes('venv')) creations++; return okExec(options) } })
    const input = inputOf(f)
    assert.equal((await manager.prepare(input)).status, 'ready')
    const ordinary = manager.prepare(input)
    const rebuild = manager.prepare({ ...input, rebuild: true })
    assert.notEqual(ordinary, rebuild)
    const outcomes = await Promise.all([ordinary, rebuild])
    assert.ok(outcomes.every(outcome => outcome.status === 'ready'))
    assert.equal(creations, 2)
  } finally { f.cleanup() }
})
