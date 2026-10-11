import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildMcpProxyEnv, buildStdioChildEnv, stripCodeExecEnvVars } from '../stdio-env.js'

describe('buildMcpProxyEnv', () => {
  it('无既有代理时，注入 network.proxy 到 HTTPS_PROXY/HTTP_PROXY', () => {
    const out = buildMcpProxyEnv({ PATH: '/usr/bin' }, { proxy: 'http://127.0.0.1:7890' })
    assert.deepEqual(out, {
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      HTTP_PROXY: 'http://127.0.0.1:7890',
    })
  })

  it('已有 HTTPS_PROXY 时不覆盖（用户显式配置优先）', () => {
    const out = buildMcpProxyEnv({ HTTPS_PROXY: 'http://user:8080' }, { proxy: 'http://127.0.0.1:7890' })
    assert.deepEqual(out, {})
  })

  it('小写 https_proxy 同样视为已设置', () => {
    const out = buildMcpProxyEnv({ https_proxy: 'http://user:8080' }, { proxy: 'http://127.0.0.1:7890' })
    assert.deepEqual(out, {})
  })

  it('已有 HTTP_PROXY 时也不再注入（与 whisper 相同的保守判定）', () => {
    const out = buildMcpProxyEnv({ HTTP_PROXY: 'http://user:8080' }, { proxy: 'http://127.0.0.1:7890' })
    assert.deepEqual(out, {})
  })

  it('noProxy 注入；已有 NO_PROXY 时不覆盖', () => {
    assert.deepEqual(
      buildMcpProxyEnv({}, { noProxy: 'localhost,127.0.0.1' }),
      { NO_PROXY: 'localhost,127.0.0.1' },
    )
    assert.deepEqual(buildMcpProxyEnv({ NO_PROXY: 'example.com' }, { noProxy: 'localhost' }), {})
  })

  it('未配置 / 空白配置 → 不注入任何键', () => {
    assert.deepEqual(buildMcpProxyEnv({}, undefined), {})
    assert.deepEqual(buildMcpProxyEnv(undefined, null), {})
    assert.deepEqual(buildMcpProxyEnv({}, { proxy: '   ', noProxy: '' }), {})
  })
})

describe('buildStdioChildEnv', () => {
  const deps = {
    execPath: '/opt/node/bin/node',
    platform: 'linux' as NodeJS.Platform,
    // 模拟该目录里有真 node → nodeDir prepend（issue #149）；目录里只有转发器时
    // 改 append，那条分支锁在 resolve-node-cli.test.ts 的 issue #408 用例里。
    existsSync: () => true,
    getDefaultEnvironment: () => ({ PATH: '/usr/bin' }),
  }

  it('合并 static + dynamic env，并注入 Node 目录到 PATH 与应用代理', () => {
    const env = buildStdioChildEnv(
      { FOO: 'bar' },
      { OAUTH_TOKEN: 'tok' },
      { proxy: 'http://127.0.0.1:7890' },
      deps,
    )
    assert.equal(env.FOO, 'bar')
    assert.equal(env.OAUTH_TOKEN, 'tok')
    assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890')
    assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:7890')
    assert.equal(env.PATH, '/opt/node/bin:/usr/bin')
  })

  it('server 显式 HTTPS_PROXY 优先于应用代理设置', () => {
    const env = buildStdioChildEnv(
      { HTTPS_PROXY: 'http://explicit:3128' },
      {},
      { proxy: 'http://127.0.0.1:7890' },
      deps,
    )
    assert.equal(env.HTTPS_PROXY, 'http://explicit:3128')
    assert.equal('HTTP_PROXY' in env, false)
  })

  it('未配置代理时不产生代理键（不污染子进程环境）', () => {
    const env = buildStdioChildEnv(undefined, {}, undefined, deps)
    assert.equal('HTTPS_PROXY' in env, false)
    assert.equal('HTTP_PROXY' in env, false)
    assert.equal('NO_PROXY' in env, false)
  })
})

// ── 对称 issue #137：启动即执行类环境变量必须剥离 ──
// MCP server 的静态 env 来自可写配置，且审批指纹刻意不绑定 env 键值（凭据轮换
// 容忍）——仅改值不触发重审。NODE_OPTIONS=--require 可在子进程启动即执行任意
// 代码（探针实证），bash 路径已在 #137 剥离，MCP 路径此前缺失。
describe('buildStdioChildEnv — 启动即执行类 env 剥离（对称 #137）', () => {
  const deps = {
    execPath: '/opt/node/bin/node',
    platform: 'linux' as NodeJS.Platform,
    existsSync: () => true,
    getDefaultEnvironment: () => ({ PATH: '/usr/bin' }),
  }

  it('stripCodeExecEnvVars 剥离 6 类变量，保留普通键', () => {
    const out = stripCodeExecEnvVars({
      NODE_OPTIONS: '--require /tmp/evil.cjs',
      JAVA_TOOL_OPTIONS: '-javaagent:/tmp/evil.jar',
      _JAVA_OPTIONS: '-X',
      JDK_JAVA_OPTIONS: '-X',
      LD_PRELOAD: '/tmp/evil.so',
      DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
      API_KEY: 'sk-live-xxx', // 普通 secret 键值照常透传（轮换容忍）
      FOO: 'bar',
    })
    assert.deepEqual(out, { API_KEY: 'sk-live-xxx', FOO: 'bar' })
  })

  it('大小写变体同样剥离（win32 环境变量大小写不敏感）', () => {
    const out = stripCodeExecEnvVars({ node_options: '--require x', Node_Options: '--x' })
    assert.deepEqual(out, {})
  })

  it('server 静态 env 里的 NODE_OPTIONS 经生产入口被剥离', () => {
    const env = buildStdioChildEnv(
      { NODE_OPTIONS: '--require /tmp/evil.cjs', FOO: 'bar' },
      {},
      undefined,
      deps,
    )
    assert.equal('NODE_OPTIONS' in env, false)
    assert.equal(env.FOO, 'bar')
  })

  it('dynamic（OAuth）env 同样受剥离约束', () => {
    const env = buildStdioChildEnv(undefined, { JAVA_TOOL_OPTIONS: '-javaagent:/tmp/e.jar' }, undefined, deps)
    assert.equal('JAVA_TOOL_OPTIONS' in env, false)
  })
})
// 只在下层（resolve-node-cli）测不够：本函数是 transport-factory 的实际入口，
// 中间层若重新注入 PATHEXT 会绕过净化——此用例锁住端到端契约。
describe('buildStdioChildEnv — PATHEXT 净化经生产入口生效（issue #149 根因 B）', () => {
  it('win32: 基座白名单带的 PATHEXT 被净化后传给子进程', () => {
    const env = buildStdioChildEnv(undefined, {}, undefined, {
      execPath: 'C:\\app\\node.exe',
      platform: 'win32',
      getDefaultEnvironment: () => ({ PATHEXT: '.COM;.EXE;.BAT;.CMD;.JS;.VBS', SYSTEMROOT: 'C:\\Windows' }),
    })
    assert.equal(env.PATHEXT, '.COM;.EXE;.BAT;.CMD')
  })

  it('win32: server 静态 env 里带的 PATHEXT 同样被净化（用户配置不是豁免）', () => {
    const env = buildStdioChildEnv({ PATHEXT: '.JS;.EXE' }, {}, undefined, {
      execPath: 'C:\\app\\node.exe',
      platform: 'win32',
      getDefaultEnvironment: () => ({}),
    })
    assert.equal(env.PATHEXT, '.EXE')
  })
})
