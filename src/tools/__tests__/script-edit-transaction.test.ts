import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BASH_TOOL } from '../bash.js'
import { executeScriptTransaction } from '../script-edit-transaction.js'
import type { ToolCallParams } from '../types.js'

const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'script-transaction-'))
  writeFileSync(join(cwd, 'a.ts'), 'export const a = 1\n')
  const params: ToolCallParams = { cwd, toolUseId: 'transaction', sessionId: 'owner', input: {}, hasWriteClaim: () => true }
  const execute = (code: string, input: Record<string, unknown> = {}, extras: Partial<ToolCallParams> = {}) => BASH_TOOL.execute({ ...params, ...extras, input: { command: `node -e ${quote(code)}`, write_files: ['a.ts'], timeout: 5000, ...input } })
  return { cwd, params, execute, read: (file = 'a.ts') => readFileSync(join(cwd, file), 'utf8'), cleanup: () => rmSync(cwd, { recursive: true, force: true }) }
}
test('real bash transactions keep successful explicit writes, creations and deletions', async () => {
  const f = fixture(), recorded: string[] = []
  try {
    const result = await f.execute("const fs=require('fs');fs.writeFileSync('new.ts','export const n = 1');fs.unlinkSync('a.ts')", { write_files: ['a.ts', 'new.ts'] }, { onFileWrite: p => recorded.push(p) })
    assert.ok(!result.isError, result.content)
    assert.equal(existsSync(join(f.cwd, 'a.ts')), false)
    assert.equal(f.read('new.ts'), 'export const n = 1')
    assert.deepEqual(recorded.sort(), ['a.ts', 'new.ts'])
  } finally { f.cleanup() }
})
test('a new fatal syntax error restores every declared file including earlier valid writes', async () => {
  const f = fixture()
  try {
    const result = await f.execute("const fs=require('fs');fs.writeFileSync('a.ts','export const a = 2');fs.writeFileSync('new.json','{broken')", { write_files: ['a.ts', 'new.json'] })
    assert.equal(result.isError, true, result.content)
    assert.equal(f.read(), 'export const a = 1\n')
    assert.equal(existsSync(join(f.cwd, 'new.json')), false)
    assert.match(result.content, /已恢复本次捕获/)
  } finally { f.cleanup() }
})
test('failed commands restore deleted originals and remove creations', async () => {
  const f = fixture()
  try {
    const result = await f.execute("const fs=require('fs');fs.unlinkSync('a.ts');fs.writeFileSync('new.json','{}');process.exit(2)", { write_files: ['a.ts', 'new.json'] })
    assert.equal(result.isError, true)
    assert.equal(f.read(), 'export const a = 1\n')
    assert.equal(existsSync(join(f.cwd, 'new.json')), false)
  } finally { f.cleanup() }
})
for (const terminal of ['cancel', 'timeout'] as const) test(`real ${terminal} stops the child before restoration`, async () => {
  const f = fixture(), controller = new AbortController()
  try {
    const pending = f.execute("const fs=require('fs');fs.writeFileSync('a.ts','export const a = 2');setInterval(()=>fs.writeFileSync('a.ts','export const a = 3'),25)", { timeout: terminal === 'timeout' ? 150 : 5000 }, { abortSignal: controller.signal })
    if (terminal === 'cancel') {
      for (let i = 0; i < 200 && f.read() === 'export const a = 1\n'; i++) await new Promise(r => setTimeout(r, 10))
      assert.notEqual(f.read(), 'export const a = 1\n', 'child actually started')
      controller.abort()
    }
    const result = await pending
    assert.equal(result.isError, true, result.content)
    assert.equal(f.read(), 'export const a = 1\n')
    await new Promise(r => setTimeout(r, 80))
    assert.equal(f.read(), 'export const a = 1\n', 'no writer remains after rollback')
  } finally { controller.abort(); f.cleanup() }
})
test('version conflict, lost claim and unknown process state preserve bytes and backups', async () => {
  for (const variant of ['version', 'claim', 'process']) {
    const f = fixture(); let owned = true
    try {
      const result = await executeScriptTransaction({ params: { ...f.params, hasWriteClaim: () => owned, input: { command: 'fixture mutation', write_files: ['a.ts'] } }, run: async p => {
        writeFileSync(join(f.cwd, 'a.ts'), 'export const a = 2')
        p.onProcessExit?.(variant === 'process' ? 'unknown' : 'exited')
        if (variant === 'version') writeFileSync(join(f.cwd, 'a.ts'), 'export const peer = 3')
        if (variant === 'claim') owned = false
        return { content: 'failed fixture', isError: true, exitCode: 1 }
      } })
      assert.equal(f.read(), variant === 'version' ? 'export const peer = 3' : 'export const a = 2')
      assert.match(result.content, /未恢复.*备份/)
    } finally { f.cleanup() }
  }
})
test('preexisting damage and unknown formats are disclosed without syntax-driven restoration', async () => {
  const f = fixture()
  try {
    writeFileSync(join(f.cwd, 'a.ts'), 'export const a =')
    const result = await f.execute("require('fs').writeFileSync('a.ts','export const a ==')")
    assert.ok(!result.isError, result.content)
    assert.match(result.content, /原文件已有语法错误/)
    assert.equal(f.read(), 'export const a ==')
    const unknown = await f.execute("require('fs').writeFileSync('plain.txt','new')", { write_files: ['plain.txt'] })
    assert.match(unknown.content, /语法状态未知/)
  } finally { f.cleanup() }
})
test('invalid/background/unowned paths reject before the command or job can start', async () => {
  const f = fixture(), outside = mkdtempSync(join(tmpdir(), 'script-outside-'))
  try {
    symlinkSync(outside, join(f.cwd, 'link'))
    for (const input of [{ write_files: ['.'] }, { write_files: ['*.ts'] }, { write_files: ['../escape.ts'] }, { write_files: ['link/out.ts'] }, { write_files: ['.env'] }, { run_in_background: true }, { timeout: 0 }]) {
      const result = await f.execute("require('fs').writeFileSync('STARTED','yes')", input)
      assert.equal(result.isError, true, result.content)
      assert.equal(result.errorKind, 'format_error')
      assert.equal(existsSync(join(f.cwd, 'STARTED')), false)
    }
    assert.equal((await f.execute("throw Error('must not run')", {}, { hasWriteClaim: () => false })).errorKind, 'format_error')
  } finally { f.cleanup(); rmSync(outside, { recursive: true, force: true }) }
})
