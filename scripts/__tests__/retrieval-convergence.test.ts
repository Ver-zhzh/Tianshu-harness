import { test, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, mkdirSync, truncateSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'rivet-retrieval-test-'))
const prior = { RIVET_HOME: process.env.RIVET_HOME, RIVET_SESSION_DIR: process.env.RIVET_SESSION_DIR }
process.env.RIVET_HOME = home; process.env.RIVET_SESSION_DIR = join(home, 'sessions'); writeFileSync(join(home, 'config.json'), '{}')
const { PromptEngine } = await import('../../src/prompt/engine.js')
const { retrievalRequest, CURRENT_CALIBRATION, RETRIEVAL_CALIBRATION, retrievalOrder, capacityQualified } = await import('../experiments/retrieval-policy.js')
const { RetrievalSearch, readProjectionFile, hasSearchTruncationMarker } = await import('../experiments/retrieval-search.js')
const { ReadonlyAliasWorld, retrievalTask } = await import('../experiments/retrieval-tasks.js')
after(() => { for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }; rmSync(home, { recursive: true, force: true }) })

test('three arms change only initial calibration; the real renderer and production prompt remain immutable', () => {
  const engine = new PromptEngine({ model: 'deepseek-flash', maxTokens: 256000, staticCtx: { tools: [], modelFamily: 'deepseek' }, volatileCtx: { cwd: home } })
  const built = engine.buildOaiRequest([{ role: 'user', origin: 'human', content: 'fixture' }]), before = JSON.stringify(built.messages)
  const a = retrievalRequest(built, 'A'), b = retrievalRequest(built, 'B'), c = retrievalRequest(built, 'C')
  assert.equal(JSON.stringify(a.messages), before)
  assert.ok(String(a.messages[0]!.content).endsWith(CURRENT_CALIBRATION))
  assert.equal(a.messages[0]!.content, b.messages[0]!.content + CURRENT_CALIBRATION)
  assert.equal(c.messages[0]!.content, b.messages[0]!.content + '\n\n' + RETRIEVAL_CALIBRATION)
  assert.deepEqual(c.messages.slice(1), a.messages.slice(1)); assert.deepEqual(b.tools, a.tools)
  assert.equal(JSON.stringify(built.messages), before); assert.equal(engine.getExecutionSnapshot(), undefined)
  assert.throws(() => retrievalRequest({ ...built, messages: [{ role: 'system', content: 'changed calibration' }] }, 'B'), /anchor changed/)
})
test('registered order is balanced and capacity failure cannot start the ablation', () => {
  for (const n of [1, 3]) {
    const order = retrievalOrder(n)
    assert.equal(order.length, n * 9)
    for (const task of ['readonly-alias', 'synthetic', 'scoped-hook']) for (const arm of ['A', 'B', 'C']) assert.equal(order.filter(r => r.task === task && r.arm === arm).length, n)
  }
  const ok = { status: 'final', budget: { uncertain: false }, adapterFaults: 0 }
  assert.equal(capacityQualified([ok, ok]), true)
  for (const broken of [{ ...ok, status: 'provider-protocol-error' }, { ...ok, budget: { uncertain: true } }, { ...ok, adapterFaults: 1 }]) assert.equal(capacityQualified([ok, broken]), false)
  assert.equal(capacityQualified([ok]), false)
})
test('real grep handles anchors, zero matches and truncation without reading private or temp files', async () => {
  const world = new ReadonlyAliasWorld(), search = new RetrievalSearch(world)
  try {
    await search.initialize()
    assert.ok(search.definitions().some(d => d.name === 'grep'))
    const qualification = await search.qualify()
    assert.equal(qualification.passed, true, JSON.stringify(qualification))
    assert.equal(hasSearchTruncationMarker(qualification.known.content), true)
    assert.equal(search.metrics[1]!.completeness, 'partial-or-reference')
    const found = await search.execute('grep', { pattern: 'TASK_IDLE_MS', path: 'src/config.mjs', context_lines: 1, literal: true })
    assert.match(found.content, /Number\(env.TASK_IDLE_MS\)/)
    assert.doesNotMatch(found.content, /long-grader|search-[A-Za-z0-9]+/)
    symlinkSync(world.privateRoot, join(world.root, 'src/escape'))
    const root = await search.execute('grep', { pattern: 'PRIVATE_SEARCH_CANARY', path: 'src' })
    assert.doesNotMatch(root.content, /PRIVATE_SEARCH_CANARY_7f04b2/)
    const escaped = await search.execute('grep', { pattern: '.', path: 'src/escape' })
    assert.equal(escaped.isError, true)
    const readonly = await search.execute('write_file', { file_path: 'src/config.mjs', content: 'changed' })
    assert.equal(readonly.isError, true)
    const newFile = await search.execute('write_file', { file_path: 'src/new-file.mjs', content: 'export const added=true' })
    assert.equal(newFile.isError, true, 'readonly capability must forbid new files, independently of overwrite guards')
  } finally { world.close() }
})
test('narrow search excludes unrelated oversized inputs but broad search rejects incomplete projections', async () => {
  const world = new ReadonlyAliasWorld(), search = new RetrievalSearch(world)
  try {
    await search.initialize()
    world.capabilities.readable.push('.build'); world.capabilities.generated.push('.build')
    mkdirSync(join(world.root, '.build'))
    const large = join(world.root, '.build/unrelated.dat')
    writeFileSync(large, ''); truncateSync(large, 33 * 1024 * 1024)
    for (const path of ['src/config.mjs', 'src']) {
      const result = await search.execute('grep', { path, pattern: 'TASK_IDLE_MS', literal: true })
      assert.notEqual(result.isError, true, result.content)
      assert.match(result.content, /Number\(env.TASK_IDLE_MS\)/)
      assert.deepEqual(Object.keys(search.metrics.at(-1)!.fileVersions).filter(p => p.startsWith('.build/')), [])
    }
    const broad = await search.execute('grep', { pattern: 'TASK_IDLE_MS', literal: true })
    assert.equal(broad.isError, true)
    assert.equal(broad.observation.code, 'search_projection_limit')
    assert.match(broad.observation.nextAction, /Narrow path/)
    assert.equal(search.metrics.at(-1)!.completeness, 'rejected-or-error')
  } finally { world.close() }
})
test('projection reader rejects oversized inputs before content IO and bounds growth after stat', () => {
  const root = mkdtempSync(join(home, 'projection-')), path = join(root, 'large.dat')
  writeFileSync(path, ''); truncateSync(path, 33 * 1024 * 1024)
  const originalRead = fs.readSync, originalWholeRead = fs.readFileSync, originalStat = fs.fstatSync
  let reads = 0, wholeReads = 0, bytesRead = 0
  const read = mock.method(fs, 'readSync', (...args: any[]) => { reads++; const n = (originalRead as any)(...args); bytesRead += n; return n })
  const whole = mock.method(fs, 'readFileSync', (...args: any[]) => { wholeReads++; return (originalWholeRead as any)(...args) })
  syncBuiltinESMExports()
  let stat: ReturnType<typeof mock.method> | undefined
  try {
    assert.throws(() => readProjectionFile(path, 32 * 1024 * 1024), /selected search scope exceeds/)
    assert.equal(reads, 0, 'oversized files must be rejected before bounded reads')
    assert.equal(wholeReads, 0, 'oversized files must never enter a whole-file read')
    writeFileSync(path, '12345678')
    stat = mock.method(fs, 'fstatSync', (...args: any[]) => { const before = (originalStat as any)(...args); truncateSync(path, 1024 * 1024); return before })
    syncBuiltinESMExports()
    assert.throws(() => readProjectionFile(path, 32), /selected search scope exceeds/)
    assert.equal(bytesRead, 33, 'growth is detected with at most one byte beyond the remaining budget')
  } finally { stat?.mock.restore(); read.mock.restore(); whole.mock.restore(); syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }) }
  assert.equal(hasSearchTruncationMarker('1:const label="截断"'), false)
  assert.equal(hasSearchTruncationMarker('[truncated: showing 1 matches — result was cut short, use max_results to see more]'), true)
  assert.equal(hasSearchTruncationMarker('...（已截断）'), true)
})
test('single-file evidence binding survives unrelated edits and invalidates changed source', async () => {
  const { world } = retrievalTask('synthetic'), search = new RetrievalSearch(world)
  try {
    await search.initialize()
    const args = { file_path: 'src/service.mjs', offset: 1, limit: 1 }
    await search.execute('read_file', args); await search.execute('read_file', args)
    writeFileSync(join(world.root, 'src/unrelated.mjs'), 'export const unrelated=true')
    await search.execute('read_file', args)
    const previous = search.metrics.at(-1)!
    assert.ok(previous.duplicateVisibleBytes > 0, JSON.stringify(search.metrics))
    writeFileSync(join(world.root, 'src/service.mjs'), 'export const changed=true')
    await search.execute('read_file', args)
    assert.notDeepEqual(search.metrics.at(-1)!.fileVersions, previous.fileVersions)
    assert.equal(search.metrics.at(-1)!.duplicateVisibleBytes, 0)
  } finally { world.close() }
})
test('grep observations reach the actual editor consumer without a forced read_file', async () => {
  const { world } = retrievalTask('synthetic'), search = new RetrievalSearch(world)
  const { getFileReadMtime } = await import('../../src/tools/read-file.js')
  try {
    await search.initialize()
    const path = join(world.root, 'src/state.mjs')
    assert.equal(getFileReadMtime(path, 'long-pilot'), null)
    const found = await search.execute('grep', { pattern: 'export function reduce', path: 'src/state.mjs', context_lines: 1 })
    assert.notEqual(found.isError, true)
    assert.notEqual(getFileReadMtime(path, 'long-pilot'), null, 'a projection hit must register the actual workspace path in the editor session')
    const journal = join(world.root, 'src/journal.mjs')
    assert.equal(getFileReadMtime(journal, 'long-pilot'), null, 'unseen files must not be marked observed')
    await search.execute('grep', { pattern: 'export class Journal', path: 'src', context_lines: 1 })
    assert.notEqual(getFileReadMtime(journal, 'long-pilot'), null, 'directory hits must map to the real file too')
    const write = await search.execute('write_file', { file_path: 'src/state.mjs', content: readFileSync(path, 'utf8') + '\n// retained source\n' })
    assert.notEqual(write.isError, true, write.content)
  } finally { world.close() }
})
test('end-to-end directory grep paths feed real read, edit, check and independent grading', { skip: process.platform !== 'darwin' }, async () => {
  const { world } = retrievalTask('synthetic'), search = new RetrievalSearch(world)
  try {
    await search.initialize()
    const hit = await search.execute('grep', { pattern: 'export function reduce', path: 'src', context_lines: 0 })
    assert.notEqual(hit.isError, true)
    const renderedPath = hit.content.split('\n').map((line: string) => line.match(/^(.+?):\d+:/)?.[1]).find(Boolean)
    assert.ok(renderedPath, hit.content)
    const read = await search.execute('read_file', { file_path: renderedPath })
    assert.notEqual(read.isError, true, read.content)
    const section = await search.execute('read_section', { file_path: renderedPath, section: 'L1-L2' })
    assert.notEqual(section.isError, true); assert.match(section.content, /export function reduce/)
    assert.equal((await search.execute('read_section', { file_path: '../outside.txt', section: 'L1-L2' })).isError, true)
    writeFileSync(join(world.root, '.tmp/undeclared.txt'), 'not a declared input')
    assert.equal((await search.execute('read_section', { file_path: '.tmp/undeclared.txt', section: 'L1-L2' })).isError, true, 'in-workspace undeclared files must also be refused')
    const edit = await search.execute('edit_file', { file_path: renderedPath, old_string: 'export function reduce(state,event)', new_string: 'export function reduce(state, event)' })
    assert.notEqual(edit.isError, true, edit.content)
    const checks = await search.execute('run_checks', {})
    assert.equal(checks.check.complete, true)
    assert.equal(checks.check.passed, false, 'a formatting edit must not hide the real reproduction')
    assert.equal((await world.grade()).passed, false)
    assert.match((await search.execute('grep', { pattern: 'export function reduce', path: 'src' })).content, /state, event/)
  } finally { world.close() }
})
test('readonly diagnosis is graded by values, scoped attribution and actual unchanged bytes', async () => {
  const world = new ReadonlyAliasWorld()
  const answer = JSON.stringify({ actualMs: 250, zeroDisables: false, implementationFiles: ['src/config.mjs', 'src/client.mjs'], environmentBlocked: false, explanation: 'zero falls through the default' })
  try {
    assert.equal(world.gradeReport(answer).passed, true)
    assert.equal(world.gradeReport(answer.replace('250', '0')).passed, false)
    assert.equal(world.gradeReport(answer.replace('"environmentBlocked":false', '"environmentBlocked":true')).passed, false)
    assert.equal(world.gradeReport(answer.replace('"src/config.mjs","src/client.mjs"', '"src/public.mjs","src/client.mjs"')).passed, false)
    assert.equal(world.gradeReport(answer.replace('["src/config.mjs","src/client.mjs"]', '17')).passed, false)
    assert.equal(world.gradeReport('not a report').passed, false)
    writeFileSync(join(world.root, 'src/config.mjs'), 'changed')
    assert.equal(world.gradeReport(answer).passed, false)
  } finally { world.close() }
})
test('preflight observations never count as evidence seen by the model session', async () => {
  const { world } = retrievalTask('synthetic'), search = new RetrievalSearch(world)
  const { getFileReadMtime } = await import('../../src/tools/read-file.js')
  try {
    await search.initialize(); assert.equal((await search.qualify()).passed, true)
    for (const p of world.files()) assert.equal(getFileReadMtime(join(world.root, p), 'long-pilot'), null, p + ' preflight must not pre-authorize model edits')
  } finally { world.close() }
})
test('readonly public observation driver has real resolvable imports and runs in the sandbox', { skip: process.platform !== 'darwin' }, async () => {
  const world = new ReadonlyAliasWorld()
  try {
    const driver = await world.process(['scripts/api-driver.mjs'])
    assert.equal(driver.exit, 0, driver.output); assert.match(driver.output, /"idleMs":250/)
    const checks = await world.checks(); assert.equal(checks.passed, true); assert.equal(checks.complete, true)
  } finally { world.close() }
})
