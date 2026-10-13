import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const isolated = await mkdtemp(path.join(tmpdir(), 'tianshu-ledger-defects-'))
const absolutize = (source, filename) => source.replace(/(from\s*|import\s*\()(['"])(\.[^'"]+)\2/g,
  (_match, prefix, quote, ref) => `${prefix}${quote}${path.resolve(path.dirname(filename), ref)}${quote}`)
const cases = [
  { name: 'provider-pool-credentials', source: 'src/config/config-display.ts', test: 'src/token-ledger/__tests__/settings.test.ts',
    binding: 'src/config/manager.js', anchor: '    for (const key of provider.keys ?? []) key.apiKey = maskKey(key.apiKey)', replacement: '',
    assertion: 'config show masks every key in provider pools' },
  { name: 'receipt-required', source: 'src/token-ledger/forum-sync.ts', test: 'src/token-ledger/__tests__/forum-sync.test.ts',
    anchor: 'if (res.status >= 200 && res.status < 300) {', replacement: 'if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status }; if (false) {',
    assertion: 'HTML / empty / rejected JSON cannot confirm usage' },
  { name: 'redirect-credential-protection', source: 'src/token-ledger/forum-sync.ts', test: 'src/token-ledger/__tests__/forum-sync.test.ts',
    anchor: "        redirect: 'error',", replacement: '', assertion: 'does not follow redirects' },
  { name: 'attempt-dedupe', source: 'src/token-ledger/store.ts', test: 'src/token-ledger/__tests__/store.test.ts',
    anchor: '            if (seen.has(dedupeKey)) continue', replacement: '', assertion: 'attempt跨refresh与restart去重' },
  { name: 'upload-opt-in', source: 'src/token-ledger/service.ts', test: 'src/token-ledger/__tests__/service.test.ts',
    anchor: 'const shouldUpload = this.timer !== undefined', replacement: 'const shouldUpload = true', assertion: 'shutdown without upload opt-in' },
]
try {
  for (const defect of cases) {
    const sourcePath = path.join(root, defect.source), testPath = path.join(root, defect.test)
    const source = await readFile(sourcePath, 'utf8'), test = await readFile(testPath, 'utf8')
    assert.ok(source.includes(defect.anchor), `${defect.name}: mutation anchor missing`)
    const sourceCopy = path.join(isolated, `${defect.name}.ts`), testCopy = path.join(isolated, `${defect.name}.test.ts`)
    await writeFile(sourceCopy, absolutize(source.replace(defect.anchor, defect.replacement), sourcePath))
    const binding = path.join(root, defect.binding ?? defect.source.replace(/\.ts$/, '.js'))
    await writeFile(testCopy, absolutize(test, testPath).replaceAll(binding, sourceCopy))
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-name-pattern', defect.assertion, testCopy],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60_000 })
    const log = result.stdout + result.stderr
    assert.notEqual(result.status, 0, `${defect.name} must fail`)
    assert.match(log, /AssertionError/, `${defect.name} must fail behavior rather than imports`)
    assert.ok(log.includes(defect.assertion), log)
    console.log(`${defect.name}: restored defect is red`)
  }
} finally { await rm(isolated, { recursive: true, force: true }) }
