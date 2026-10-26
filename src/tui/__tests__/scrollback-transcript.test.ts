import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseScrollbackTranscript,
  searchTranscript,
  findNextMatch,
  findPrevMatch,
} from '../scrollback-transcript.js'

const ANSI_USER = '\x1B[36m\u258C\x1B[0m'
const ANSI_TOOL = '\x1B[2m\u25CF\x1B[0m'

function makeContent(): string {
  return [
    `${ANSI_USER} hello world`,
    '  second line of user msg',
    '',
    'This is assistant text.',
    'Another assistant line.',
    '',
    `${ANSI_TOOL} Run(npm test)`,
    '⎿  output line 1',
    '⎿  output line 2',
    '⎿  … +5 lines [Ctrl+O]',
    '',
    `${ANSI_USER} follow up`,
  ].join('\n')
}

describe('scrollback transcript parser', () => {
  it('parses user, assistant, and tool messages', () => {
    const messages = parseScrollbackTranscript(makeContent())
    // Note: assistant text without explicit markers merges into preceding user block.
    assert.equal(messages.length, 3)
    assert.equal(messages[0]!.role, 'user')
    assert.equal(messages[0]!.summary.includes('hello world'), true)
    assert.equal(messages[0]!.rawContent.includes('assistant text'), true)
    assert.equal(messages[1]!.role, 'tool')
    assert.equal(messages[2]!.role, 'user')
  })

  it('detects truncated tool output', () => {
    const messages = parseScrollbackTranscript(makeContent())
    const toolMsg = messages.find(m => m.role === 'tool')
    assert.ok(toolMsg)
    assert.equal(toolMsg!.isTruncated, true)
  })

  // 上面的 makeContent 用的是历史英文标记（`… +5 lines [Ctrl+O]`）——`/resume`
  // 载入的旧会话 scrollback 就长这样，识别不了会让旧会话的展开入口静默失效。
  // 这里补当前中文标记，两种形态都必须认。
  it('detects truncation with the current 中文 marker', () => {
    const content = [
      `${ANSI_TOOL} Run(npm test)`,
      '⎿  output line 1',
      '⎿  … +5 行 · ctrl+o 展开',
    ].join('\n')
    const toolMsg = parseScrollbackTranscript(content).find(m => m.role === 'tool')
    assert.ok(toolMsg)
    assert.equal(toolMsg!.isTruncated, true)
  })

  // 生产端的真实形态都要认：带空格的单位（行 diff）、无省略号的裸提示
  // （diff 摘要自带规模描述）。漏一种，pager 的展开徽标就静默消失。
  it('detects every marker shape the renderers actually emit', () => {
    for (const marker of [
      '… +25 行 · ctrl+o 展开',
      '… +12 行 diff · ctrl+o 展开',
      '… +2 个文件 ctrl+o 展开',
      '… +2 条命令 · ctrl+o 展开',
      'ctrl+o 展开完整 diff',
      '… +5 lines [Ctrl+O]',
      '… [Ctrl+O]',
      '… · /pager',
    ]) {
      const content = [`${ANSI_TOOL} Run(npm test)`, '⎿  line', `⎿  ${marker}`].join('\n')
      const toolMsg = parseScrollbackTranscript(content).find(m => m.role === 'tool')
      assert.equal(toolMsg!.isTruncated, true, `形态未识别：${marker}`)
    }
  })

  // 已结算的工具卡 bullet 是 › / ✗，不是 live 卡的 ●。解析端只认 ● 时，
  // 整段工具输出会被并进上一条 assistant 块，pager 里点不到它。
  it('detects settled tool bullets (› / ✗), not just the live ●', () => {
    for (const bullet of ['\u203A', '\u2717']) {
      const content = [`\x1B[32m${bullet}\x1B[0m Run(npm test)`, '⎿  ok'].join('\n')
      const messages = parseScrollbackTranscript(content)
      assert.equal(messages[0]!.role, 'tool', `bullet ${bullet} should start a tool block`)
    }
  })

  it('marks non-truncated messages correctly', () => {
    const messages = parseScrollbackTranscript(makeContent())
    const userMsg = messages.find(m => m.summary.includes('hello world'))
    assert.ok(userMsg)
    assert.equal(userMsg!.isTruncated, false)
  })

  it('search is case-insensitive', () => {
    const messages = parseScrollbackTranscript(makeContent())
    const matches = searchTranscript(messages, 'HELLO')
    assert.deepEqual(matches, [0])
  })

  it('search finds tool output content', () => {
    const messages = parseScrollbackTranscript(makeContent())
    const matches = searchTranscript(messages, 'output line 2')
    assert.deepEqual(matches, [1])
  })

  it('findNextMatch cycles forward and wraps', () => {
    const messages = parseScrollbackTranscript(makeContent())
    const matches = searchTranscript(messages, 'line')
    assert.ok(matches.length >= 2)
    const first = findNextMatch(messages, -1, 'line')
    const second = findNextMatch(messages, first, 'line')
    const third = findNextMatch(messages, second, 'line')
    assert.notEqual(first, second)
    assert.equal(third, first)
  })

  it('findPrevMatch cycles backward and wraps', () => {
    const messages = parseScrollbackTranscript(makeContent())
    const first = findPrevMatch(messages, 10, 'line')
    const second = findPrevMatch(messages, first, 'line')
    assert.notEqual(first, second)
  })

  it('returns empty list for empty content', () => {
    const messages = parseScrollbackTranscript('')
    assert.equal(messages.length, 0)
  })

  it('treats plain content as a single assistant block', () => {
    const messages = parseScrollbackTranscript('just\nsome\ntext')
    assert.equal(messages.length, 1)
    assert.equal(messages[0]!.role, 'assistant')
  })
})
