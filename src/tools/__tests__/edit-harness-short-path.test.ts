import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WRITE_FILE_TOOL } from '../write-file.js'
import { READ_FILE_TOOL } from '../read-file.js'
import { EDIT_FILE_TOOL } from '../edit.js'
import { checkSyntax } from '../syntax-check.js'
import { createBrowserDebugTool } from '../browser-debug/tool.js'
import { closeSession } from '../browser-debug/session.js'
import { cpuPool } from '../../workers/cpu-pool.js'
after(() => cpuPool.dispose())

test('receipt → one complete read → one atomic edit → local parse → current navigation query', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'harness-short-')), file = join(cwd, 'index.html'), sessionId = 'short-path'
  const source = '<html><body><script type="module">\nfunction tower() { return 1 }\nfunction bridge() { return 2 }\n</script></body></html>'
  const base = { cwd, sessionId, toolUseId: 'short' }
  const created = await WRITE_FILE_TOOL.execute({ ...base, input: { file_path: file, content: source } })
  assert.ok(!created.isError, created.content)
  assert.deepEqual(created.fileStates?.[0]?.addedSymbols, ['tower', 'bridge'])
  const observed = await READ_FILE_TOOL.execute({ ...base, input: { file_path: file } })
  const version = observed.fileStates?.[0]?.version
  assert.equal(version, created.fileStates?.[0]?.version)
  const edited = await EDIT_FILE_TOOL.execute({ ...base, toolUseId: 'batch', input: { file_path: file, expected_version: version, operations: [
    { old_string: 'return 1', new_string: 'return 3' }, { old_string: 'return 2', new_string: 'return 4' },
  ] } })
  assert.ok(!edited.isError, edited.content)
  assert.equal(edited.mutations?.length, 1)
  assert.equal((await checkSyntax(file, readFileSync(file, 'utf8'), { parseOnly: true })).fatal, null)
  let nav = 0
  const tool = createBrowserDebugTool({ enabled: true, userDataDir: () => join(cwd, 'profile'), driverFactory: async ({ events }) => ({
    goto: async () => { nav++; events.onConsole('error', 'historical-only', { pageId: 'p', navigationId: 'n0' }); events.onConsole('log', 'current-ready', { pageId: 'p', navigationId: 'n1' }) },
    currentDiagnosticScope: () => ({ pageId: 'p', navigationId: 'n1' }), currentUrl: () => 'http://localhost/', isAlive: () => true, close: async () => {},
  } as any) })
  try {
    await tool.execute({ ...base, input: { action: 'open', url: 'http://localhost/' } })
    const current = await tool.execute({ ...base, input: { action: 'console' } })
    assert.match(current.content, /current-ready/)
    assert.doesNotMatch(current.content, /historical-only/)
    assert.equal(nav, 1, 'queries must not navigate or re-execute')
  } finally { await closeSession(sessionId) }
})
