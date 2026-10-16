import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SemanticIndex } from '../semantic-index.js'

test('rebuild rejects a directory replaced after lstat and never embeds its outside contents', async context => {
  if (process.platform === 'win32') { context.skip('symlink privileges required'); return }
  const root = fs.mkdtempSync(join(tmpdir(), 'semantic-swap-'))
  const cwd = join(root, 'workspace'), vault = join(root, 'vault'), sub = join(cwd, 'sub')
  fs.mkdirSync(sub, { recursive: true }); fs.mkdirSync(vault)
  fs.writeFileSync(join(sub, 'notes.json'), '{"note":"local"}')
  fs.writeFileSync(join(vault, 'notes.json'), '{"outside_canary":"SYNTHETIC_OUTSIDE_CANARY"}')
  const embedded: string[] = []
  const idx = new SemanticIndex(cwd, { id: 'fixture', isAvailable: () => true, embed: async texts => { embedded.push(...texts); return texts.map(() => [1, 0]) } })
  const original = fs.lstatSync
  let swapped = false
  const mocked = context.mock.method(fs, 'lstatSync', ((...args: Parameters<typeof fs.lstatSync>) => {
    const path = args[0]
    const stat = Reflect.apply(original, fs, args)
    if (!swapped && String(path) === sub) {
      swapped = true
      fs.renameSync(sub, join(root, 'moved-sub'))
      fs.symlinkSync(vault, sub)
    }
    return stat
  }) as typeof fs.lstatSync)
  syncBuiltinESMExports()
  try {
    idx.rebuild()
    assert.equal(swapped, true)
    await idx.ensureVectors()
    assert.equal(idx.search('outside_canary').length, 0)
    assert.ok(!fs.readFileSync(join(cwd, '.rivet', 'semantic-index.json'), 'utf8').includes('SYNTHETIC_OUTSIDE_CANARY'))
    assert.ok(!embedded.some(text => text.includes('SYNTHETIC_OUTSIDE_CANARY')))
  } finally {
    mocked.mock.restore(); syncBuiltinESMExports()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('rebuild uses the guarded reader at the final read rather than reopening the walked pathname', async context => {
  if (process.platform === 'win32') { context.skip('symlink privileges required'); return }
  const root = fs.mkdtempSync(join(tmpdir(), 'semantic-final-read-'))
  const cwd = join(root, 'workspace'), vault = join(root, 'vault'), sub = join(cwd, 'sub')
  fs.mkdirSync(sub, { recursive: true }); fs.mkdirSync(vault)
  fs.writeFileSync(join(sub, 'notes.json'), '{"note":"local"}')
  fs.writeFileSync(join(vault, 'notes.json'), '{"outside_canary":"SYNTHETIC_FINAL_READ_CANARY"}')
  const idx = new SemanticIndex(cwd)
  const original = fs.readFileSync
  let swapped = false
  const mocked = context.mock.method(fs, 'readFileSync', ((...args: Parameters<typeof fs.readFileSync>) => {
    if (!swapped && String(args[0]) === join(sub, 'notes.json')) {
      swapped = true
      fs.renameSync(sub, join(root, 'moved-sub'))
      fs.symlinkSync(vault, sub)
    }
    return Reflect.apply(original, fs, args)
  }) as typeof fs.readFileSync)
  syncBuiltinESMExports()
  try {
    idx.rebuild()
    assert.equal(idx.search('outside_canary').length, 0)
    assert.ok(!fs.readFileSync(join(cwd, '.rivet', 'semantic-index.json'), 'utf8').includes('SYNTHETIC_FINAL_READ_CANARY'))
  } finally {
    mocked.mock.restore(); syncBuiltinESMExports()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('rebuild excludes hardlinked sources and cold restore drops legacy unsafe chunks', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'semantic-hardlink-'))
  const cwd = join(root, 'workspace'), vault = join(root, 'vault')
  fs.mkdirSync(cwd); fs.mkdirSync(vault)
  try {
    const target = join(vault, 'fixture.json')
    fs.writeFileSync(target, '{"outside_canary":"SYNTHETIC_HARDLINK_CANARY"}')
    fs.linkSync(target, join(cwd, 'notes.json'))
    const idx = new SemanticIndex(cwd)
    assert.equal(idx.rebuild().indexed, 0)
    const snapshot = { version: 1, fileHashes: { 'notes.json': 'legacy' }, chunkCount: 1, builtAt: 0, chunks: [{ file: 'notes.json', startLine: 1, endLine: 1, text: 'SYNTHETIC_HARDLINK_CANARY' }] }
    fs.writeFileSync(join(cwd, '.rivet', 'semantic-index.json'), JSON.stringify(snapshot))
    assert.equal(new SemanticIndex(cwd).chunkCount, 0)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
