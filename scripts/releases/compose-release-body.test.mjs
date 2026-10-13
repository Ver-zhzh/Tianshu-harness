#!/usr/bin/env node
// compose-release-body.test.mjs — 组合脚本单测（node --test）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { composeBody, prependPreamble, rewriteLinks, injectVersion } from './compose-release-body.mjs'

const PREAMBLE = `# 安装指南 · Installation

下载 [\`Tianshu_<版本>_aarch64.dmg\`](https://github.com/huiliyi37/Tianshu-harness/releases/latest)。

完整说明见 [安装与平台说明](../guides/installation.md)，含 [一键脚本](../guides/installation.md#方式-b一键安装脚本推荐)。

\`\`\`bash
xattr -cr /Applications/Tianshu.app
\`\`\`
`

const CHANGELOG = `# v3.30.0 发布记录

> 日期：2026-10-11

## 1. 自动更新链

- 根修存量会话死等
`

test('组合：preamble + changelog，带 --- 分隔', () => {
  const body = composeBody({ preamble: PREAMBLE, changelog: CHANGELOG, version: '3.30.0' })
  assert.ok(body.startsWith('# 安装指南'))
  assert.ok(body.includes('\n---\n\n# v3.30.0 发布记录'))
  assert.ok(body.includes('Tianshu_3.30.0_aarch64.dmg'), '版本号注入产物名')
  assert.ok(!body.includes('<版本>'), '占位符全部替换')
})

test('组合：changelog 缺省时只输出 preamble（draft 阶段）', () => {
  const body = composeBody({ preamble: PREAMBLE, version: '3.30.0' })
  assert.ok(body.includes('Tianshu_3.30.0'))
  assert.ok(!body.includes('---'))
})

test('fail-closed：preamble 为空时大声失败', () => {
  assert.throws(() => composeBody({ preamble: '   ', changelog: CHANGELOG, version: '3.30.0' }), /fail-closed|安装段落/)
})

test('链接重写：相对链接 → GitHub 绝对 URL（含锚点）', () => {
  const out = rewriteLinks(PREAMBLE, 'https://github.com/huiliyi37/Tianshu-harness')
  assert.ok(out.includes('(https://github.com/huiliyi37/Tianshu-harness/blob/main/docs/guides/installation.md)'))
  assert.ok(out.includes('(https://github.com/huiliyi37/Tianshu-harness/blob/main/docs/guides/installation.md#方式-b一键安装脚本推荐)'))
  assert.ok(!out.includes('](../'), '无残留相对链接')
})

test('链接重写：绝对 URL 与代码块内容不动', () => {
  const out = rewriteLinks('[x](https://example.com/a.md)', 'https://github.com/huiliyi37/Tianshu-harness')
  assert.equal(out, '[x](https://example.com/a.md)')
})

test('版本注入：无版本号时保留占位符（dry-run 可读）', () => {
  assert.equal(injectVersion('a <版本> b', undefined), 'a <版本> b')
  assert.equal(injectVersion('a <版本> b', '1.2.3'), 'a 1.2.3 b')
})

test('前插模式：preamble 插到现有 body 前，保留人工正文', () => {
  const existing = `# v3.30.0\n\n> 日期：2026-10-11\n\n## 本版要点\n\n- 自动更新链端到端修复\n`
  const body = prependPreamble({ preamble: PREAMBLE, existingBody: existing, version: '3.30.0' })
  assert.ok(body.startsWith('# 安装指南'))
  assert.ok(body.includes('\n---\n\n# v3.30.0'))
  assert.ok(body.includes('- 自动更新链端到端修复'), '人工正文保留')
  assert.ok(body.includes('Tianshu_3.30.0_aarch64.dmg'))
})

test('前插模式：幂等——已含安装段落的 body 原样返回', () => {
  const once = prependPreamble({ preamble: PREAMBLE, existingBody: '# v3.30.0\n\n正文\n', version: '3.30.0' })
  const twice = prependPreamble({ preamble: PREAMBLE, existingBody: once, version: '3.30.0' })
  assert.equal(twice, once)
})

test('前插模式：existingBody 为空时大声失败', () => {
  assert.throws(() => prependPreamble({ preamble: PREAMBLE, existingBody: '  ', version: '3.30.0' }), /existingBody 为空/)
})
