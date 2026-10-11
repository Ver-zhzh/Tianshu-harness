/**
 * issue #450：sidecar 启动期 ACL 加固超时/失败时必须降级放行（warn + 继续），
 * 不能一票否决本地服务启动。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hardenServeDataDir } from '../serve.js'
import { setServerLogger, resetServerLogger } from '../logger.js'

function captureWarns() {
  const warns: string[] = []
  setServerLogger({
    info() {},
    warn: (message: string) => { warns.push(message) },
    error() {},
  })
  return warns
}

test('hardenServeDataDir: 加固成功时静默通过', (t) => {
  const warns = captureWarns()
  t.after(() => resetServerLogger())
  let calledWith = ''
  hardenServeDataDir('/fake/data', (dir) => { calledWith = dir })
  assert.equal(calledWith, '/fake/data')
  assert.equal(warns.length, 0)
})

test('hardenServeDataDir: 加固抛错时降级 warn、不向上传播', (t) => {
  const warns = captureWarns()
  t.after(() => resetServerLogger())
  assert.doesNotThrow(() =>
    hardenServeDataDir('/fake/data', () => { throw new Error('spawnSync powershell.exe ETIMEDOUT') }),
  )
  assert.equal(warns.length, 1)
  assert.match(warns[0]!, /#450/)
  assert.match(warns[0]!, /ETIMEDOUT/)
})

test('hardenServeDataDir: 默认走真实 ensurePrivateDirectory（签名兼容）', () => {
  // 只验证默认参数存在且可调用形状正确；真实加固的跨平台行为由
  // src/platform/__tests__/private-path.test.ts 覆盖。
  assert.equal(hardenServeDataDir.length, 1)
})
