import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const isolated = await mkdtemp(path.join(tmpdir(), 'tianshu-watched-eviction-'))
const sourcePath = path.join(root, 'src/server/session-manager.ts')
const testPath = path.join(root, 'src/server/__tests__/session-evict-watched-idle.test.ts')
const absolutize = (source, filename) => source.replace(/(from\s*|import\s*\()(['"])(\.[^'"]+)\2/g,
  (_match, prefix, quote, ref) => `${prefix}${quote}${path.resolve(path.dirname(filename), ref)}${quote}`)
const cases = [
  { name: 'watched-always-pinned', anchor: 'if (!s || s.agent || s.running) { i++; continue }',
    replacement: 'if (!s || s.agent || s.running || s.listeners.size > 0) { i++; continue }', assertion: '超 TTL 的被观察会话被淘汰' },
  { name: 'just-opened-evicted', anchor: 'if (id === exceptId) { i++; continue }', replacement: '', assertion: 'just opened watched history survives' },
  { name: 'external-progress-ineligible', anchor: 'const mergeEligible = existing.eventsLoaded || existing.listeners.size > 0',
    replacement: 'const mergeEligible = existing.eventsLoaded', assertion: 'evicted watched viewers receive external progress' },
  { name: 'external-progress-discarded', anchor: '(!session.eventsLoaded && session.listeners.size === 0)',
    replacement: '!session.eventsLoaded', assertion: 'evicted watched viewers receive external progress' },
  { name: 'untracked-ring-retained', anchor: '    if (!session.eventsLoaded) {\n      session.events = []\n      session.knownArtifacts.clear()\n    }',
    replacement: '', assertion: 'evicted watched viewers receive external progress' },
  { name: 'memory-only-history-dropped', anchor: 'if (watched && !replayable) { i++; continue }',
    replacement: '', assertion: 'watched history without a persistence reader' },
]
try {
  const source = await readFile(sourcePath, 'utf8'), test = await readFile(testPath, 'utf8')
  for (const defect of cases) {
    assert.ok(source.includes(defect.anchor), `${defect.name}: mutation anchor missing`)
    const sourceCopy = path.join(isolated, `${defect.name}.ts`), testCopy = path.join(isolated, `${defect.name}.test.ts`)
    await writeFile(sourceCopy, absolutize(source.replace(defect.anchor, defect.replacement), sourcePath))
    await writeFile(testCopy, absolutize(test, testPath).replaceAll(path.join(root, 'src/server/session-manager.js'), sourceCopy))
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-name-pattern', defect.assertion, testCopy],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60_000 })
    const log = result.stdout + result.stderr
    assert.notEqual(result.status, 0, `${defect.name} must fail`)
    assert.match(log, /AssertionError/, `${defect.name} must fail a behavior assertion`)
    assert.ok(log.includes(defect.assertion), log)
    console.log(`${defect.name}: restored defect is red`)
  }
} finally { await rm(isolated, { recursive: true, force: true }) }
