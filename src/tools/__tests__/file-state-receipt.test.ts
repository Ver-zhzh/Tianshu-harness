import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, utimesSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { READ_FILE_TOOL, getFileReadMtime, getFileReadContentHash, isFileFullyObserved } from '../read-file.js'
import { WRITE_FILE_TOOL } from '../write-file.js'
import { EDIT_FILE_TOOL } from '../edit.js'
import { APPLY_PATCH_TOOL } from '../apply-patch.js'
import { contentVersion } from '../../agent/file-version.js'
import { cpuPool } from '../../workers/cpu-pool.js'
import { fileReadGate } from '../../agent/file-read-gate.js'
import { attachMutationReceipts } from '../file-state-receipt.js'
import { noteFileObserved, noteFileWritten } from '../read-file-state.js'
import type { ToolResult } from '../types.js'
import { observeMutationFile } from '../../agent/mutation-facts.js'
after(() => cpuPool.dispose())

test('real Git patch local, delegated and client-fallback paths retain versions and partial scope', async () => {
  for (const mode of ['local', 'delegated', 'failback']) {
    const cwd = mkdtempSync(join(tmpdir(), 'patch-observation-')), file = join(cwd, 'a.txt'), sessionId = 'patch-scope'
    const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' })
    mkdirSync(join(cwd, 'empty-hooks'))
    git('init'); writeFileSync(file, 'before\n'); git('add', 'a.txt')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${join(cwd, 'empty-hooks')}`, 'commit', '-m', 'baseline')
    const params = { cwd, sessionId, toolUseId: `patch-${mode}` }
    await READ_FILE_TOOL.execute({ ...params, input: { file_path: file } })
    let delegates = 0
    const result = await APPLY_PATCH_TOOL.execute({ ...params,
      input: { diff: 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-before\n+after\n' },
      ...(mode === 'local' ? {} : { onClientDelegate: async (_kind: string, payload: any) => {
        delegates++
        if (mode === 'failback') return null
        writeFileSync(join(cwd, payload.path), payload.newContent)
        return { status: 'ok' as const, content: 'accepted fixture edit' }
      } }),
    })
    assert.ok(!result.isError, result.content)
    assert.equal(delegates, mode === 'local' ? 0 : 1, `${mode} must reach its actual landing branch`)
    assert.equal(readFileSync(file, 'utf8'), 'after\n')
    assert.equal(git('show', ':a.txt').toString(), mode === 'local' ? 'after\n' : 'before\n', 'client materialization stages only its private index')
    assert.equal(getFileReadContentHash(file, sessionId), contentVersion(readFileSync(file)))
    assert.equal(result.fileStates?.[0]?.observation, 'partial')
    assert.equal(isFileFullyObserved(file, sessionId), false)
    const edit = { file_path: file, old_string: 'after', new_string: 'continued' }
    assert.equal(fileReadGate('edit_file', { ...params, input: edit }), undefined)
    assert.ok(!(await EDIT_FILE_TOOL.execute({ ...params, input: edit })).isError)
    const overwrite = await WRITE_FILE_TOOL.execute({ ...params, input: { file_path: file, content: 'whole rewrite\n' } })
    assert.equal(overwrite.isError, true, 'a partial patch does not authorize blind whole-file replacement')
  }
})

test('single and batch edits retain actual LF/CRLF versions and uniformly revoke whole-file observation', async () => {
  for (const eol of ['\n', '\r\n']) for (const batch of [false, true]) {
    const cwd = mkdtempSync(join(tmpdir(), 'edit-observation-')), file = join(cwd, 'a.json'), sessionId = 'edit-scope'
    writeFileSync(file, '{"n":1}' + eol)
    const params = { cwd, sessionId, toolUseId: 'scope' }
    await READ_FILE_TOOL.execute({ ...params, input: { file_path: file } })
    for (const [old_string, new_string] of [['"n":1', '"n":2'], ['"n":2', '"n":200']]) {
      const result = await EDIT_FILE_TOOL.execute({ ...params, input: batch
        ? { file_path: file, expected_version: contentVersion(readFileSync(file)), operations: [{ old_string, new_string }] }
        : { file_path: file, old_string, new_string } })
      assert.ok(!result.isError, result.content)
      assert.equal(getFileReadContentHash(file, sessionId), contentVersion(readFileSync(file)))
      assert.equal(result.fileStates?.[0]?.observation, 'partial')
      assert.equal(isFileFullyObserved(file, sessionId), false)
      assert.equal(fileReadGate('edit_file', { ...params, input: { file_path: file, old_string: '200', new_string: '300' } }), undefined)
    }
    const overwrite = await WRITE_FILE_TOOL.execute({ ...params, input: { file_path: file, content: '{}' + eol } })
    assert.equal(overwrite.isError, true)
    await READ_FILE_TOOL.execute({ ...params, input: { file_path: file } })
    assert.ok(!(await WRITE_FILE_TOOL.execute({ ...params, input: { file_path: file, content: '{}' + eol } })).isError)
  }
  noteFileObserved('/same-stamp', 1, 1, 'scope', 'a', true)
  noteFileWritten('/same-stamp', 1, 1, 'scope', 'b', false)
  assert.equal(isFileFullyObserved('/same-stamp', 'scope'), false)
})

test('unknown versions are never unchanged, while confirmed absence and deletion stay distinguishable', async () => {
  const result: ToolResult = { content: 'fixture' }
  const cwd = mkdtempSync(join(tmpdir(), 'unknown-observation-'))
  const unknown = await observeMutationFile(cwd, '.') // A concurrent non-file replacement cannot be fingerprinted.
  assert.deepEqual(unknown, { version: null, parse: 'unknown' })
  const fact = { file: 'a', toolCallId: 'unknown', attempted: false, attemptedParse: 'unknown' as const, restoration: 'none' as const, before: unknown, after: unknown }
  attachMutationReceipts(result, [fact])
  assert.equal(result.fileStates?.[0]?.outcome, 'unknown')
  assert.equal(result.fileStates?.[0]?.version, null)
  const missing = { version: null, parse: 'missing' as const }
  attachMutationReceipts(result, [{ ...fact, before: missing, after: missing }])
  assert.equal(result.fileStates?.[0]?.outcome, 'unchanged')
  attachMutationReceipts(result, [{ ...fact, before: { version: 'known', parse: 'valid' }, after: missing, attempted: true }])
  assert.equal(result.fileStates?.[0]?.outcome, 'changed')
})

test('real write rollback refreshes observation and allows a valid retry without another read', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'receipt-restore-')), file = join(cwd, 'a.json'), source = '{"n":1}\n'
  writeFileSync(file, source)
  utimesSync(file, new Date(0), new Date(0))
  const params = { cwd, sessionId: 'receipt-owner', toolUseId: 'read', input: { file_path: file } }
  const read = await READ_FILE_TOOL.execute(params)
  assert.equal(read.fileStates?.[0]?.version, contentVersion(source))
  assert.equal(read.fileStates?.[0]?.observation, 'full')
  const failed = await WRITE_FILE_TOOL.execute({ ...params, toolUseId: 'invalid', input: { file_path: file, content: '{' } })
  assert.equal(failed.isError, true)
  assert.equal(failed.fileStates?.[0]?.outcome, 'restored')
  assert.equal(readFileSync(file, 'utf8'), source)
  assert.equal(getFileReadMtime(file, params.sessionId), statSync(file).mtimeMs)
  const retry = await WRITE_FILE_TOOL.execute({ ...params, toolUseId: 'retry', input: { file_path: file, content: '{"n":2}\n' } })
  assert.ok(!retry.isError, retry.content)
  assert.equal(retry.fileStates?.[0]?.version, contentVersion('{"n":2}\n'))
  writeFileSync(file, '{"n":9}\n')
  utimesSync(file, new Date(5000), new Date(5000))
  const conflict = await WRITE_FILE_TOOL.execute({ ...params, toolUseId: 'conflict', input: { file_path: file, content: '{"n":3}\n' } })
  assert.equal(conflict.isError, true)
  assert.equal(readFileSync(file, 'utf8'), '{"n":9}\n')
})

test('partial reads do not authorize blind replacement; batch versions and preview remain honest', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'receipt-partial-')), file = join(cwd, 'a.json'), source = '{\n"a":1,\n"b":2\n}'
  writeFileSync(file, source)
  const params = { cwd, sessionId: 'partial-owner', toolUseId: 'slice', input: { file_path: file, limit: 1 } }
  const read = await READ_FILE_TOOL.execute(params)
  assert.equal(read.fileStates?.[0]?.observation, 'partial')
  assert.equal(isFileFullyObserved(file, params.sessionId), false)
  const blind = await WRITE_FILE_TOOL.execute({ ...params, input: { file_path: file, content: '{}' } })
  assert.equal(blind.isError, true)
  const operations = [{ old_string: '"a":1', new_string: '"a":3' }]
  const missing = await EDIT_FILE_TOOL.execute({ ...params, input: { file_path: file, operations } })
  assert.equal(missing.errorReason, 'missing_expected_version')
  assert.equal(missing.mutations, undefined)
  const stale = await EDIT_FILE_TOOL.execute({ ...params, input: { file_path: file, operations, expected_version: 'old' } })
  assert.equal(stale.errorKind, 'refused')
  assert.equal(stale.errorReason, 'stale_version')
  const preview = await EDIT_FILE_TOOL.execute({ ...params, input: { file_path: file, operations, expected_version: contentVersion(source), dry_run: true } })
  assert.equal(preview.fileStates, undefined)
  assert.equal(readFileSync(file, 'utf8'), source)
  const applied = await EDIT_FILE_TOOL.execute({ ...params, input: { file_path: file, operations, expected_version: contentVersion(source) } })
  assert.equal(applied.fileStates?.[0]?.outcome, 'changed')
  assert.equal(isFileFullyObserved(file, params.sessionId), false)
})

test('editing guidance appended to a complete medium read does not make the observation partial', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'receipt-hint-')), file = join(cwd, 'medium.html')
  writeFileSync(file, `<html><body><!--${' detail '.repeat(3000)}--></body></html>`)
  const read = await READ_FILE_TOOL.execute({ cwd, sessionId: 'hint-owner', toolUseId: 'hint', input: { file_path: file }, contextWindow: 1_000_000 })
  assert.match(read.content, /Note: this file/)
  assert.equal(read.fileStates?.[0]?.observation, 'full')
  assert.equal(isFileFullyObserved(file, 'hint-owner'), true)
})

test('new append files have actual mutation/version receipts and disclose incomplete structure', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'receipt-append-')), file = join(cwd, 'draft.html')
  const first = await WRITE_FILE_TOOL.execute({ cwd, sessionId: 'append-owner', toolUseId: 'append-new', input: { file_path: file, mode: 'append', content: '<html><body><script>const p=1;' } })
  assert.ok(!first.isError, first.content)
  assert.equal(first.mutations?.[0]?.before.parse, 'missing')
  assert.equal(first.fileStates?.[0]?.parse, 'invalid')
  const version = first.fileStates?.[0]?.version
  assert.equal(version, contentVersion(readFileSync(file, 'utf8')))
  const fixed = await EDIT_FILE_TOOL.execute({ cwd, sessionId: 'append-owner', toolUseId: 'close-draft', input: { file_path: file, expected_version: version, operations: [{ old_string: 'const p=1;', new_string: 'const p=1;</script></body></html>' }] } })
  assert.ok(!fixed.isError, fixed.content)
  assert.equal(fixed.fileStates?.[0]?.parse, 'valid')
})
