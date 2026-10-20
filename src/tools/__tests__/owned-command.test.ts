import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ChildProcess, spawn, type SpawnOptions } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import * as processes from '../process-kill.js'
import * as git from '../spawn-git.js'

let root: string
let savedEnv: NodeJS.ProcessEnv

function recorder() {
  const child: ChildProcess = Object.assign(new ChildProcess(), { pid: 4321, exitCode: null, signalCode: null })
  const calls: Array<{ command: string; args: string[]; options: SpawnOptions }> = []
  const spawnFn = ((command: string, args: string[], options: SpawnOptions) => {
    calls.push({ command, args, options })
    return child
  }) as typeof spawn
  return { child, calls, spawnFn }
}

function markExited(child: ChildProcess): void {
  Object.defineProperty(child, 'exitCode', { value: 0, configurable: true })
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!existsSync(path)) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${path}`)
    await delay(10)
  }
}

describe('owned command lifecycle', () => {
  beforeEach(() => {
    savedEnv = { ...process.env }
    root = mkdtempSync(join(tmpdir(), 'rivet-owned-command-'))
    process.env.RIVET_HOME = join(root, 'home')
    mkdirSync(process.env.RIVET_HOME)
    writeFileSync(join(process.env.RIVET_HOME, 'config.json'), JSON.stringify({ env: { resolve: false, extraPath: [join(root, 'toolchain')], extraVars: { OWNED_COMMAND_CONFIG: 'resolved' } } }))
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    process.env.GIT_CONFIG_GLOBAL = join(root, 'no-global-config')
    for (const name of ['RIVET_PROFILE', 'RIVET_SESSION_DIR', 'RIVET_GIT_PATH', 'RIVET_JOB_LAUNCHER', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS']) delete process.env[name]
    processes.invalidateJobLauncherCache()
  })

  afterEach(() => {
    process.env = savedEnv
    processes.invalidateJobLauncherCache()
    rmSync(root, { recursive: true, force: true })
  })

  it('exports direct argv owned spawning and a resolved Git wrapper', () => {
    assert.equal(typeof processes.spawnOwnedCommand, 'function')
    assert.equal(typeof git.spawnGitOwned, 'function')
  })

  it('reports unknown for an exited Windows parent without claiming descendant cleanup', async () => {
    const { child } = recorder()
    markExited(child)
    const result = await processes.killProcessTreeAsync(child, 'SIGKILL', {
      platform: 'win32',
      runTaskkill: async () => assert.fail('must not target an exited and possibly reused PID'),
    })
    assert.equal(result, 'unknown')
  })

  it('passes the executable and exact argv through the helper without an appended shell command', () => {
    const { child, calls, spawnFn } = recorder()
    const command = 'C:\\工具 🧭\\Git\\cmd\\git.exe'
    const args = ['commit', '-m', '中文 "🧭" 𠮷 & not-a-shell', '--', '文件 📄.txt', '', '目录 𠮷\\']
    const owned = processes.spawnOwnedCommand(command, args, { cwd: 'C:\\中文 工作区𠮷', shell: true, detached: true }, {
      platform: 'win32', launcher: 'C:\\tools\\job-launch.exe', spawnFn,
    })
    assert.equal(owned.child, child)
    assert.equal(owned.ownership, 'job')
    assert.equal(calls[0]?.command, 'C:\\tools\\job-launch.exe')
    assert.deepEqual(calls[0]?.args, ['--cwd', 'C:\\中文 工作区𠮷', '--parent-pid', String(process.pid), '--', command, ...args])
    assert.equal(calls[0]?.options.shell, false)
    assert.equal(calls[0]?.options.windowsVerbatimArguments, false)
    assert.equal(calls[0]?.options.detached, false)
    assert.equal(calls[0]?.options.windowsHide, true)
  })

  it('resolves the existing launcher and Git path while preserving sanitized resolved environment', () => {
    const { calls, spawnFn } = recorder()
    const executable = join(root, 'git with spaces.exe')
    const launcher = join(root, 'job-launch.exe')
    writeFileSync(executable, '')
    writeFileSync(launcher, '')
    process.env.RIVET_GIT_PATH = executable
    process.env.RIVET_JOB_LAUNCHER = launcher
    const args = ['--literal-pathspecs', 'diff', '--', ':(glob)*']
    git.spawnGitOwned(args, { cwd: root, env: { GIT_DIR: '/wrong/repo', GIT_INDEX_FILE: '/wrong/index', LC_ALL: 'C' } }, { platform: 'win32', spawnFn })
    assert.equal(calls[0]?.command, launcher)
    assert.deepEqual(calls[0]?.args, ['--cwd', root, '--parent-pid', String(process.pid), '--', executable, ...args])
    assert.equal(calls[0]?.options.env?.GIT_DIR, undefined)
    assert.equal(calls[0]?.options.env?.GIT_INDEX_FILE, undefined)
    assert.equal(calls[0]?.options.env?.OWNED_COMMAND_CONFIG, 'resolved')
    assert.equal(calls[0]?.options.env?.LC_ALL, 'C')
    assert.ok((calls[0]?.options.env?.PATH ?? calls[0]?.options.env?.Path)?.includes(join(root, 'toolchain')))
  })

  it('still spawns Git directly when a Windows CLI installation has no helper', async () => {
    const { child, calls, spawnFn } = recorder()
    const executable = join(root, 'git.exe')
    writeFileSync(executable, '')
    process.env.RIVET_GIT_PATH = executable
    const owned = git.spawnGitOwned(['--version'], { cwd: root }, { platform: 'win32', launcher: null, spawnFn })
    assert.equal(calls[0]?.command, executable)
    assert.deepEqual(calls[0]?.args, ['--version'])
    assert.equal(owned.ownership, 'process')
    markExited(child)
    assert.equal(await owned.cleanup('SIGKILL'), 'unknown')
    child.emit('close', 0, null)
    assert.equal(await owned.cleanup('SIGKILL'), 'exited')
  })

  it('cleans up the helper PID while the helper is still holding the job lifetime', async () => {
    const { child, spawnFn } = recorder()
    const calls: string[][] = []
    const owned = processes.spawnOwnedCommand('git.exe', ['status'], { cwd: root }, {
      platform: 'win32', launcher: 'job-launch.exe', spawnFn,
      runTaskkill: async args => { calls.push(args); return 'exited' },
    })
    assert.equal(owned.child, child)
    assert.equal(child.exitCode, null)
    assert.equal(await owned.cleanup('SIGKILL'), 'exited')
    assert.deepEqual(calls, [['/F', '/T', '/PID', '4321']])
    assert.equal(await owned.cleanup('SIGKILL'), 'exited')
    assert.equal(calls.length, 1)
  })

  it('does not target a closed helper or process after its PID could be reused', async () => {
    for (const launcher of [null, 'job-launch.exe']) {
      const { child, spawnFn } = recorder()
      const owned = processes.spawnOwnedCommand('git.exe', [], { cwd: root }, {
        platform: 'win32', launcher, spawnFn,
        runTaskkill: async () => assert.fail('closed process must not be killed'),
      })
      markExited(child)
      child.emit('close', 0, null)
      assert.equal(await owned.cleanup('SIGKILL'), 'exited')
    }
  })

  it('keeps detached POSIX groups and reaps their inherited pipes after the parent exits', async () => {
    const { child, calls, spawnFn } = recorder()
    const kills: Array<[number, NodeJS.Signals]> = []
    const owned = processes.spawnOwnedCommand('git', ['status'], { cwd: root, detached: false }, {
      platform: 'linux', launcher: 'ignored-windows-helper.exe', spawnFn,
      kill: (pid, signal) => { kills.push([pid, signal]) },
    })
    assert.equal(owned.ownership, 'group')
    assert.equal(calls[0]?.command, 'git')
    assert.deepEqual(calls[0]?.args, ['status'])
    assert.equal(calls[0]?.options.detached, true)
    markExited(child)
    assert.equal(await owned.cleanup('SIGKILL'), 'exited')
    assert.deepEqual(kills, [[-4321, 'SIGKILL']])
    child.emit('close', 0, null)
    await owned.cleanup('SIGKILL')
    assert.equal(kills.length, 1)
  })

  it('keeps the modeled Windows helper alive until Git exits, then closes its modeled job', { skip: process.platform === 'win32', timeout: 10_000 }, async () => {
    const marker = join(root, 'git-descendants')
    const release = join(root, 'release-git')
    const cwd = join(root, '中文 作业 🧭-𠮷')
    mkdirSync(cwd)
    const executable = join(cwd, 'Git 模型-🧪.cjs')
    const launcher = join(cwd, '作业 模型-🧭.cjs')
    const filename = '提交 文件-📄-𠮷.txt'
    writeFileSync(join(cwd, filename), 'Unicode file 汉字 🧭 𠮷')
    writeFileSync(executable, `#!${process.execPath}\nconst fs = require('node:fs'); const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' }); fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ git: process.pid, descendant: child.pid })); process.stdout.write(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), content: fs.readFileSync(${JSON.stringify(filename)}, 'utf8') })); setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) process.exit(23) }, 10);\n`)
    writeFileSync(launcher, `#!${process.execPath}\nconst args = process.argv.slice(2); const boundary = args.indexOf('--'); const child = require('node:child_process').spawn(args[boundary + 1], args.slice(boundary + 2), { cwd: args[1], stdio: 'inherit', detached: true }); child.once('error', () => process.exit(127)); child.once('exit', code => { try { process.kill(-child.pid, 'SIGKILL') } catch {} process.exit(code ?? 1) });\n`)
    chmodSync(executable, 0o755)
    chmodSync(launcher, 0o755)
    process.env.RIVET_GIT_PATH = executable
    const args = ['commit', '-m', '中文 "🧭" 𠮷 & message', '--', filename, '', '目录 𠮷\\']
    const owned = git.spawnGitOwned(args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }, { platform: 'win32', launcher })
    let stdout = ''
    owned.child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    const closed = once(owned.child, 'close')
    let pids: { git: number; descendant: number } | undefined
    try {
      await waitFor(marker)
      pids = JSON.parse(readFileSync(marker, 'utf8'))
      assert.ok(pids)
      assert.notEqual(owned.child.pid, pids.git)
      assert.equal(owned.child.exitCode, null)
      assert.equal(alive(pids.git), true)
      assert.equal(alive(pids.descendant), true)
      writeFileSync(release, 'exit Git now')
      assert.equal((await closed)[0], 23)
      const actual = JSON.parse(stdout)
      assert.deepEqual(actual.args, args)
      assert.equal(realpathSync(actual.cwd), realpathSync(cwd))
      assert.equal(actual.content, 'Unicode file 汉字 🧭 𠮷')
      const deadline = Date.now() + 2000
      while (alive(pids.descendant) && Date.now() < deadline) await delay(10)
      assert.equal(alive(pids.descendant), false)
      assert.equal(await owned.cleanup('SIGKILL'), 'exited')
    } finally {
      if (pids && (alive(pids.git) || alive(pids.descendant))) {
        try { process.kill(-pids.git, 'SIGKILL') } catch {}
        if (alive(pids.descendant)) process.kill(pids.descendant, 'SIGKILL')
      }
      if (owned.child.pid && owned.child.exitCode === null) owned.child.kill('SIGKILL')
      await closed
    }
  })
})
