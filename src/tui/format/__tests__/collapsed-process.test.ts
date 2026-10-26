import test from 'node:test'
import assert from 'node:assert/strict'
import { stripVTControlCharacters as plain } from 'node:util'
import { formatCollapsedProcess, formatCollapsedProcessDetails, type CollapsedProcessGroup } from '../collapsed-process.js'
import { getTheme } from '../../theme.js'
import { ToolGroupController } from '../../engine/tool-group-controller.js'

const theme = getTheme()
const startMs = Date.now() - 1200

function processFixture(): CollapsedProcessGroup {
  return {
    startMs,
    readGroups: [{
      startMs,
      entries: [
        { id: 'g1', toolName: 'grep', input: { pattern: 'alpha' }, displayName: 'alpha', kind: 'search', completed: true, content: 'SEARCH_BODY' },
        { id: 'r1', toolName: 'read_file', input: { file_path: 'src/a.ts' }, displayName: 'src/a.ts', kind: 'read', completed: true, content: 'READ_BODY', rawPath: '/tmp/read.raw' },
      ],
    }],
    bashGroups: [{
      startMs,
      entries: [{ id: 'b1', command: 'pwd', completed: true, content: 'BASH_BODY', startMs, rawPath: '/tmp/bash.raw' }],
    }],
  }
}

test('multiple tool families share one process summary and one complete detail view', () => {
  const process = processFixture()
  const summary = formatCollapsedProcess({ process, theme, columns: 120, expandHint: 'ctrl+o 展开' }).map(plain)
  assert.equal(summary.length, 1)
  assert.match(summary[0]!, /执行过程 · 3 工具 · 搜索 1 · 阅读 1 · 命令 1/)
  assert.ok(!summary[0]!.includes('工具详情'), 'the detail hint is not repeated as a second label')
  assert.ok(!summary[0]!.includes('SEARCH_BODY'))

  const detail = plain(formatCollapsedProcessDetails({ process, theme, columns: 120 }).join('\n'))
  for (const expected of ['SEARCH_BODY', 'READ_BODY', 'BASH_BODY', '/tmp/read.raw', '/tmp/bash.raw']) {
    assert.ok(detail.includes(expected), `detail missing ${expected}`)
  }
})

test('a single existing group keeps its current presentation', () => {
  const process = processFixture()
  process.bashGroups = []
  const summary = formatCollapsedProcess({ process, theme, columns: 120, expandHint: 'ctrl+o 展开' }).map(plain)
  assert.equal(summary.length, 1)
  assert.match(summary[0]!, /Searched 1 pattern, Read 1 file/)
  assert.ok(!summary[0]!.includes('执行过程'))
})

test('unified details preserve read, bash, read event order even within the same millisecond', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 })
  const controller = new ToolGroupController()
  for (const [id, kind] of [['first', 'read'], ['second', 'bash'], ['third', 'read']] as const) {
    if (kind === 'read') {
      controller.pushUse(id, 'read_file', { file_path: `${id}.ts` })
      controller.attachResult(id, `${id}_BODY`, false)
      controller.stageProcessReadGroup(controller.flushGroup()!)
    } else {
      controller.pushBashUse(id, 'pwd', Date.now())
      controller.attachBashResult(id, `${id}_BODY`, false)
      controller.stageProcessBashGroup(controller.flushBashGroup()!)
    }
  }
  const process = controller.commitProcess()!
  const detail = plain(formatCollapsedProcessDetails({ process, theme, columns: 120 }).join('\n'))
  assert.ok(detail.indexOf('first_BODY') < detail.indexOf('second_BODY'))
  assert.ok(detail.indexOf('second_BODY') < detail.indexOf('third_BODY'))
})
