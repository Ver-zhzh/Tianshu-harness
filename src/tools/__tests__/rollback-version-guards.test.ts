import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WRITE_FILE_TOOL } from '../write-file.js'
import { EDIT_FILE_TOOL } from '../edit.js'
import { trackFileChange, releaseFileChange, restoreFileChange } from '../../agent/recovery-stack.js'
import { contentVersion } from '../../agent/file-version.js'

for (const tool of [WRITE_FILE_TOOL, EDIT_FILE_TOOL]) test(`${tool.definition.name} automatic syntax rollback does not overwrite a later client version`, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rollback-consumer-')), path = join(cwd, 'a.json')
  const previous = process.env.RIVET_WRITE_OVERWRITE_GUARD
  process.env.RIVET_WRITE_OVERWRITE_GUARD = '0'
  try {
    writeFileSync(path, '{"a":1}\n')
    const result = await tool.execute({ cwd, toolUseId: 'guard', sessionId: 'owner', hasWriteClaim: () => true,
      input: tool === WRITE_FILE_TOOL ? { file_path: path, content: '{broken' } : { file_path: path, old_string: '1', new_string: '{' },
      onClientDelegate: async () => { writeFileSync(path, '{"peer":2}\n'); return { content: 'applied then concurrently updated', status: 'ok' } },
    })
    assert.equal(result.isError, true, result.content)
    assert.equal(readFileSync(path, 'utf8'), '{"peer":2}\n')
    assert.match(result.content, /回滚失败/)
  } finally { if (previous === undefined) delete process.env.RIVET_WRITE_OVERWRITE_GUARD; else process.env.RIVET_WRITE_OVERWRITE_GUARD = previous; rmSync(cwd, { recursive: true, force: true }) }
})
test('exact capture restoration requires the expected current version and current ownership', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'restore-guard-')), path = join(cwd, 'a.json')
  const capture = await trackFileChange(cwd, { filePath: 'a.json', action: 'write', toolCallId: 'guard' })
  try {
    writeFileSync(path, '{"peer":true}')
    assert.equal(await restoreFileChange(cwd, capture, 'owner', { expectedCurrentVersion: contentVersion('different') }), false)
    assert.equal(await restoreFileChange(cwd, capture, 'owner', { expectedCurrentVersion: contentVersion('{"peer":true}'), canRestore: () => false }), false)
    assert.equal(readFileSync(path, 'utf8'), '{"peer":true}')
  } finally { releaseFileChange(capture); rmSync(cwd, { recursive: true, force: true }) }
})
