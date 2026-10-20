import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectPythonInterpreter, matchesPythonRequirement, type PythonExec } from '../interpreter.js'

const ABI_JSON = JSON.stringify({ version: [3, 12, 4], implementation: 'cpython', abi: '' })

/** 构造一个可工作的 python 探针桩：--version / ABI / venv / pip 全部成功。 */
function healthyExec(overrides: Partial<Record<string, { ok: boolean; stdout: string; stderr: string }>> = {}): PythonExec {
  return async (_command, args) => {
    const key = args.join(' ')
    if (overrides[key]) return overrides[key]!
    if (key === '--version') return { ok: true, stdout: 'Python 3.12.4\n', stderr: '' }
    if (key.startsWith('-c ')) return { ok: true, stdout: ABI_JSON + '\n', stderr: '' }
    if (key === '-m venv --help') return { ok: true, stdout: 'usage: venv', stderr: '' }
    if (key === '-m pip --version') return { ok: true, stdout: 'pip 24.0', stderr: '' }
    return { ok: false, stdout: '', stderr: `unexpected: ${key}` }
  }
}

function foundWhich(map: Record<string, string | undefined>): (command: string) => Promise<string | undefined> {
  return async command => map[command]
}

describe('detectPythonInterpreter', () => {
  it('命中首个候选：darwin 先探 python3', async () => {
    const calls: string[] = []
    const result = await detectPythonInterpreter({
      platform: 'darwin',
      which: async command => { calls.push(command); return command === 'python3' ? '/usr/bin/python3' : undefined },
      exec: healthyExec(),
      realpath: p => '/real' + p,
    })
    assert.deepEqual(calls, ['python3'])
    assert.ok(result.found)
    assert.equal(result.path, '/usr/bin/python3')
    assert.equal(result.realPath, '/real/usr/bin/python3')
    assert.equal(result.version, '3.12.4')
    assert.equal(result.abi, 'cpython-312')
    assert.equal(result.venvOk, true)
    assert.equal(result.pipOk, true)
  })

  it('python3 缺席时回退 python', async () => {
    const calls: string[] = []
    const result = await detectPythonInterpreter({
      platform: 'linux',
      which: async command => { calls.push(command); return command === 'python' ? '/usr/bin/python' : undefined },
      exec: healthyExec(),
    })
    assert.deepEqual(calls, ['python3', 'python'])
    assert.ok(result.found)
    assert.equal(result.path, '/usr/bin/python')
  })

  it('win32 探测序：python → py → python3', async () => {
    const calls: string[] = []
    const result = await detectPythonInterpreter({
      platform: 'win32',
      which: async command => { calls.push(command); return command === 'py' ? 'C:\\Python312\\py.exe' : undefined },
      exec: healthyExec(),
    })
    assert.deepEqual(calls, ['python', 'py'])
    assert.ok(result.found)
  })

  it('Windows 商店占位被跳过：执行失败且输出指向 Microsoft Store', async () => {
    const storeStub: PythonExec = async () => ({ ok: false, stdout: '', stderr: 'Python was not found; run without arguments to install from the Microsoft Store' })
    const calls: string[] = []
    const result = await detectPythonInterpreter({
      platform: 'win32',
      which: async command => { calls.push(command); return command === 'python' ? 'C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe' : command === 'py' ? 'C:\\py.exe' : undefined },
      exec: async (command, args) => command.includes('WindowsApps') ? storeStub(command, args) : healthyExec()(command, args),
    })
    assert.deepEqual(calls, ['python', 'py'])
    assert.ok(result.found)
    assert.equal(result.path, 'C:\\py.exe')
  })

  it('全部候选缺席 → interpreter_missing + 平台安装指引', async () => {
    const result = await detectPythonInterpreter({ platform: 'linux', which: foundWhich({}), exec: healthyExec() })
    assert.ok(!result.found)
    assert.equal(result.code, 'interpreter_missing')
    assert.match(result.guidance, /apt|python\.org/)
  })

  it('显式配置路径优先且不探 PATH；配置路径不可用时报不可用', async () => {
    let whichCalled = false
    const found = await detectPythonInterpreter({
      explicitPath: '/opt/python3.12/bin/python3',
      which: async () => { whichCalled = true; return undefined },
      exec: healthyExec(),
    })
    assert.ok(found.found)
    assert.equal(found.path, '/opt/python3.12/bin/python3')
    assert.equal(whichCalled, false)

    const missing = await detectPythonInterpreter({
      explicitPath: '/opt/nope/bin/python3',
      which: async () => { whichCalled = true; return undefined },
      exec: async () => ({ ok: false, stdout: '', stderr: 'no such file' }),
    })
    assert.ok(!missing.found)
    assert.match(missing.guidance, /\/opt\/nope\/bin\/python3/)
  })

  it('RIVET_PYTHON_PATH 环境变量优先于 explicitPath', async () => {
    const prev = process.env['RIVET_PYTHON_PATH']
    process.env['RIVET_PYTHON_PATH'] = '/env/python3'
    try {
      const result = await detectPythonInterpreter({ explicitPath: '/cfg/python3', exec: healthyExec() })
      assert.ok(result.found)
      assert.equal(result.path, '/env/python3')
    } finally {
      if (prev === undefined) delete process.env['RIVET_PYTHON_PATH']
      else process.env['RIVET_PYTHON_PATH'] = prev
    }
  })

  it('RIVET_PYTHON_PATH 跟随 options.env：提供时只读它，不泄漏全局进程环境', async () => {
    const prev = process.env['RIVET_PYTHON_PATH']
    process.env['RIVET_PYTHON_PATH'] = '/global/python3'
    try {
      // 1) options.env 显式提供 → 以它为准（全局值被忽略）
      const scoped = await detectPythonInterpreter({
        env: { RIVET_PYTHON_PATH: '/scoped/python3' },
        explicitPath: '/cfg/python3',
        exec: healthyExec(),
      })
      assert.ok(scoped.found)
      assert.equal(scoped.path, '/scoped/python3')

      // 2) options.env 提供但不含该变量 → 回落 explicitPath，不读全局
      const isolated = await detectPythonInterpreter({
        env: {},
        explicitPath: '/cfg/python3',
        exec: healthyExec(),
      })
      assert.ok(isolated.found)
      assert.equal(isolated.path, '/cfg/python3')
    } finally {
      if (prev === undefined) delete process.env['RIVET_PYTHON_PATH']
      else process.env['RIVET_PYTHON_PATH'] = prev
    }
  })

  it('venv / pip 探测失败只进诊断，不否决解释器', async () => {
    const result = await detectPythonInterpreter({
      platform: 'darwin',
      which: foundWhich({ python3: '/usr/bin/python3' }),
      exec: healthyExec({ '-m venv --help': { ok: false, stdout: '', stderr: 'No module named venv' }, '-m pip --version': { ok: false, stdout: '', stderr: 'No module named pip' } }),
    })
    assert.ok(result.found)
    assert.equal(result.venvOk, false)
    assert.equal(result.pipOk, false)
  })

  it('ABI 探针失败时保留 --version 解析结果', async () => {
    const result = await detectPythonInterpreter({
      platform: 'darwin',
      which: foundWhich({ python3: '/usr/bin/python3' }),
      exec: healthyExec({ '-c import sys,json;print(json.dumps({\'version\':list(sys.version_info[:3]),\'implementation\':sys.implementation.name,\'abi\':getattr(sys,\'abiflags\',\'\')}))': { ok: false, stdout: '', stderr: 'boom' } }),
    })
    assert.ok(result.found)
    assert.equal(result.version, '3.12.4')
    assert.equal(result.abi, undefined)
  })
})

describe('matchesPythonRequirement — requires 区间匹配', () => {
  it('逗号组合约束', () => {
    assert.deepEqual(matchesPythonRequirement('3.12.4', '>=3.10,<3.15'), { ok: true })
    assert.equal(matchesPythonRequirement('3.9.9', '>=3.10,<3.15').ok, false)
    assert.equal(matchesPythonRequirement('3.15.0', '>=3.10,<3.15').ok, false)
    assert.equal(matchesPythonRequirement('3.10.0', '>=3.10').ok, true)
  })

  it('== / != / > / <= 运算符', () => {
    assert.equal(matchesPythonRequirement('3.12.4', '==3.12.4').ok, true)
    assert.equal(matchesPythonRequirement('3.12.4', '==3.12').ok, false)
    assert.equal(matchesPythonRequirement('3.12.4', '!=3.13').ok, true)
    assert.equal(matchesPythonRequirement('3.12.4', '>3.11,<=3.13').ok, true)
    assert.equal(matchesPythonRequirement('3.11.0', '>3.11').ok, false)
  })

  it('无法解析的约束判不满足（坏声明不静默放行）', () => {
    for (const bad of ['=>3.10', '~>3.10', '3.10.*', 'abc']) {
      const result = matchesPythonRequirement('3.12.4', bad)
      assert.equal(result.ok, false, bad)
      assert.ok(result.reason)
    }
  })

  it('无法解析的解释器版本判不满足', () => {
    assert.equal(matchesPythonRequirement('not-a-version', '>=3.10').ok, false)
  })
})
