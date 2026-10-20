import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runTestCommandIn, type RunTestCommandDeps } from '../run-tests.js'

class Child extends EventEmitter { stdout = new PassThrough(); stderr = new PassThrough() }

async function execute(chunks: Array<['stdout' | 'stderr', string]>, exitCode: number, timeout = false) {
  const cwd = mkdtempSync(join(tmpdir(), 'test-log-reporting-')), path = join(cwd, 'output.raw')
  const child = new Child()
  let expire: (() => void | Promise<void>) | undefined
  const deps: RunTestCommandDeps = {
    spawn: () => {
      setImmediate(() => {
        for (const [channel, text] of chunks) child[channel].write(text)
        if (timeout) void expire!()
        else child.emit('close', exitCode, null)
      })
      return child
    },
    kill() {}, persist: async (_id, raw) => { writeFileSync(path, raw); return path },
    setTimeout: (callback, ms) => { if (ms > 3000) expire = callback; return 0 }, clearTimeout() {},
    createDecoder: () => ({ write: data => data.toString(), end: () => '' }),
  }
  try {
    const result = await runTestCommandIn(cwd, {
      type: 'run', command: 'fixture-log-report', args: [], display: 'fixture-log-report', runner: 'declared', scope: 'full',
    }, { cwd, input: {}, toolUseId: 'log-report' }, undefined, 30_000, deps, cwd)
    return { result, saved: readFileSync(path, 'utf8') }
  } finally { rmSync(cwd, { recursive: true, force: true }) }
}

test('run_tests describes cropped stdout and stderr in both persisted and model-visible logs', async () => {
  const { result, saved } = await execute([
    ['stdout', 'EARLY_STDOUT\n' + 'x'.repeat(60_000)], ['stdout', 'y'.repeat(60_000)],
    ['stderr', 'EARLY_STDERR\n' + 'z'.repeat(110_000)],
  ], 1)
  assert.doesNotMatch(saved, /EARLY_STDOUT|EARLY_STDERR/)
  assert.ok(/stdout[^\n]*40013/.test(saved), 'persisted log must report omitted stdout characters')
  assert.ok(/stderr[^\n]*30013/.test(saved), 'persisted log must report omitted stderr characters')
  assert.match(result.content, /输出尾部/)
  assert.ok(result.content.includes(result.rawPath!))
  assert.doesNotMatch(result.content, /完整日志/)
})

test('run_tests does not promise a complete log when a large failure summary was cropped', async () => {
  const raw = 'EARLY_DIAGNOSTIC\n' + Array.from({ length: 700 }, (_, i) => `FAIL case-${i}\n  ${'detail '.repeat(30)}\n`).join('')
  const { result, saved } = await execute([['stdout', raw]], 1)
  assert.match(result.content, /中间省略/)
  assert.match(result.content, /输出尾部/)
  assert.doesNotMatch(result.content, /完整日志/)
  assert.ok(saved.includes('输出尾部'), 'persisted log must describe its limited scope')
})

for (const terminal of ['success', 'timeout'] as const) {
  test(`run_tests preserves the cropped-log warning on ${terminal}`, async () => {
    const { result, saved } = await execute([['stdout', 'x'.repeat(110_000) + '\n12 passed\n']], 0, terminal === 'timeout')
    assert.match(result.content, /输出尾部/)
    assert.ok(result.content.includes(result.rawPath!))
    assert.ok(saved.includes('输出尾部'), 'persisted log must describe its limited scope')
    assert.doesNotMatch(result.content, /完整日志/)
  })
}

test('run_tests keeps the complete-log hint when only the displayed summary is truncated', async () => {
  const raw = Array.from({ length: 80 }, (_, i) => `FAIL case-${i}\n  ${'detail '.repeat(20)}\n`).join('')
  const { result, saved } = await execute([['stdout', raw]], 1)
  assert.equal(saved, raw)
  assert.match(result.content, /中间省略[^\n]*完整日志见/)
})
