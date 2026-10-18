/**
 * 资料写远端（`src/auth/account-profile-update.ts`）的重试契约。
 *
 * 依据的真实事故：弱网直连下带头像的请求体（base64 内联，上限 192KB）一次失败
 * 就被宣判，用户只能挂代理才能存头像。覆盖写幂等，所以连接重置/超时/上游 5xx
 * 重试一次；4xx 与「200 但 body.ok 非真」是明确拒绝，重试无意义。
 *
 * 运行：npm exec -- tsx --test src/auth/__tests__/account-profile-update.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { updateAccountProfile } from '../account-profile-update.js'

/** 依次回放给定结果的假 fetch；Error 表示抛出（连接重置/超时）。 */
function stubFetchSequence(replies: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const impl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    const reply = replies[calls.length - 1] ?? replies[replies.length - 1]!
    if (reply instanceof Error) throw reply
    return reply.clone()
  }) as unknown as typeof fetch
  return { calls, impl }
}

test('请求形状：Bearer、apikey、字段原样进 body', async () => {
  const { calls, impl } = stubFetchSequence([new Response(JSON.stringify({ ok: true }), { status: 200 })])
  const result = await updateAccountProfile('at-secret', { name: '新昵称', avatar: null }, { fetchImpl: impl, retryDelayMs: 0 })
  assert.deepEqual(result, { ok: true })
  assert.match(calls[0]!.url, /\/functions\/v1\/tui-account-profile-update$/)
  const headers = calls[0]!.init.headers as Record<string, string>
  assert.equal(headers.Authorization, 'Bearer at-secret')
  assert.ok(headers.apikey, 'apikey 是 verify_jwt 的凭据，缺了直接 401')
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { name: '新昵称', avatar: null })
  assert.ok(calls[0]!.init.signal instanceof AbortSignal, '必须有超时信号，否则单请求能挂死')
})

test('连接重置后重试成功', async () => {
  const { calls, impl } = stubFetchSequence([
    new Error('ECONNRESET'),
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  ])
  const result = await updateAccountProfile('at', { name: 'x' }, { fetchImpl: impl, retryDelayMs: 0 })
  assert.deepEqual(result, { ok: true })
  assert.equal(calls.length, 2)
})

test('持续不可达才报 unavailable，且恰好重试一次', async () => {
  const { calls, impl } = stubFetchSequence([new Error('ECONNREFUSED'), new Error('ECONNREFUSED'), new Error('ECONNREFUSED')])
  const result = await updateAccountProfile('at', { name: 'x' }, { fetchImpl: impl, retryDelayMs: 0 })
  assert.deepEqual(result, { ok: false, error: 'profile_update_unavailable' })
  assert.equal(calls.length, 2)
})

test('上游 5xx 视为临时故障重试；第二次仍失败透出当时的 error', async () => {
  const { calls, impl } = stubFetchSequence([
    new Response(JSON.stringify({ error: 'boom' }), { status: 500 }),
    new Response(JSON.stringify({ error: 'still_broken' }), { status: 502 }),
  ])
  const result = await updateAccountProfile('at', { name: 'x' }, { fetchImpl: impl, retryDelayMs: 0 })
  assert.deepEqual(result, { ok: false, error: 'still_broken' })
  assert.equal(calls.length, 2)
})

test('4xx 是明确拒绝，不重试', async () => {
  const { calls, impl } = stubFetchSequence([new Response(JSON.stringify({ error: 'invalid_name' }), { status: 400 })])
  const result = await updateAccountProfile('at', { name: 'x' }, { fetchImpl: impl, retryDelayMs: 0 })
  assert.deepEqual(result, { ok: false, error: 'invalid_name' })
  assert.equal(calls.length, 1)
})

test('非 JSON 的 4xx 同样是明确拒绝，不重试', async () => {
  const { calls, impl } = stubFetchSequence([new Response('Unauthorized', { status: 401 })])
  const result = await updateAccountProfile('at', { name: 'x' }, { fetchImpl: impl, retryDelayMs: 0 })
  assert.deepEqual(result, { ok: false, error: 'profile_update_failed' })
  assert.equal(calls.length, 1)
})

test('只有带头像操作放宽单次请求超时', async ctx => {
  const timeouts: number[] = []
  const original = AbortSignal.timeout.bind(AbortSignal)
  ctx.mock.method(AbortSignal, 'timeout', (ms: number) => { timeouts.push(ms); return original(ms) })
  const { impl } = stubFetchSequence([new Response('{"ok":true}')])
  await updateAccountProfile('at', { name: 'x' }, { fetchImpl: impl })
  await updateAccountProfile('at', { name: 'x', avatar: 'data:image/png;base64,AA==' }, { fetchImpl: impl })
  assert.deepEqual(timeouts, [10_000, 30_000])
})

test('200 但 body.ok 非真按拒绝处理（不重试），error 透传', async () => {
  const { calls, impl } = stubFetchSequence([new Response(JSON.stringify({ ok: false, error: 'name_taken' }), { status: 200 })])
  const result = await updateAccountProfile('at', { name: 'x' }, { fetchImpl: impl, retryDelayMs: 0 })
  assert.deepEqual(result, { ok: false, error: 'name_taken' })
  assert.equal(calls.length, 1)
})

test('响应非 JSON 视作链路故障并重试', async () => {
  const { calls, impl } = stubFetchSequence([
    new Response('not-json', { status: 200 }),
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  ])
  const result = await updateAccountProfile('at', { name: 'x' }, { fetchImpl: impl, retryDelayMs: 0 })
  assert.deepEqual(result, { ok: true })
  assert.equal(calls.length, 2)
})
