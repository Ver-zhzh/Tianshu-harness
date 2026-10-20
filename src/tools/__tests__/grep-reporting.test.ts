import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GREP_TOOL, resetRgResolvedPath } from '../grep.js'
import { grepOutputStats } from '../../utils/grep-output.js'

for (const directory of [false, true]) {
  test(`native grep reports capped ${directory ? 'directory' : 'file'} results as partial`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'grep-reporting-'))
    const override = process.env.RIVET_RIPGREP_PATH
    try {
      process.env.RIVET_RIPGREP_PATH = join(cwd, 'missing-rg')
      resetRgResolvedPath()
      mkdirSync(join(cwd, 'src'))
      writeFileSync(join(cwd, 'src/a.txt'), 'NEEDLE one\nNEEDLE two\nNEEDLE three\n')
      const result = await GREP_TOOL.execute({ cwd, toolUseId: 'native-report', input: {
        pattern: 'NEEDLE', path: directory ? 'src' : 'src/a.txt', literal: true, max_results: 1,
      } })
      assert.notEqual(result.isError, true)
      assert.match(result.content, /慢速回退/)
      assert.match(result.content, /\[truncated: showing 1 matches[^\r\n]*\]/)
      assert.equal(result.content.split('\n').filter(line => line.includes('NEEDLE')).length, 1)
      const complete = await GREP_TOOL.execute({ cwd, toolUseId: 'native-complete', input: {
        pattern: 'NEEDLE', path: directory ? 'src' : 'src/a.txt', literal: true,
      } })
      assert.equal(grepOutputStats(complete.content).matches, 3)
      assert.doesNotMatch(complete.content, /\[truncated:/)
    } finally {
      if (override === undefined) delete process.env.RIVET_RIPGREP_PATH
      else process.env.RIVET_RIPGREP_PATH = override
      resetRgResolvedPath()
      rmSync(cwd, { recursive: true, force: true })
    }
  })
}

test('ripgrep truncation counts witnessed matches without counting context lines', async t => {
  const binary = process.env.RIVET_RIPGREP_PATH || 'rg'
  if (spawnSync(binary, ['--version'], { stdio: 'ignore' }).status !== 0) return t.skip('ripgrep is unavailable')
  const cwd = mkdtempSync(join(tmpdir(), 'grep-reporting-'))
  const override = process.env.RIVET_RIPGREP_PATH
  try {
    // 守卫已验证 binary 可执行——把它钉成显式覆盖，让工具跳过候选探活。
    // 否则工具的首次 execFile('rg', ['--version'], {timeout:5000}) 在冷启动/
    // 隔离快照里可能失败并被缓存成 null，把本用例拖进慢速回退分支
    // （2026-10-20 隔离快照实测复现：首次探测失败、reset 后重探成功）。
    process.env.RIVET_RIPGREP_PATH = binary
    resetRgResolvedPath()
    writeFileSync(join(cwd, 'context.txt'), 'before one\nbefore two\nNEEDLE first\nafter one\nafter two\ngap\nNEEDLE second\n')
    const result = await GREP_TOOL.execute({ cwd, toolUseId: 'context-report', input: {
      pattern: 'NEEDLE', path: 'context.txt', literal: true, context_lines: 2, max_results: 3,
    } })
    assert.notEqual(result.isError, true)
    assert.doesNotMatch(result.content, /慢速回退/)
    assert.equal(result.content.split('\n').filter(line => /^\d+:NEEDLE/.test(line)).length, 1)
    assert.match(result.content, /\[truncated: showing 1 matches[^\r\n]*\]/)
  } finally {
    if (override === undefined) delete process.env.RIVET_RIPGREP_PATH
    else process.env.RIVET_RIPGREP_PATH = override
    resetRgResolvedPath()
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('grep recounts visible matches after the model character budget clips the result', async t => {
  const binary = process.env.RIVET_RIPGREP_PATH || 'rg'
  if (spawnSync(binary, ['--version'], { stdio: 'ignore' }).status !== 0) return t.skip('ripgrep is unavailable')
  const cwd = mkdtempSync(join(tmpdir(), 'grep-reporting-'))
  const override = process.env.RIVET_RIPGREP_PATH
  try {
    // 同上报废探测链不确定性：守卫验证过的 binary 直接钉成覆盖路径。
    process.env.RIVET_RIPGREP_PATH = binary
    resetRgResolvedPath()
    writeFileSync(join(cwd, 'many.txt'), Array.from({ length: 50 }, (_, i) => `NEEDLE ${i} ${'x'.repeat(40)}`).join('\n') + '\n')
    for (const maxResults of [30, 100]) {
      const result = await GREP_TOOL.execute({ cwd, toolUseId: 'character-report',
        readCapOverride: { maxChars: 800, headChars: 300, tailChars: 300 },
        input: { pattern: 'NEEDLE', path: 'many.txt', literal: true, max_results: maxResults },
      })
      const visible = grepOutputStats(result.content).matches
      assert.ok(visible > 0 && visible < maxResults)
      assert.match(result.content, new RegExp(`\\[truncated: showing ${visible} matches[^\\r\\n]*\\]`))
    }
  } finally {
    if (override === undefined) delete process.env.RIVET_RIPGREP_PATH
    else process.env.RIVET_RIPGREP_PATH = override
    resetRgResolvedPath()
    rmSync(cwd, { recursive: true, force: true })
  }
})
