import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assessRunningBuild, verifyRunningBuild } from '../verify-running-build.mjs'

const expected = { buildId: 'candidate-123', version: '3.36.1', readiness: 'ready', ok: true, instanceId: 'live-1' }

test('running build check compares identity and readiness, including missing authenticated fields', () => {
  assert.deepEqual(assessRunningBuild(expected, 'candidate-123', '3.36.1'),
    { buildId: 'candidate-123', version: '3.36.1', instanceId: 'live-1' })
  assert.throws(() => assessRunningBuild({ ok: true }, 'candidate-123', '3.36.1'), /未返回 buildId/)
  assert.throws(() => assessRunningBuild({ ...expected, buildId: 'old-build' }, 'candidate-123', '3.36.1'), /buildId 不匹配/)
  assert.throws(() => assessRunningBuild({ ...expected, version: '3.36.0' }, 'candidate-123', '3.36.1'), /版本不匹配/)
  assert.throws(() => assessRunningBuild({ ...expected, readiness: 'initializing' }, 'candidate-123', '3.36.1'), /尚未就绪/)
})

test('running build check sends token only to loopback without redirects', async () => {
  let calls = 0
  const fetchImpl = async (url, options) => {
    calls++
    assert.equal(url.href, 'http://127.0.0.1:4999/health')
    assert.equal(options.headers.Authorization, 'Bearer fixture-token')
    assert.equal(options.redirect, 'error')
    return { ok: true, json: async () => expected }
  }
  const options = { token: 'fixture-token', expectedBuildId: 'candidate-123', expectedVersion: '3.36.1', fetchImpl }
  await assert.rejects(verifyRunningBuild({ ...options, url: 'https://example.com:4999' }), /只允许查询本机/)
  await assert.rejects(verifyRunningBuild({ ...options, url: 'http://127.0.0.2:4999' }), /只允许查询本机/)
  await assert.rejects(verifyRunningBuild({ ...options, expectedBuildId: '', url: 'http://127.0.0.1:4999' }), /缺少期望 buildId/)
  assert.equal(calls, 0)
  assert.deepEqual(await verifyRunningBuild({ ...options, url: 'http://127.0.0.1:4999/' }),
    { buildId: 'candidate-123', version: '3.36.1', instanceId: 'live-1' })
  assert.equal(calls, 1)
})
