import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyCommandFilter } from '../command-filters.js'

describe('applyCommandFilter', () => {
  describe('tsc filter', () => {
    it('returns summary for tsc success', () => {
      const result = applyCommandFilter('npx tsc --noEmit', 'Found 0 errors.', 0)
      assert.ok(result)
      assert.match(result, /Found 0 errors/)
    })

    it('keeps error lines for tsc failure', () => {
      const input = [
        'src/tools/foo.ts(10,5): error TS2322: Type string is not assignable to type number.',
        'src/tools/bar.ts(20,1): error TS2551: Property does not exist.',
        'Found 2 errors.',
      ].join('\n')
      const result = applyCommandFilter('npx tsc --noEmit', input, 1)
      assert.ok(result)
      assert.match(result, /error TS2322/)
      assert.match(result, /error TS2551/)
      assert.match(result, /Found 2 errors/)
    })

    it('strips non-error lines from tsc', () => {
      const input = [
        'Compiling...',
        'src/tools/foo.ts(10,5): error TS2322: Type mismatch.',
        'Found 1 error.',
      ].join('\n')
      const result = applyCommandFilter('npx tsc --noEmit', input, 1)
      assert.ok(result)
      assert.ok(!result.includes('Compiling'))
    })

    it('keeps file:line:col locations in tsc diagnostics', () => {
      const input = 'src/agent/loop.ts(1553,21): error TS2532: Object is possibly undefined.'
      const result = applyCommandFilter('npx tsc --noEmit', input, 2)
      assert.ok(result)
      assert.match(result, /src\/agent\/loop\.ts\(1553,21\): error TS2532/, '文件位置必须保留')
    })

    it('exit 0 with tsc errors in output → failure branch (pipe exit-code laundering)', () => {
      const input = 'src/tools/foo.ts(10,5): error TS2322: Type mismatch.'
      const result = applyCommandFilter('npx tsc --noEmit', input, 0)
      assert.ok(result)
      assert.ok(!result.includes('✓ typecheck passed'), '含错误输出时不得合成成功')
      assert.match(result, /error TS2322/)
    })

    it('piped commands bypass the filter entirely (exit code untrustworthy)', () => {
      const input = 'src/tools/foo.ts(10,5): error TS2322: Type mismatch.'
      const result = applyCommandFilter('node_modules/.bin/tsc --noEmit 2>&1 | head -5', input, 0)
      assert.equal(result, null, '管道命令返回 null，由调用方回退原始输出')
    })
  })

  describe('node:test filter', () => {
    it('returns summary for passing tests', () => {
      const input = '✓ test 1\n✓ test 2\n2 passed, 0 failed'
      const result = applyCommandFilter('npx tsx --test src/foo.test.ts', input, 0)
      assert.ok(result)
      assert.match(result, /passed/)
    })

    it('keeps failed test lines', () => {
      const input = [
        '✓ passing test',
        'not ok 2 - failing test',
        '  AssertionError: expected 1 to equal 2',
        '  at Object.<anonymous> (/test.ts:10:10)',
        '1 passed, 1 failed',
      ].join('\n')
      const result = applyCommandFilter('npx tsx --test src/foo.test.ts', input, 1)
      assert.ok(result)
      assert.match(result, /not ok 2/)
      assert.match(result, /AssertionError/)
      assert.ok(!result.includes('✓ passing test'))
    })

    it('exit 0 with not ok in output → failure branch', () => {
      const input = '✓ ok test\nnot ok 2 - failing test\n1 passed, 1 failed'
      const result = applyCommandFilter('npx tsx --test src/foo.test.ts', input, 0)
      assert.ok(result)
      assert.match(result, /not ok 2/, '内容含 not ok 时按失败处理')
    })
  })

  describe('git status filter', () => {
    it('removes hint lines', () => {
      const input = [
        'On branch main',
        'Changes not staged for commit:',
        '  (use "git add <file>..." to update what will be committed)',
        '  modified: src/foo.ts',
      ].join('\n')
      const result = applyCommandFilter('git status', input, 0)
      assert.ok(result)
      assert.match(result, /modified: src\/foo\.ts/)
      assert.ok(!result.includes('use "git add'))
    })
  })

  describe('no matching filter', () => {
    it('returns null for unknown commands', () => {
      const result = applyCommandFilter('npm install express', 'added 1 package', 0)
      assert.equal(result, null)
    })
  })

  describe('git log filter', () => {
    const longDefaultLog = Array.from({ length: 20 }, (_, i) => [
      `commit ${'a'.repeat(40 - String(i).length)}${i}`,
      `Author: Dev <dev@example.com>`,
      `Date:   Thu Jul 17 0${i % 10}:00:00 2026 +0800`,
      '',
      `    subject line for commit ${i}`,
      `    body detail ${i} extra`,
      '',
      `    Signed-off-by: Dev <dev@example.com>`,
    ].join('\n')).join('\n')

    it('compresses long default-format logs (drops Author/trailer, caps commits)', () => {
      const result = applyCommandFilter('git log', longDefaultLog, 0)
      assert.ok(result)
      assert.match(result, /commit a+/)
      assert.match(result, /Date:/)
      assert.match(result, /subject line for commit 0/)
      assert.ok(!result.includes('Author:'), 'Author 行应被剥除')
      assert.ok(!result.includes('Signed-off-by'), 'trailer 应被剥除')
      assert.match(result, /\[\+\d+ commits omitted\]/, '超 15 个 commit 应有 omitted 标记')
    })

    it('returns null for short logs (no value filtering)', () => {
      const short = 'commit abc123\nAuthor: A <a@b>\nDate: today\n\n    tiny'
      assert.equal(applyCommandFilter('git log', short, 0), null)
    })

    it('truncates wide lines for --oneline format', () => {
      const longLine = `x`.repeat(200)
      const input = Array.from({ length: 35 }, (_, i) => `abc${i} ${longLine}`).join('\n')
      const result = applyCommandFilter('git log --oneline', input, 0)
      assert.ok(result)
      assert.ok(!result.includes(longLine), '超宽行应被截断')
    })
  })

  describe('git diff filter', () => {
    function makeDiff(hunkLines: number): string {
      const body = Array.from({ length: hunkLines }, (_, i) =>
        i % 2 === 0 ? `+added line ${i}` : `-removed line ${i}`).join('\n')
      return [
        'diff --git a/src/foo.ts b/src/foo.ts',
        'index 1234567..89abcde 100644',
        '--- a/src/foo.ts',
        '+++ b/src/foo.ts',
        '@@ -1,3 +1,3 @@ function foo',
        body,
        '\\ No newline at end of file',
      ].join('\n')
    }

    it('strips index/mode headers and keeps hunk content with +A -R count', () => {
      const diff = `${makeDiff(30)}\ndiff --git a/src/bar.ts b/src/bar.ts\nindex 111..222 100644\n--- a/src/bar.ts\n+++ b/src/bar.ts\n@@ -5,2 +5,2 @@\n-old\n+new`
      const result = applyCommandFilter('git diff', diff, 0)
      assert.ok(result)
      assert.ok(!result.includes('index 1234567'), 'index 行应被剥除')
      assert.ok(!result.includes('No newline'), '\\ No newline 行应被剥除')
      assert.match(result, /@@ -1,3 \+1,3 @@ function foo/, 'hunk 头（含函数上下文）应保留')
      assert.match(result, /\+added line 0/)
      assert.match(result, /\+\d+ -\d+/, '每文件尾应有 +A -R 计数')
    })

    it('caps long hunks with truncation marker', () => {
      const result = applyCommandFilter('git diff', makeDiff(100), 0)
      assert.ok(result)
      assert.match(result, /\.\.\. \(\d+ lines truncated\)/, 'hunk 超 60 行应有截断标记')
    })

    it('returns null for small diffs', () => {
      const small = 'diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b'
      assert.equal(applyCommandFilter('git diff', small, 0), null)
    })

    it('git show keeps preamble lines', () => {
      const show = `commit abc123\nAuthor: A <a@b>\nDate: today\n\n    message\n\n${makeDiff(40)}`
      const result = applyCommandFilter('git show HEAD', show, 0)
      assert.ok(result)
      assert.match(result, /commit abc123/, 'show 的 commit 头应保留')
    })

    it('git log -p routes to the diff filter', () => {
      const result = applyCommandFilter('git log -p', makeDiff(50), 0)
      assert.ok(result)
      assert.match(result, /\.\.\. \(\d+ lines truncated\)|\+\d+ -\d+/)
    })
  })

  describe('test-run filter', () => {
    for (const cause of [
      'npm ERR! test runner terminated by signal SIGTERM',
      'Killed (out of memory)',
      'runner could not start: missing executable',
      'cleanup hook returned status 3',
    ]) it(`retains non-assertion failure evidence: ${cause}`, () => {
      const input = [...Array.from({ length: 20 }, (_, i) => `✔ case ${i}`),
        'ℹ pass 212', 'ℹ fail 0', 'ℹ skipped 0', 'ℹ todo 0', cause].join('\n')
      const result = applyCommandFilter('npm run test:desktop', input, 1)
      assert.ok(result)
      assert.ok(result.includes(cause), `nonzero exit must retain its diagnostic: ${result}`)
      assert.ok(result.includes('ℹ fail 0'))
      assert.ok(!result.includes('✓ 212 passed'))
    })

    it('does not present statistics as an explanation when no diagnostic was captured', () => {
      const input = [...Array.from({ length: 20 }, (_, i) => `✔ case ${i}`), 'ℹ pass 212', 'ℹ fail 0'].join('\n')
      assert.match(applyCommandFilter('npm test', input, 1)!, /未取得可解释退出原因/)
    })

    for (const command of ['node --test a.test.js', 'npx tsc --noEmit']) it(`retains unknown process diagnostics for ${command}`, () => {
      const input = ['src/a.ts(1,1): error TS2322: Type mismatch.', 'not ok 1 - failed test',
        'ℹ pass 2', 'ℹ fail 0', 'cleanup terminated by signal SIGTERM'].join('\n')
      assert.match(applyCommandFilter(command, input, 1)!, /cleanup terminated by signal SIGTERM/)
    })

    it('keeps unknown diagnostics before passing items and after a long failure block', () => {
      const input = ['runner startup diagnostic',
        ...Array.from({ length: 20 }, (_, i) => `✔ case ${i}`),
        'FAIL a.test.ts', ...Array.from({ length: 160 }, (_, i) => `failure detail ${i}`),
        'ℹ pass 212', 'ℹ fail 0', 'cleanup terminated unexpectedly'].join('\n')
      const result = applyCommandFilter('npm test', input, 1)!
      assert.ok(result.includes('runner startup diagnostic'))
      assert.ok(result.includes('cleanup terminated unexpectedly'))
      assert.ok(result.includes('ℹ fail 0'))
      assert.match(result, /omitted/)
      assert.ok(result.split('\n').length < 130)
    })

    it('vitest failure: keeps failure blocks, drops passing lines', () => {
      const input = [
        ...Array.from({ length: 12 }, (_, i) => ` ✓ src/t${i}.test.ts (3 tests) 5ms`),
        ' ✓ src/a.test.ts (3 tests) 5ms',
        ' ✓ src/b.test.ts (2 tests) 3ms',
        ' × src/c.test.ts > adds numbers',
        '   AssertionError: expected 3 to be 4',
        '   at src/c.test.ts:10:5',
        '',
        ' Test Files  1 failed | 2 passed (3)',
        '      Tests  1 failed | 6 passed (7)',
        '   Duration  1.20s',
      ].join('\n')
      const result = applyCommandFilter('npx vitest run', input, 1)
      assert.ok(result)
      assert.match(result, /× src\/c\.test\.ts > adds numbers/)
      assert.match(result, /AssertionError/)
      assert.match(result, /Tests\s+1 failed \| 6 passed/)
      assert.ok(!result.includes('✓ src/a.test.ts'), '通过项应被丢弃')
    })

    it('npm test success: strips lifecycle header, keeps summary', () => {
      const input = [
        '> tianshu-harness@2.19.4 test',
        '> tsx scripts/run-node-tests.ts',
        '',
        ...Array.from({ length: 14 }, (_, i) => `✔ test ${i} (1ms)`),
        'ℹ tests 5451',
        'ℹ pass 5451',
        'ℹ fail 0',
      ].join('\n')
      const result = applyCommandFilter('npm test', input, 0)
      assert.ok(result)
      assert.ok(!result.includes('> tianshu-harness@'), '生命周期头应被剥除')
      assert.match(result, /✓ 5451 passed/)
      assert.match(result, /ℹ tests 5451/)
      assert.ok(!result.includes('✔ test one'), '通过项细节应被丢弃')
    })

    it('exit 0 but content says fail=2 → treated as failure (content over exit code)', () => {
      const input = [
        ...Array.from({ length: 14 }, (_, i) => `✔ test ${i} (1ms)`),
        '✖ test broken (2ms)',
        'ℹ tests 5451',
        'ℹ pass 5449',
        'ℹ fail 2',
      ].join('\n')
      const result = applyCommandFilter('npm test', input, 0)
      assert.ok(result)
      assert.ok(!result.includes('✓ 5449 passed'), '内容含失败签名时不得合成成功头')
      assert.match(result, /ℹ fail 2/, '失败计数必须保留')
    })

    it('pnpm WARN lines are stripped', () => {
      const input = [
        'pnpm WARN deprecated foo@1.0.0',
        ...Array.from({ length: 14 }, (_, i) => `✔ t${i} (1ms)`),
        'ℹ tests 14',
        'ℹ pass 14',
        'ℹ fail 0',
      ].join('\n')
      const result = applyCommandFilter('pnpm test', input, 0)
      assert.ok(result)
      assert.ok(!result.includes('pnpm WARN'))
    })

    it('jest failure keeps ● block', () => {
      const input = [
        ...Array.from({ length: 10 }, (_, i) => `PASS src/t${i}.test.js`),
        'PASS src/a.test.js',
        'FAIL src/b.test.js',
        '  ● adds numbers',
        '    Expected: 4',
        '    Received: 3',
        'Tests:       1 failed, 5 passed, 6 total',
      ].join('\n')
      const result = applyCommandFilter('npx jest', input, 1)
      assert.ok(result)
      assert.match(result, /● adds numbers/)
      assert.match(result, /Expected: 4/)
      assert.ok(!result.includes('PASS src/a.test.js'))
    })

    it('returns null for short outputs', () => {
      assert.equal(applyCommandFilter('npm test', 'ℹ tests 2\nℹ pass 2', 0), null)
    })
  })
})
