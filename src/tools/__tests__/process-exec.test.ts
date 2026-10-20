import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSanitizedEnv, execProcess, isPythonHostileEnvKey } from '../process-exec.js'

const NODE = process.execPath

describe('buildSanitizedEnv — 白名单 + Python 污染剥离', () => {
  it('保留系统必需变量，剥离 PYTHON*/VIRTUAL_ENV/CONDA_*', () => {
    const env = buildSanitizedEnv({
      PATH: '/usr/bin', HOME: '/home/x', SystemRoot: 'C:\\Windows',
      PYTHONPATH: '/evil', PYTHONHOME: '/evil', VIRTUAL_ENV: '/evil', CONDA_PREFIX: '/evil',
      PIP_INDEX_URL: 'https://evil.example.com', AWS_SECRET_ACCESS_KEY: 'leak',
    } as NodeJS.ProcessEnv)
    assert.equal(env['PATH'], '/usr/bin')
    assert.equal(env['HOME'], '/home/x')
    assert.equal(env['SystemRoot'], 'C:\\Windows')
    for (const hostile of ['PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV', 'CONDA_PREFIX', 'PIP_INDEX_URL', 'AWS_SECRET_ACCESS_KEY']) {
      assert.equal(env[hostile], undefined, hostile)
    }
  })

  it('调用方覆盖显式胜出（含把剥离键加回来的能力）', () => {
    const env = buildSanitizedEnv({ PATH: '/usr/bin' } as NodeJS.ProcessEnv, { PIP_INDEX_URL: 'https://pypi.tuna.tsinghua.edu.cn/simple' })
    assert.equal(env['PIP_INDEX_URL'], 'https://pypi.tuna.tsinghua.edu.cn/simple')
  })

  it('isPythonHostileEnvKey 判定', () => {
    for (const k of ['PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV', 'CONDA_PREFIX', 'CONDA_DEFAULT_ENV']) assert.ok(isPythonHostileEnvKey(k), k)
    for (const k of ['PATH', 'HOME', 'PIP_CONFIG_FILE']) assert.ok(!isPythonHostileEnvKey(k), k)
  })
})

describe('execProcess — 执行语义', () => {
  it('流式回调与聚合缓冲并存，退出码透传', async () => {
    const streamed: string[] = []
    const result = await execProcess({
      argv: [NODE, '-e', 'process.stdout.write("out1");process.stderr.write("err1");setTimeout(()=>process.stdout.write("out2"),50)'],
      onStdout: t => streamed.push(t),
    })
    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout, 'out1out2')
    assert.equal(result.stderr, 'err1')
    assert.ok(streamed.join('').includes('out1'))
    assert.equal(result.timedOut, false)
    assert.equal(result.cancelled, false)
  })

  it('非零退出码透传', async () => {
    const result = await execProcess({ argv: [NODE, '-e', 'process.exit(3)'] })
    assert.equal(result.exitCode, 3)
  })

  it('env 剥离生效：子进程看不到 PYTHONPATH', async () => {
    const prev = process.env['PYTHONPATH']
    process.env['PYTHONPATH'] = '/evil'
    try {
      const result = await execProcess({ argv: [NODE, '-e', 'process.stdout.write(process.env.PYTHONPATH ?? "unset")'] })
      assert.equal(result.stdout, 'unset')
    } finally {
      if (prev === undefined) delete process.env['PYTHONPATH']
      else process.env['PYTHONPATH'] = prev
    }
  })

  it('取消杀树：abort 后派生的孙进程一并回收', async () => {
    if (process.platform === 'win32') return // POSIX 进程组语义（Windows 走 taskkill，CI 另行覆盖）
    const dir = mkdtempSync(join(tmpdir(), 'process-exec-tree-'))
    const marker = join(dir, 'grandchild-alive')
    try {
      // 父进程 spawn 一个 1.5s 后写 marker 的孙进程，自己挂住。
      const script = `
        const { spawn } = require('node:child_process')
        spawn(process.execPath, ['-e', 'setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "alive"), 1500)'], { stdio: 'ignore' })
        setTimeout(() => {}, 60_000)
      `
      const controller = new AbortController()
      const promise = execProcess({ argv: [NODE, '-e', script], abortSignal: controller.signal })
      await new Promise(r => setTimeout(r, 300))
      controller.abort()
      const result = await promise
      assert.equal(result.cancelled, true)
      await new Promise(r => setTimeout(r, 1800))
      assert.equal(existsSync(marker), false, '孙进程应随进程组被杀')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('超时梯度：SIGTERM 被忽略时 3s 宽限后 SIGKILL', async () => {
    const start = Date.now()
    const result = await execProcess({
      argv: [NODE, '-e', 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 60_000)'],
      timeoutMs: 200,
    })
    assert.equal(result.timedOut, true)
    const elapsed = Date.now() - start
    assert.ok(elapsed >= 200, '未到超时就结算')
    assert.ok(elapsed < 10_000, `SIGKILL 宽限后仍未回收（${elapsed}ms）`)
  })

  it('聚合缓冲超限保留尾部并标注省略', async () => {
    const result = await execProcess({
      argv: [NODE, '-e', `process.stdout.write("x".repeat(200000)); process.stdout.write("TAIL_MARKER")`],
      maxBufferChars: 1000,
    })
    assert.equal(result.exitCode, 0)
    assert.ok(result.stdout.length < 3000)
    assert.match(result.stdout, /早期 stdout 省略/)
    assert.ok(result.stdout.endsWith('TAIL_MARKER'))
  })

  it('空 argv 拒绝', async () => {
    await assert.rejects(() => execProcess({ argv: [] }), /non-empty argv/)
  })

  it('可执行文件不存在 → exitCode -1 且错误进 stderr（不 throw）', async () => {
    const result = await execProcess({ argv: ['/definitely/not/a/binary-523', '--version'] })
    assert.equal(result.exitCode, -1)
    assert.ok(result.stderr.length > 0)
  })
})
