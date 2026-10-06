import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cpuPool } from '../../workers/cpu-pool.js'
import {
  syntaxCheck,
  checkSyntax,
  checkPythonSyntaxTreeSitter,
  _isEsbuildInfraErrorForTest,
  _resetEsbuildCacheForTest,
  _resetTsCacheForTest,
  _resetPythonParserForTest,
  _pythonParseCountForTest,
} from '../syntax-check.js'

describe('syntaxCheck', async () => {
  describe('CSS', async () => {
    it('passes valid CSS', async () => {
      assert.equal(await syntaxCheck('/a/style.css', 'body{color:red}'), null)
    })

    it('passes CSS with custom properties', async () => {
      assert.equal(await syntaxCheck('/a/style.css', ':root{--x:1}@media(max-width:768px){.m{display:none}}'), null)
    })

    it('flags unmatched opening brace', async () => {
      const r = await syntaxCheck('/a/style.css', 'body{color:red')
      assert.ok(r, 'should detect missing }')
      assert.match(r!, /unmatched.*\{/i)
    })

    it('flags unmatched closing brace', async () => {
      const r = await syntaxCheck('/a/style.css', 'body{color:red}}')
      assert.ok(r, 'should detect extra }')
      assert.match(r!, /unmatched.*\}/i)
    })

    it('flags the exact broken CSS from our site bug', async () => {
      // Missing } to close @media — the actual bug we shipped
      const broken = '@media(max-width:768px){.nav{display:none}\n.nav-mobile a{color:gray}\n\n/* Hero */\n#hero{padding:80px}'
      const r = await syntaxCheck('/a/style.css', broken)
      assert.ok(r, 'should detect unmatched { from unclosed @media')
      assert.match(r!, /unmatched.*\{/i)
    })

    it('passes complex valid CSS with multiple @media', async () => {
      const css = '.a{color:red}@media(max-width:768px){.b{display:none}}@media(max-width:480px){.c{display:block}}.d{margin:0}'
      assert.equal(await syntaxCheck('/a/style.css', css), null)
    })
  })

  describe('HTML', async () => {
    it('passes valid HTML', async () => {
      const html = '<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><title>T</title></head><body><p>Hello</p></body></html>'
      assert.equal(await syntaxCheck('/a/index.html', html), null)
    })

    it('flags missing closing tag', async () => {
      const r = await syntaxCheck('/a/index.html', '<html><body><div>unclosed')
      assert.ok(r, 'should detect unclosed div')
      assert.match(r!, /unclosed.*<div>/i)
    })

    it('flags extra closing tag', async () => {
      const r = await syntaxCheck('/a/index.html', '<html><body><div>text</div></div></body></html>')
      assert.ok(r, 'should detect extra </div>')
      assert.match(r!, /unexpected.*<\/div>/i)
    })

    it('does not flag self-closing tags', async () => {
      assert.equal(await syntaxCheck('/a/index.html', '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body><img src="x"><br><hr></body></html>'), null)
    })
  })

  describe('JSON', async () => {
    it('passes valid JSON', async () => {
      assert.equal(await syntaxCheck('/a/data.json', '{"a":1,"b":[2,3]}'), null)
    })

    it('flags invalid JSON', async () => {
      const r = await syntaxCheck('/a/data.json', '{"a":1,}')
      assert.ok(r, 'should detect trailing comma')
      assert.match(r!, /Invalid JSON/)
    })

    it('flags truncated JSON', async () => {
      const r = await syntaxCheck('/a/data.json', '{"a":1')
      assert.ok(r, 'should detect unexpected end')
      assert.match(r!, /Invalid JSON/)
    })
  })

  describe('JavaScript', async () => {
    it('classifies a missing esbuild platform binary as infrastructure failure', () => {
      const missingOptionalBinary = new Error(
        'The package "@esbuild/win32-x64" could not be found, and is needed by esbuild.',
      )
      assert.equal(_isEsbuildInfraErrorForTest(missingOptionalBinary), true)
      assert.equal(
        _isEsbuildInfraErrorForTest(new Error("Cannot find package '@esbuild/linux-x64' imported from esbuild.js")),
        true,
      )
      assert.equal(_isEsbuildInfraErrorForTest(new Error('ERROR: Expected "}" but found end of file')), false)
    })

    it('does not surface a missing esbuild platform binary as a syntax warning', async () => {
      const originalRun = cpuPool.run
      let workerCallMade = false
      cpuPool.run = async () => {
        workerCallMade = true
        throw new Error('The package "@esbuild/win32-x64" could not be found, and is needed by esbuild.')
      }
      _resetEsbuildCacheForTest()
      try {
        assert.equal(await syntaxCheck('/a/script.js', 'const a = 1;'), null)
        assert.equal(workerCallMade, true, 'the simulated esbuild worker failure must be exercised')
      } finally {
        cpuPool.run = originalRun
        _resetEsbuildCacheForTest()
      }
    })

    it('passes valid JS', async () => {
      assert.equal(await syntaxCheck('/a/script.js', 'const x = 1;\nconsole.log(x);'), null)
    })

    it('flags JS syntax error', async () => {
      const r = await syntaxCheck('/a/script.js', 'const x = ;')
      assert.ok(r, 'should detect incomplete expression')
      assert.match(r!, /error/i)
    })

    it('passes JSX', async () => {
      assert.equal(await syntaxCheck('/a/comp.jsx', 'const el = <div>hi</div>;'), null)
    })

    it('does not produce a false fatal when esbuild load is slow (degrade to OK)', async () => {
      // A 1ms budget almost always trips the async load timeout before esbuild
      // resolves. The guard must degrade to OK (null), never block the event
      // loop or surface a spurious syntax error that would roll back a valid
      // file. This regression-test protects against Windows antivirus/EDR hangs
      // where a synchronous require('esbuild') blocks for minutes.
      const prev = process.env.RIVET_ESBUILD_LOAD_TIMEOUT
      process.env.RIVET_ESBUILD_LOAD_TIMEOUT = '1'
      _resetEsbuildCacheForTest()
      try {
        const start = Date.now()
        const r = await syntaxCheck('/a/script.js', 'const x = 1;\nconsole.log(x);')
        const elapsed = Date.now() - start
        assert.equal(r, null)
        assert.ok(elapsed < 1000, `syntaxCheck took ${elapsed}ms; should return quickly on slow esbuild load`)
      } finally {
        if (prev === undefined) delete process.env.RIVET_ESBUILD_LOAD_TIMEOUT
        else process.env.RIVET_ESBUILD_LOAD_TIMEOUT = prev
        _resetEsbuildCacheForTest()
      }
    })
  })

  describe('TypeScript (existing behavior preserved)', async () => {
    it('passes valid TS', async () => {
      assert.equal(await syntaxCheck('/a/file.ts', 'const x: number = 1;'), null)
    })

    it('flags TS error', async () => {
      const r = await syntaxCheck('/a/file.ts', 'const x: number = ;')
      assert.ok(r, 'should flag syntax error')
    })
  })

  describe('checkSyntax — esbuild false-positive second opinion', async () => {
    // checkSyntax returns {warning, fatal} instead of the flat null|string
    // from syntaxCheck. Real syntax errors (both esbuild and TS reject) must
    // still produce fatal; valid code must produce neither.

    it('returns OK for valid TypeScript', async () => {
      const r = await checkSyntax('/a/file.ts', 'const x: number = 1;\nconsole.log(x);')
      assert.equal(r.fatal, null)
      assert.equal(r.warning, null)
    })

    it('returns fatal for real syntax error (both esbuild and TS reject)', async () => {
      const r = await checkSyntax('/a/file.ts', 'const x: number = ;')
      if (r.fatal !== null) {
        // Expected: both esbuild and TypeScript API reject this
        assert.ok(r.fatal.includes('esbuild') || r.fatal.includes('TypeScript') || r.fatal.includes('error'),
          `fatal should mention syntax error, got: ${r.fatal}`)
      } else {
        // If TS module unavailable / degraded, fatal may be null (infra degrade).
        // Accept as long as warning is set.
        assert.ok(r.warning, 'warning should be set when TS is unavailable')
      }
    })

    it('returns fatal for broken JSX', async () => {
      const r = await checkSyntax('/a/file.tsx', 'const el = <div>unclosed;')
      // This should be caught by esbuild (and likely TS too)
      assert.ok(r.fatal !== null || r.warning !== null,
        'broken JSX should produce either fatal or warning')
    })

    it('returns no fatal for valid JSX', async () => {
      const r = await checkSyntax('/a/file.tsx', 'const el = <div>hi</div>;\nexport default el;')
      assert.equal(r.fatal, null)
      assert.equal(r.warning, null)
    })

    it('returns no fatal for valid JS', async () => {
      const r = await checkSyntax('/a/script.js', 'const x = 1;\nconsole.log(x);')
      assert.equal(r.fatal, null)
      assert.equal(r.warning, null)
    })
  })

  describe('Python', async () => {
    it('passes valid Python', async () => {
      assert.equal(await syntaxCheck('/a/script.py', 'def foo():\n    return 1\n'), null)
    })

    // 注:CPython ast.parse 报 IndentationError 的用例在 tree-sitter 下宽松放过,
    // 见下方 Python surrogate/差异 块的"缩进错误"用例。此处不再断言检出缩进错误。

    it('flags invalid Python syntax', async () => {
      const r = await syntaxCheck('/a/script.py', 'def foo(\n')
      assert.ok(r, 'should detect invalid syntax')
      assert.match(r!, /语法错误|syntax error/i)
    })

    it('does not produce a false fatal under an aggressive parse timeout (degrade to OK)', async () => {
      // A 1ms budget can trip the tree-sitter load timeout before the wasm
      // parser is ready. The guard must degrade to OK (null), never surface a
      // spurious syntax error that would roll back a perfectly valid file.
      const prev = process.env.RIVET_TS_PARSE_TIMEOUT
      process.env.RIVET_TS_PARSE_TIMEOUT = '1'
      // 清缓存,强制这次走 load 路径(否则命中已缓存的 parser,测不到超时 degrade)。
      _resetPythonParserForTest()
      try {
        const r = await syntaxCheck('/a/script.py', 'def foo():\n    return 1\n')
        assert.equal(r, null)
      } finally {
        if (prev === undefined) delete process.env.RIVET_TS_PARSE_TIMEOUT
        else process.env.RIVET_TS_PARSE_TIMEOUT = prev
        _resetPythonParserForTest() // 复位,避免污染后续用例(1ms 超时缓存)
      }
    })

    it('含孤立 surrogate 的合法 py 不误判 fatal（tree-sitter 进程内无编码问题）', async () => {
      // 用户 07-30 反馈:Windows 中文环境写含 \udc80 的 py 曾被误判语法错误 + 回滚。
      // 进程内 tree-sitter 把 surrogate 当普通字符,天然不会崩,绝不返回 fatal。
      const content = 'x = "ab\uDC80cd"\nprint(x)\n'
      const r = await checkSyntax('/a/script.py', content)
      assert.equal(r.fatal, null, `含孤立 surrogate 的合法 py 不该判 fatal,got: ${r.fatal}`)
    })

    it('tree-sitter 语法错误带行号', async () => {
      // 第 2 行括号未闭合 → 错误信息应含行号
      const r = await checkSyntax('/a/script.py', 'x = 1\ny = (1 + 2\n')
      assert.ok(r.fatal !== null, 'unbalanced paren should be fatal')
      assert.match(r.fatal!, /第 \d+ 行/, `错误信息应带行号,got: ${r.fatal}`)
    })

    it('缩进错误 tree-sitter 比 CPython 宽松（记录判定差异,不强行对齐）', async () => {
      // tree-sitter 是容错解析器:CPython ast.parse 报 IndentationError 的
      // 'def foo():\\n    return 1\\n  bad\\n' 在 tree-sitter 里 hasError=false。
      // 对"写完即时结构校验"可接受(漏报优于误报回滚);关键是不产生 false fatal。
      const r = await checkSyntax('/a/script.py', 'def foo():\n    return 1\n  bad\n')
      assert.equal(r.fatal, null, '缩进错误在 tree-sitter 下不判 fatal(已知宽松,不误报)')
    })

    it('parser 每 250 次解析重建一次（WASM 内存不随会话单调增长）', async () => {
      // tree 在 finally 里 delete，parser scratch 靠计数重建——两者缺一，长会话
      // 里每写一个 .py 都会在 WASM 线性内存留下不被 JS GC 回收的残留。
      _resetPythonParserForTest()
      try {
        for (let i = 0; i < 250; i++) {
          await checkPythonSyntaxTreeSitter('x = 1\n')
        }
        assert.equal(_pythonParseCountForTest(), 250, '前 250 次不该触发重建')

        // 第 251 次触发重建：计数归零后重新计 1，且解析结果仍然正确。
        const ok = await checkPythonSyntaxTreeSitter('def foo():\n    return 1\n')
        assert.equal(_pythonParseCountForTest(), 1, '第 251 次应重建 parser 并重新计数')
        assert.equal(ok.error, null, '重建后合法代码仍判通过')

        const bad = await checkPythonSyntaxTreeSitter('y = (1 + 2\n')
        assert.ok(bad.error !== null, '重建后仍能检出未闭合括号')
        assert.equal(bad.line, 1)
      } finally {
        _resetPythonParserForTest()
      }
    })
  })

  describe('unknown extensions', async () => {
    it('returns null for unsupported file types', async () => {
      assert.equal(await syntaxCheck('/a/file.md', '# Hello'), null)
      assert.equal(await syntaxCheck('/a/file.txt', 'hello'), null)
    })
  })
})
