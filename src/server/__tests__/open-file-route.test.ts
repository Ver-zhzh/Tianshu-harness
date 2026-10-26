import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import type { ChildProcess, SpawnOptions, spawn } from 'node:child_process'
import { test } from 'node:test'
import { buildOpenFileRoute } from '../open-file-route.js'
import { createRouter } from '../index.js'

function fixture(options: { platform?: NodeJS.Platform; isDirectory?: boolean; hasHandler?: boolean; missing?: boolean; error?: boolean } = {}) {
  const launches: { cmd: string; args: readonly string[]; options: SpawnOptions }[] = []
  const route = createRouter(buildOpenFileRoute('fixture-auth', {
    platform: options.platform ?? 'win32',
    exists: () => !options.missing,
    isDirectory: () => options.isDirectory ?? true,
    hasHandler: () => options.hasHandler,
    spawn: ((cmd: string, args: readonly string[], spawnOptions: SpawnOptions) => {
      launches.push({ cmd, args, options: spawnOptions })
      const child = Object.assign(new EventEmitter(), { unref() {} })
      queueMicrotask(() => options.error ? child.emit('error', new Error('launch failed')) : child.emit('spawn'))
      return child as ChildProcess
    }) as typeof spawn,
  }))
  return {
    launches,
    call: (body: unknown, authenticated = true) => route('POST', '/open-file', body,
      authenticated ? { authorization: 'Bearer fixture-auth' } : {}),
  }
}

test('Windows folder opening launches a visible Explorer with the exact target', async () => {
  for (const [cwd, path, expected] of [
    ['D:\\项目 & 报表', 'docs', 'D:\\项目 & 报表\\docs'],
    ['D:/项目/报表', 'docs', 'D:\\项目\\报表\\docs'],
    ['D:\\', '.', 'D:\\'],
    ['\\\\server\\share\\项目', 'docs', '\\\\server\\share\\项目\\docs'],
    ['E:\\other', 'D:\\项目\\docs', 'D:\\项目\\docs'],
  ]) {
    const { call, launches } = fixture()
    const response = await call({ cwd, path })
    assert.equal(response.status, 200)
    assert.deepEqual(response.body, { opened: expected })
    assert.equal(launches.length, 1)
    assert.deepEqual(launches[0], {
      cmd: 'explorer.exe', args: [expected],
      options: { detached: true, stdio: 'ignore', windowsHide: false },
    }, 'the actual spawn call must not request SW_HIDE for Explorer')
  }
})

test('associated Windows files also open visibly, while reveal suppresses only the helper console', async () => {
  const file = fixture({ isDirectory: false, hasHandler: true })
  await file.call({ path: 'D:\\report.docx' })
  assert.equal(file.launches[0]?.cmd, 'explorer.exe')
  assert.equal(file.launches[0]?.options.windowsHide, false)

  for (const request of [{ path: 'D:\\report.docx', reveal: true }, { path: 'D:\\report.zzq' }]) {
    const reveal = fixture({ isDirectory: false, hasHandler: false })
    const response = await reveal.call(request)
    assert.equal(response.status, 200)
    assert.equal((response.body as { revealed: boolean }).revealed, true)
    assert.equal(reveal.launches[0]?.cmd, 'powershell.exe')
    assert.equal(reveal.launches[0]?.options.windowsHide, true)
  }
})

test('authentication, missing input and nonexistent targets cannot launch an opener', async () => {
  const normal = fixture()
  assert.equal((await normal.call({ path: 'D:\\work' }, false)).status, 401)
  for (const body of [undefined, {}, { path: '' }, { path: 123 }]) {
    assert.equal((await normal.call(body)).status, 400)
  }
  assert.equal(normal.launches.length, 0)
  const missing = fixture({ missing: true })
  assert.equal((await missing.call({ path: 'D:\\missing' })).status, 404)
  assert.equal(missing.launches.length, 0)
})

test('launch failures are reported instead of returning opened', async () => {
  const { call } = fixture({ error: true })
  const response = await call({ path: 'D:\\work' })
  assert.equal(response.status, 500)
  assert.match((response.body as { error: string }).error, /launch failed/)
})

test('macOS and Linux keep their existing open and reveal commands', async () => {
  for (const [platform, cmd, args] of [
    ['darwin', 'open', ['/work/docs']], ['linux', 'xdg-open', ['/work/docs']],
  ] as const) {
    const { call, launches } = fixture({ platform })
    assert.equal((await call({ cwd: '/work', path: 'docs' })).status, 200)
    assert.equal(launches[0]?.cmd, cmd)
    assert.deepEqual(launches[0]?.args, args)
  }
})

test('serve mounts the same open-file route whose spawn options are tested', () => {
  const source = readFileSync(new URL('../serve.ts', import.meta.url), 'utf8')
  assert.match(source, /Object\.assign\(routes, buildOpenFileRoute\(apiToken\)\)/)
  assert.doesNotMatch(source, /routes\['POST \/open-file'\] =/)
})
