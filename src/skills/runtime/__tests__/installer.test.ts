import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildInstallPreview, installRequirements, pipSourceFromMirrors, type InstallPreview } from '../installer.js'
import type { PythonInterpreter } from '../interpreter.js'
import type { MirrorsConfig } from '../../../config/schema.js'
import type { ProcessExecOptions, ProcessExecResult } from '../../../tools/process-exec.js'

const interpreter: PythonInterpreter = { found: true, path: '/usr/bin/python3', realPath: '/usr/bin/python3.12', version: '3.12.4', abi: 'cpython-312', venvOk: true, pipOk: true }
const mirrorsOff = { enabled: false } as MirrorsConfig
const mirrorsChina = { enabled: true, preset: 'china', pypi: 'tsinghua', github: 'default', npm: 'default', go: 'default', rust: 'default', autoFallback: true, fallbackMemoryMinutes: 10, fallbackTimeoutSec: 60 } as MirrorsConfig

function fixture(): { dir: string; envDir: string; packageRoot: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'skill-installer-'))
  return { dir, envDir: join(dir, 'env'), packageRoot: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function previewOf(dir: ReturnType<typeof fixture>, opts: { requirements?: string; mirrors?: MirrorsConfig; buildPolicy?: 'wheel' | 'source' } = {}): InstallPreview {
  const result = buildInstallPreview({
    skill: { scope: 'project', name: 'calc', skillId: 'abc123' },
    packageRef: 'f'.repeat(64), interpreter, packageRoot: dir.packageRoot,
    ...(opts.requirements !== undefined ? { requirementsSource: opts.requirements } : {}),
    mirrors: opts.mirrors ?? mirrorsOff, envDir: dir.envDir, buildPolicy: opts.buildPolicy ?? 'wheel',
  })
  assert.ok(result.ok)
  return result.preview
}

/** fake exec：命中 pip install（带 -r 的真实安装调用）时按预制输出应答，并落
 *  pip --report 产物；`--help` 探测默认报支持 --report（reportSupport:false 走老
 *  pip 兜底）；pipList 兜底路径的基线/安装后快照由 pipList.before/after 提供。 */
function fakeExec(behavior: { exitCode?: number; stdout?: string; stderr?: string; report?: unknown; reportSupport?: boolean; pipList?: { before: string[]; after: string[] }; cancelInstall?: boolean } = {}) {
  const calls: ProcessExecOptions[] = []
  let listCalls = 0
  const exec = async (options: ProcessExecOptions): Promise<ProcessExecResult> => {
    calls.push(options)
    const joined = options.argv.join(' ')
    // 探测调用恒成功（失败语义只作用于真实安装调用）。
    if (joined.includes('install') && joined.includes('--help')) {
      return { exitCode: 0, timedOut: false, cancelled: false, stdout: behavior.reportSupport === false ? 'Usage: pip install [options]' : 'Usage: pip install [options] --report <file>', stderr: '', durationMs: 1 }
    }
    if (joined.includes(' list ') || joined.includes('-m pip list')) {
      const names = (behavior.pipList ? (listCalls === 0 ? behavior.pipList.before : behavior.pipList.after) : [])
      listCalls++
      return { exitCode: 0, timedOut: false, cancelled: false, stdout: JSON.stringify(names.map(name => ({ name, version: name === 'six' ? '1.17.0' : '1.0' }))), stderr: '', durationMs: 1 }
    }
    const reportIndex = options.argv.indexOf('--report')
    if (reportIndex >= 0 && behavior.report !== undefined) {
      writeFileSync(options.argv[reportIndex + 1]!, JSON.stringify(behavior.report))
    }
    if (behavior.cancelInstall && options.argv.includes('-r')) {
      return { exitCode: -1, timedOut: false, cancelled: true, stdout: '', stderr: '', durationMs: 1 }
    }
    return {
      exitCode: behavior.exitCode ?? 0, timedOut: false, cancelled: false,
      stdout: behavior.stdout ?? '', stderr: behavior.stderr ?? '', durationMs: 5,
    }
  }
  return { calls, exec }
}

describe('pipSourceFromMirrors / buildInstallPreview — 预览载荷', () => {
  it('默认官方 PyPI；mirrors.pypi 经镜像表映射出 PIP_INDEX_URL/PIP_TRUSTED_HOST', () => {
    assert.deepEqual(pipSourceFromMirrors(mirrorsOff), { indexUrl: 'https://pypi.org/simple' })
    assert.deepEqual(pipSourceFromMirrors(mirrorsChina), { indexUrl: 'https://pypi.tuna.tsinghua.edu.cn/simple', trustedHost: 'pypi.tuna.tsinghua.edu.cn' })
  })

  it('预览载荷含技能身份/版本/解释器/审核结果/包源/环境目录/构建策略', () => {
    const f = fixture()
    try {
      const preview = previewOf(f, { requirements: 'httpx==0.27.2\n', mirrors: mirrorsChina })
      assert.deepEqual(preview.skill, { scope: 'project', name: 'calc', skillId: 'abc123' })
      assert.equal(preview.packageRef, 'f'.repeat(64))
      assert.deepEqual(preview.interpreter, { path: '/usr/bin/python3', realPath: '/usr/bin/python3.12', version: '3.12.4', abi: 'cpython-312' })
      assert.equal(preview.requirements?.requirements[0]?.name, 'httpx')
      assert.equal(preview.source.indexUrl, 'https://pypi.tuna.tsinghua.edu.cn/simple')
      assert.equal(preview.envDir, f.envDir)
      assert.equal(preview.buildPolicy, 'wheel')
    } finally { f.cleanup() }
  })

  it('requirements 审核失败 → invalid_requirements（不产出预览）', () => {
    const f = fixture()
    try {
      const result = buildInstallPreview({
        skill: { scope: 'project', name: 'calc', skillId: 'abc123' }, packageRef: 'f'.repeat(64),
        interpreter, packageRoot: f.packageRoot, requirementsSource: '-e ./bad\n', mirrors: mirrorsOff, envDir: f.envDir,
      })
      assert.ok(!result.ok)
      assert.equal(result.result.errorCode, 'invalid_requirements')
      assert.equal(result.result.stage, 'prepare')
    } finally { f.cleanup() }
  })
})

describe('installRequirements — 安装编排', () => {
  it('wheel 默认：argv 含 --only-binary :all: 与 --report；禁交互；隔离宿主 pip 配置', async () => {
    const f = fixture()
    try {
      const fake = fakeExec({ report: { install: [{ metadata: { name: 'httpx', version: '0.27.2' }, download_info: { archive_info: { hashes: { sha256: 'abc' } } } }] } })
      const preview = previewOf(f, { requirements: 'httpx==0.27.2\n', mirrors: mirrorsChina })
      const prev = process.env['PYTHONPATH']
      process.env['PYTHONPATH'] = '/evil'
      try {
        const result = await installRequirements({ preview, envPython: join(f.envDir, 'bin', 'python'), exec: fake.exec })
        assert.equal(result.errorCode, undefined)
        assert.equal(result.exitCode, 0)
      } finally {
        if (prev === undefined) delete process.env['PYTHONPATH']
        else process.env['PYTHONPATH'] = prev
      }
      const pipCall = fake.calls.find(c => c.argv.includes('-r'))!
      const argv = pipCall.argv
      assert.ok(argv.includes('--only-binary') && argv.includes(':all:'), 'wheel 策略')
      assert.ok(argv.includes('--disable-pip-version-check') && argv.includes('--no-input'), '禁交互')
      assert.ok(argv.includes('--report'))
      assert.equal(argv[0], join(f.envDir, 'bin', 'python'), '用环境自身 python')
      assert.equal(pipCall.env?.['PIP_CONFIG_FILE'], process.platform === 'win32' ? 'NUL' : '/dev/null')
      assert.equal(pipCall.env?.['PIP_INDEX_URL'], 'https://pypi.tuna.tsinghua.edu.cn/simple')
      assert.equal(pipCall.env?.['PIP_TRUSTED_HOST'], 'pypi.tuna.tsinghua.edu.cn')
      assert.equal(pipCall.env?.['PYTHONPATH'], undefined, 'PYTHONPATH 被剥离')
      assert.equal(typeof pipCall.env?.['PATH'], 'string', 'PATH 白名单保留')
    } finally { f.cleanup() }
  })

  it('source 策略：去掉 --only-binary', async () => {
    const f = fixture()
    try {
      const fake = fakeExec({ report: { install: [] } })
      const preview = previewOf(f, { requirements: 'httpx==0.27.2\n', buildPolicy: 'source' })
      await installRequirements({ preview, envPython: join(f.envDir, 'bin', 'python'), exec: fake.exec })
      const argv = fake.calls.find(c => c.argv.includes('-r'))!.argv
      assert.ok(!argv.includes('--only-binary'))
    } finally { f.cleanup() }
  })

  it('缺 wheel：归类 no_wheel，报出具体依赖与原因，不就地降级', async () => {
    const f = fixture()
    try {
      const fake = fakeExec({ exitCode: 1, stderr: 'ERROR: Could not find a version that satisfies the requirement sdistonly (from versions: none)\nERROR: No matching distribution found for sdistonly' })
      const preview = previewOf(f, { requirements: 'sdistonly==1.0\n' })
      const result = await installRequirements({ preview, envPython: join(f.envDir, 'bin', 'python'), exec: fake.exec })
      assert.equal(result.errorCode, 'no_wheel')
      assert.match(result.message, /sdistonly/)
      assert.match(result.message, /buildPolicy:'source'/)
    } finally { f.cleanup() }
  })

  it('网络失败归类 network_failure；取消归类 cancelled', async () => {
    const f = fixture()
    try {
      const netFail = fakeExec({ exitCode: 2, stderr: 'WARNING: Retrying... Caused by NewConnectionError: Failed to establish a new connection: Connection refused' })
      const preview = previewOf(f, { requirements: 'httpx==0.27.2\n' })
      const result = await installRequirements({ preview, envPython: join(f.envDir, 'bin', 'python'), exec: netFail.exec })
      assert.equal(result.errorCode, 'network_failure')

      const cancelResult = await installRequirements({ preview, envPython: join(f.envDir, 'bin', 'python'), exec: fakeExec({ cancelInstall: true }).exec })
      assert.equal(cancelResult.errorCode, 'cancelled')
    } finally { f.cleanup() }
  })

  it('源码构建失败归类 source_build_failed', async () => {
    const f = fixture()
    try {
      const fake = fakeExec({ exitCode: 1, stderr: 'error: subprocess-exited-with-error\n  × python setup.py bdist_wheel did not run successfully.' })
      const preview = previewOf(f, { requirements: 'native==1.0\n', buildPolicy: 'source' })
      const result = await installRequirements({ preview, envPython: join(f.envDir, 'bin', 'python'), exec: fake.exec })
      assert.equal(result.errorCode, 'source_build_failed')
    } finally { f.cleanup() }
  })

  it('安装报告：pip --report 为事实源，含解析版本/哈希/未锁定标记/规范化 requirements', async () => {
    const f = fixture()
    try {
      const fake = fakeExec({
        report: {
          install: [
            { metadata: { name: 'httpx', version: '0.27.2' }, download_info: { archive_info: { hashes: { sha256: 'deadbeef' } } } },
            { metadata: { name: 'httpcore', version: '1.0.5' }, download_info: { archive_info: { hashes: { sha256: 'cafe' } } } },
          ],
        },
      })
      const preview = previewOf(f, { requirements: 'httpx==0.27.2\nloose>=1\n' })
      const result = await installRequirements({ preview, envPython: join(f.envDir, 'bin', 'python'), exec: fake.exec })
      assert.equal(result.errorCode, undefined)
      const report = JSON.parse(readFileSync(join(f.envDir, 'install-report.json'), 'utf8'))
      assert.equal(report.schemaVersion, 1)
      assert.deepEqual(report.resolved.map((r: any) => `${r.name}@${r.version}`), ['httpx@0.27.2', 'httpcore@1.0.5'])
      assert.equal(report.resolved[0].hashes.sha256, 'deadbeef')
      assert.deepEqual(report.unpinned, ['loose'])
      assert.equal(report.requirements, 'httpx==0.27.2\nloose>=1\n')
      assert.equal(report.buildPolicy, 'wheel')
      assert.equal(report.interpreter.version, '3.12.4')
      assert.ok(report.createdAt)
    } finally { f.cleanup() }
  })

  it('pip --report 缺失/不可解析 → 按失败处理（无法证明解析结果）', async () => {
    const f = fixture()
    try {
      const fake = fakeExec({}) // 不落 report
      const preview = previewOf(f, { requirements: 'httpx==0.27.2\n' })
      const result = await installRequirements({ preview, envPython: join(f.envDir, 'bin', 'python'), exec: fake.exec })
      assert.equal(result.errorCode, 'invalid_requirements')
      assert.equal(existsSync(join(f.envDir, 'install-report.json')), false)
    } finally { f.cleanup() }
  })

  it('老 pip 无 --report → pip list 快照差兜底（reportMode 如实标注，无 --report 进 argv）', async () => {
    const f = fixture()
    try {
      const fake = fakeExec({ reportSupport: false, pipList: { before: ['pip', 'setuptools'], after: ['pip', 'setuptools', 'six'] } })
      const preview = previewOf(f, { requirements: 'six==1.17.0\n' })
      const result = await installRequirements({ preview, envPython: join(f.envDir, 'bin', 'python'), exec: fake.exec })
      assert.equal(result.errorCode, undefined, JSON.stringify(result))
      const installCall = fake.calls.find(c => c.argv.includes('-r'))!
      assert.ok(!installCall.argv.includes('--report'))
      const report = JSON.parse(readFileSync(join(f.envDir, 'install-report.json'), 'utf8'))
      assert.equal(report.reportMode, 'pip-list-fallback')
      assert.deepEqual(report.resolved, [{ name: 'six', version: '1.17.0', hashes: {} }])
    } finally { f.cleanup() }
  })

  it('仅标准库（requirements null）：跳过安装，报告照样落盘', async () => {
    const f = fixture()
    try {
      const fake = fakeExec({})
      const preview = previewOf(f)
      const result = await installRequirements({ preview, envPython: join(f.envDir, 'bin', 'python'), exec: fake.exec })
      assert.equal(result.errorCode, undefined)
      assert.match(result.message, /仅标准库/)
      assert.equal(fake.calls.length, 0, '不应跑 pip')
      const report = JSON.parse(readFileSync(join(f.envDir, 'install-report.json'), 'utf8'))
      assert.deepEqual(report.resolved, [])
    } finally { f.cleanup() }
  })
})
