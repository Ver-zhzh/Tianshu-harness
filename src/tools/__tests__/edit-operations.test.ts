import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AST_GREP_TOOL } from '../ast-grep.js'
import { EDIT_FILE_TOOL } from '../edit.js'
import { contentVersion } from '../../agent/file-version.js'
import { cpuPool } from '../../workers/cpu-pool.js'
import { fileRepairGuard } from '../../agent/file-repair-guard.js'
import { createTodoTool } from '../todo.js'
import { createFileRepairStore } from '../../agent/file-repair-store.js'
after(() => cpuPool.dispose())

test('AST inventory to a single atomic batch handles nested templates, Chinese and stale/foreign refs', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'edit-ops-')), previous = process.env.RIVET_SESSION_DIR
  process.env.RIVET_SESSION_DIR = join(cwd, 'sessions')
  const file = join(cwd, 'a.ts'), source = "const 文 = '中';\ndescribe('suite',()=>{\n  it('删甲',async()=>{const s=`${{a:'}'}.a}`;await Promise.resolve(s)});\n  it('保留',()=>{const nested=()=>({a:1});nested()});\n});\n"
  const params = { cwd, sessionId: 'owner', toolUseId: 'edit', input: {} as Record<string, unknown>, hasWriteClaim: () => true }
  try {
    writeFileSync(file, source)
    const found = await AST_GREP_TOOL.execute({ ...params, input: { paths: ['a.ts'], pattern: "it('删甲', $$$ARGS)", includeMeta: true } })
    assert.ok(!found.isError, found.content)
    const match = found.astMatches?.[0]
    assert.ok(match?.match_ref, found.content)
    const input = { file_path: 'a.ts', expected_version: contentVersion(source), operations: [{ match_ref: match.match_ref, new_string: '' }] }
    const foreign = await EDIT_FILE_TOOL.execute({ ...params, sessionId: 'other', input })
    assert.equal(foreign.isError, true); assert.equal(readFileSync(file, 'utf8'), source)
    const duplicate = await EDIT_FILE_TOOL.execute({ ...params, input: { ...input, operations: [...input.operations, ...input.operations] } })
    assert.equal(duplicate.isError, true); assert.equal(readFileSync(file, 'utf8'), source)
    const applied = await EDIT_FILE_TOOL.execute({ ...params, input })
    assert.ok(!applied.isError, applied.content)
    assert.equal(applied.mutations?.length, 1)
    const text = readFileSync(file, 'utf8')
    assert.ok(text.includes("it('保留'")); assert.ok(!text.includes("it('删甲'")); assert.ok(text.includes('const 文'))
    const staleVersionOnly = await EDIT_FILE_TOOL.execute({ ...params, input: { file_path: file, expected_version: contentVersion(source), operations: [{ old_string: '保留', new_string: '错误覆盖' }] } })
    assert.equal(staleVersionOnly.isError, true); assert.equal(readFileSync(file, 'utf8'), text)
    const stale = await EDIT_FILE_TOOL.execute({ ...params, input })
    assert.equal(stale.isError, true); assert.equal(readFileSync(file, 'utf8'), text)
  } finally { if (previous === undefined) delete process.env.RIVET_SESSION_DIR; else process.env.RIVET_SESSION_DIR = previous; rmSync(cwd, { recursive: true, force: true }) }
})
test('literal batches validate every operation and overlap before any write, and repair guards stay file-scoped', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'literal-ops-')), previous = process.env.RIVET_SESSION_DIR
  process.env.RIVET_SESSION_DIR = join(cwd, 'sessions')
  const source = '{"a":1,"b":2}', file = join(cwd, 'a.json')
  const params = { cwd, sessionId: 'owner', toolUseId: 'edit', input: {} as Record<string, unknown> }
  try {
    writeFileSync(file, source)
    for (const operations of [[{ old_string: '"a":1', new_string: '"a":3' }, { old_string: 'missing', new_string: '' }], [{ old_string: source, new_string: '{}' }, { old_string: '"a":1', new_string: '"a":3' }]]) {
      const result = await EDIT_FILE_TOOL.execute({ ...params, input: { file_path: file, expected_version: contentVersion(source), operations } })
      assert.equal(result.isError, true); assert.equal(readFileSync(file, 'utf8'), source)
    }
    const legacyStale = await EDIT_FILE_TOOL.execute({ ...params, input: { file_path: file, expected_version: 'stale', old_string: '1', new_string: '9' } })
    assert.equal(legacyStale.isError, true); assert.equal(readFileSync(file, 'utf8'), source)
    const store = createFileRepairStore(cwd, 'owner')
    for (const toolCallId of ['one', 'two']) store.record([{ sessionId: 'owner', toolCallId, file: 'a.json', before: { version: 'before', parse: 'valid' }, after: { version: 'after', parse: 'invalid' }, attemptedParse: 'invalid', attempted: true, restoration: 'conflict' }])
    assert.match(fileRepairGuard('bash', { ...params, input: { command: "python -c \"open('a.json','w').write('bad')\"" } })!, /受控恢复态/)
    assert.equal(fileRepairGuard('bash', { ...params, input: { command: 'cat a.json' } }), undefined)
    assert.match(fileRepairGuard('bash', { ...params, input: { command: `python -c "p='a'+'.json';open(p,'w').write('bad')"` } })!, /受控恢复态/)
    assert.equal(fileRepairGuard('deliver_task', params), undefined)
    assert.equal(fileRepairGuard('edit_file', { ...params, input: { file_path: 'a.json', expected_version: contentVersion(source) } }), undefined)
    assert.equal(fileRepairGuard('write_file', { ...params, input: { file_path: 'other.json' } }), undefined)
    const result = await EDIT_FILE_TOOL.execute({ ...params, input: { file_path: file, expected_version: contentVersion(source), operations: [{ old_string: '"a":1', new_string: '"a":3' }, { old_string: '"b":2', new_string: '"b":4' }] } })
    assert.ok(!result.isError, result.content); assert.equal(readFileSync(file, 'utf8'), '{"a":3,"b":4}')
    let disposed = ''
    const deferred = await createTodoTool().execute({ ...params, input: { action: 'write', todos: [], repairs: [{ file: 'a.json', state: 'deferred', reason: '用户决定稍后处理' }] }, onRepairDisposition: file => { disposed = file } })
    assert.ok(!deferred.isError, deferred.content); assert.equal(disposed, 'a.json')
    assert.equal(store.list()[0]!.state, 'deferred'); assert.equal(fileRepairGuard('write_file', { ...params, input: { file_path: 'a.json' } }), undefined)
  } finally { if (previous === undefined) delete process.env.RIVET_SESSION_DIR; else process.env.RIVET_SESSION_DIR = previous; rmSync(cwd, { recursive: true, force: true }) }
})

test('concurrent same-version batches serialize and only one applies', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'edit-lock-')), file = join(cwd, 'a.json'), source = '{"a":1}'
  writeFileSync(file, source)
  try {
    const results = await Promise.all([2, 3].map(n => EDIT_FILE_TOOL.execute({ cwd, sessionId: 'owner', toolUseId: String(n), input: { file_path: file, expected_version: contentVersion(source), operations: [{ old_string: '1', new_string: String(n) }] } })))
    assert.equal(results.filter(r => !r.isError).length, 1)
    assert.equal(results.filter(r => r.isError).length, 1)
    assert.equal(results.filter(r => r.mutations?.length === 1).length, 1)
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test('overlapping literal occurrences are ambiguous and replacement preserves CRLF', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'edit-exact-count-')), file = join(cwd, 'a.json'), source = '{"aaa":1}\r\n'
  try {
    writeFileSync(file, source)
    const ambiguous = await EDIT_FILE_TOOL.execute({ cwd, toolUseId: 'ambiguous', input: { file_path: file, expected_version: contentVersion(source), operations: [{ old_string: 'aa', new_string: 'zz' }] } })
    assert.equal(ambiguous.isError, true); assert.equal(readFileSync(file, 'utf8'), source)
    const updated = await EDIT_FILE_TOOL.execute({ cwd, toolUseId: 'crlf', input: { file_path: file, expected_version: contentVersion(source), operations: [{ old_string: '{"aaa":1}', new_string: '{\n"aaa":2\n}' }] } })
    assert.ok(!updated.isError, updated.content); assert.equal(readFileSync(file, 'utf8'), '{\r\n"aaa":2\r\n}\r\n')
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})
