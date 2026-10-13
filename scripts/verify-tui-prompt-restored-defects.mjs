import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const isolated = await mkdtemp(path.join(tmpdir(), 'tianshu-prompt-defects-'))
const modules = ['src/tui/engine/app.ts', 'src/tui/engine/input-line.ts', 'src/tui/engine/input-layout.ts', 'src/tui/format/pinned-prompt.ts', 'src/tui/engine/__tests__/_harness.ts']
const cases = [
  ['software-marker-displacement', 1, 'const softwareCursor = options.softwareCursor ?? false', 'const softwareCursor = options.softwareCursor ?? true', 'src/tui/__tests__/engine-input-line.test.ts', 'zero-displacement'],
  ['caret-before-wrap', 2, '    if (!softwareCursor && currentWidth > 0 && currentWidth + chWidth > maxContentWidth) flush()', '', 'src/tui/__tests__/engine-input-line.test.ts', 'hardware caret follows'],
  ['queued-ghost-bubble', 0, "        this.steerBuffer.push(trimmed, 'later', false, images)", "        await this.awaitUserCommit(trimmed, images)\n        this.steerBuffer.push(trimmed, 'later', false, images)", 'src/tui/engine/__tests__/steer-queue-confirm.test.ts', '多条排队 FIFO'],
  ['steer-duplicate-bubble', 0, '    try {\n      if (!entry.bubbleCommitted) {', '    try {\n      if (true) {', 'src/tui/engine/__tests__/steer-explicit-lane.test.ts', '在纯文本'],
  ['duplicate-image-owner', 0, '        this.steerBuffer.pushNow(trimmed, true, images)', '        this.steerBuffer.pushNow(trimmed, true, images)\n        if (images) this.deferredImages.push(...images)', 'src/tui/engine/__tests__/app-busy-attachments.test.ts', 'explicit steer images have one owner'],
  ['workflow-image-theft', 0, '    // 带图提交是异步原子单元', '    for (const entry of this.steerBuffer.getPendingEntries()) { images = [...(images ?? []), ...(entry.images ?? [])]; entry.images = undefined }\n    // 带图提交是异步原子单元', 'src/tui/engine/__tests__/app-busy-attachments.test.ts', 'workflow cannot steal images'],
  ['failed-queue-lost', 0, '      entry.images = outgoingImages\n      this.steerBuffer.restoreEntry(entry)\n      this.rejectSubmit()', '      this.rejectSubmit()', 'src/tui/engine/__tests__/app-busy-attachments.test.ts', 'failed queued submission preserves'],
  ['manual-steer-duplicate', 0, 'await this.awaitUserCommit(commitText.trim(), outgoingCommitImages', 'await this.awaitUserCommit(submitText.trim(), outgoingCommitImages', 'src/tui/engine/__tests__/steer-explicit-lane.test.ts', 'manual merge keeps'],
  ['invisible-hardware-caret', 0, 'hardwareCursorVisible: true', 'hardwareCursorVisible: false', 'src/tui/format/__tests__/pinned-prompt.test.ts', 'hardware cursor is visible'],
  ['empty-double-cursor', 0, "${color('❯', arrowColor, { bold: true })} ${color(this.inputLine.placeholder, this.theme.dim)}", "${color('❯', arrowColor, { bold: true })} ${color('█', this.theme.primary)}${color(this.inputLine.placeholder, this.theme.dim)}", 'src/tui/format/__tests__/pinned-prompt.test.ts', 'hardware cursor is visible'],
  ['pinned-terminal-control', 3, "stripVTControlCharacters(boundedPrompt).replace(/[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]/g, '')", 'boundedPrompt', 'src/tui/format/__tests__/pinned-prompt.test.ts', 'pinned summary cannot inject'],
]
const absolutize = (source, file) => source.replace(/(from\s*|import\s*\()(['"])(\.[^'"]+)\2/g,
  (_match, prefix, quote, ref) => `${prefix}${quote}${path.resolve(path.dirname(file), ref)}${quote}`)
try {
  await symlink(path.join(root, 'node_modules'), path.join(isolated, 'node_modules'), 'dir')
  await writeFile(path.join(isolated, 'package.json'), '{"type":"module"}')
  const sources = await Promise.all(modules.map(file => readFile(path.join(root, file), 'utf8')))
  const copies = modules.map((_, index) => path.join(isolated, `module-${index}.ts`))
  const redirects = source => modules.reduce((result, file, index) => result.replaceAll(path.join(root, file.replace(/\.ts$/, '.js')), copies[index]), source)
  for (const [name, index, anchor, replacement, test, pattern] of cases) {
    assert.ok(sources[index].includes(anchor), `${name}: mutation anchor missing`)
    for (let i = 0; i < modules.length; i++) {
      const source = i === index ? sources[i].replace(anchor, replacement) : sources[i]
      await writeFile(copies[i], redirects(absolutize(source, path.join(root, modules[i]))))
    }
    const testCopy = path.join(isolated, 'defect.test.ts')
    await writeFile(testCopy, redirects(absolutize(await readFile(path.join(root, test), 'utf8'), path.join(root, test))))
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-name-pattern', pattern, testCopy],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60_000 })
    const log = result.stdout + result.stderr
    assert.notEqual(result.status, 0, `${name} must fail`)
    assert.match(log, /AssertionError/, `${name} must fail behavior rather than imports; ${log}`)
    console.log(`${name}: restored defect is red`)
  }
} finally { await rm(isolated, { recursive: true, force: true }) }
