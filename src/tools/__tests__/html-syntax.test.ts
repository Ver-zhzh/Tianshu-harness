import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkSyntax } from '../syntax-check.js'
import { WRITE_FILE_TOOL } from '../write-file.js'
import { EDIT_FILE_TOOL } from '../edit.js'
import { editFileArgProcessor } from '../edit-file-arg-processor.js'
import { resolveIdempotentPointer } from '../pointer-guard.js'
import { cpuPool } from '../../workers/cpu-pool.js'
after(() => cpuPool.dispose())
const html = (body: string, type = 'module') => `<!doctype html><html><body><script type="${type}">${body}</script></body></html>`

test('worker checks script/module bindings, maps errors and masks raw text without executing anything', async () => {
  const duplicate = await checkSyntax('a.html', html('\nfunction pediment(){}\nfunction pediment(){}'), { parseOnly: true })
  assert.match(duplicate.fatal!, /pediment.*already|already.*pediment/)
  assert.match(duplicate.fatal!, /3:/)
  const lexical = await checkSyntax('a.html', html('const pick = 1; function pick(){}'), { parseOnly: true })
  assert.match(lexical.fatal!, /pick/)
  for (const [file, type] of [['upper.HTML', 'module'], ['upper.HTM', 'application/x-javascript'], ['legacy.html', 'text/javascript1.5']]) {
    assert.match((await checkSyntax(file!, html('const pick=1;function pick(){}', type), { parseOnly: true })).fatal!, /pick/)
  }
  assert.equal((await checkSyntax('data.html', html('const p=1;function p(){}', 'module;not-a-module'), { parseOnly: true })).fatal, null)
  assert.equal((await checkSyntax('a.html', html('function p(){} function p(){}', 'text/javascript'), { parseOnly: true })).fatal, null)
  const raw = html('const 文 = `<div>中文`; globalThis.thisMustNeverExecute();')
    .replace('</body>', '<!-- <div> --> <script type="x-shader/x-fragment">not JS <foo></script><script type="application/json">{}</script><script src="https://invalid.example/no-load.js"></script></body>')
  const parsed = await checkSyntax('a.html', raw, { parseOnly: true })
  assert.equal(parsed.fatal, null)
  assert.equal(parsed.html?.checkedScripts, 1)
  assert.equal(parsed.html?.excluded.length, 3)
  assert.deepEqual(parsed.symbols, ['文'])
  const inert = await checkSyntax('inert.html', '<html><body><textarea><div></textarea><template><script type="module">const a=1;const a=2;</script></template></body></html>', { parseOnly: true })
  assert.equal(inert.fatal, null)
  assert.equal(inert.html?.excluded[0]?.reason, 'inert_template')
  assert.match((await checkSyntax('a.html', '<html><body><script>let n=1;', { parseOnly: true })).fatal!, /unclosed/)
})

test('real HTML write/edit rollback and context pointers retain actual outcome and bounded symbols', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'html-harness-')), file = join(cwd, 'index.html')
  const params = { cwd, sessionId: 'html-owner', toolUseId: 'create', input: { file_path: file, content: html('function tower(){}') } }
  const created = await WRITE_FILE_TOOL.execute(params)
  assert.ok(!created.isError, created.content)
  assert.deepEqual(created.fileStates?.[0]?.addedSymbols, ['tower'])
  const bad = await EDIT_FILE_TOOL.execute({ ...params, toolUseId: 'duplicate', input: { file_path: file, old_string: 'function tower(){}', new_string: 'function tower(){} function tower(){}' } })
  assert.equal(bad.isError, true)
  assert.equal(bad.fileStates?.[0]?.outcome, 'restored')
  assert.equal(readFileSync(file, 'utf8'), params.input.content)
  const applied = await EDIT_FILE_TOOL.execute({ ...params, toolUseId: 'extend', input: { file_path: file, old_string: 'function tower(){}', new_string: 'function tower(){} function bridge(){}' } })
  assert.ok(!applied.isError, applied.content)
  assert.deepEqual(applied.fileStates?.[0]?.addedSymbols, ['bridge'])
  assert.match(applied.content, /version=.*新增符号=bridge/)
  const pointer = editFileArgProcessor.process(JSON.stringify({ file_path: file, old_string: 'x', new_string: 'x'.repeat(9000) }))!
  assert.match(pointer, /执行状态以工具结果为准/)
  assert.doesNotMatch(pointer, /已成功落盘|已落盘/)
  const pendingPointer = JSON.parse(pointer).new_string
  assert.equal(await resolveIdempotentPointer({ mode: 'edit', filePath: file, value: pendingPointer, matchedPrefix: '[new block' }), null, 'an unresolved request pointer must not be reinterpreted as a successful no-op')
})

test('worker unavailability is unknown and never rolls back valid files', async () => {
  const run = cpuPool.run
  cpuPool.run = async () => { throw new Error('unavailable fixture') }
  try {
    const result = await checkSyntax('unknown.html', html('const uniqueUnknownFixture=42;'), { parseOnly: true })
    assert.equal(result.checked, false)
    assert.equal(result.fatal, null)
    assert.match(result.warning!, /未知/)
  } finally { cpuPool.run = run }
})
