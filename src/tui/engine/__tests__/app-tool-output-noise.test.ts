import test from 'node:test'
import assert from 'node:assert/strict'
import { stripVTControlCharacters as plain } from 'node:util'
import { makeApp } from './_harness.js'
import { ToolGroupController, type TruncatedToolInfo } from '../tool-group-controller.js'
import type { TuiApp } from '../app.js'
import type { LiveRegionLine } from '../live-engine.js'
import { renderPager, type PagerData } from '../../format/overlay.js'
import { getTheme } from '../../theme.js'

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))
const occurrences = (text: string, needle: string) => text.split(needle).length - 1

function classicApp() {
  const ctx = makeApp({ cols: 120, rows: 30 })
  ctx.app.registerOverlays({})
  return ctx
}

function pagerText(app: TuiApp): string {
  const pager = (app as any).detailPager as { content: string } | null
  return pager ? plain(pager.content) : ''
}

function projectedPager(app: TuiApp): PagerData {
  return (app as any).getPagerContent()
}

function renderEntirePager(app: TuiApp): { data: PagerData; body: string; projected: string } {
  const data = projectedPager(app)
  const contentRows = data.content.split('\n')
  const rendered = renderPager({ ...data, page: 0, lineOffset: 0, mode: 'page' },
    (app as any).columns, contentRows.length + 4, getTheme())
  const body = rendered.slice(2, 2 + contentRows.length).map(plain)
  assert.equal(body.length, contentRows.length)
  for (const [index, source] of contentRows.entries()) {
    assert.ok(body[index]!.includes(plain(source)), `renderPager must not crop projected row ${index}: ${plain(source)}`)
  }
  return { data, body: body.join('\n'), projected: plain(data.content) }
}

function assertCompleteLongDetail(app: TuiApp, head: string, tail: string, rawPath: string): void {
  const raw = pagerText(app)
  const { data, body, projected } = renderEntirePager(app)
  assert.ok(data.content.split('\n').length > raw.split('\n').length, 'detail must soft-wrap the long logical line')
  assert.equal(projected.replace(/\n/g, ''), raw.replace(/\n/g, ''), 'projection must preserve the complete source')
  assert.equal(occurrences(projected.replace(/\n/g, ''), rawPath), 1)
  assert.ok(body.includes(head), `rendered detail must retain ${head}`)
  assert.ok(body.includes(tail), `rendered detail must retain ${tail}`)
  assert.equal(occurrences(body, rawPath), 1, 'rendered detail must contain the full rawPath exactly once')
}

function openLastTool(app: TuiApp): void {
  ;(app as any).performFrontendAction('lastTool')
}

function captureLive(app: TuiApp): { lines: () => LiveRegionLine[]; render: () => void } {
  let frame: LiveRegionLine[] = []
  const internals = app as any
  internals.live.render = (lines: LiveRegionLine[]) => { frame = lines }
  return {
    lines: () => frame,
    render: () => internals.renderLive(),
  }
}

function ordinaryTool(app: TuiApp, id: string, output: string, rawPath?: string, isError = false): void {
  app.callbacks.onToolUse(id, 'run_tests', { command: `command-${id}`, fullParameter: `parameter-${id}` })
  app.callbacks.onToolResult(id, 'run_tests', output, isError, rawPath)
}

test('controller consumes settled tool details in actual recency order', () => {
  const controller = new ToolGroupController()
  controller.pushUse('read', 'read_file', { file_path: 'old.ts' })
  controller.flushGroup()
  controller.pushBashUse('bash', 'pwd', Date.now())
  controller.flushBashGroup()
  controller.setLastTruncatedTool({ toolName: 'custom_tool', content: 'newest', isError: false })

  assert.equal(controller.takeLatestToolDetail()?.kind, 'tool')
  assert.equal(controller.takeLatestToolDetail()?.kind, 'bash')
  assert.equal(controller.takeLatestToolDetail()?.kind, 'read-search')
  assert.equal(controller.takeLatestToolDetail(), null)
})

test('controller consumes a staged process and its included groups only once', () => {
  const controller = new ToolGroupController()
  controller.pushUse('read', 'read_file', { file_path: 'a.ts' })
  controller.attachResult('read', 'READ_A', false)
  const read = controller.flushGroup()!
  controller.pushBashUse('bash', 'pwd', Date.now())
  controller.attachBashResult('bash', 'BASH_B', false)
  const bash = controller.flushBashGroup()!
  controller.stageProcessReadGroup(read)
  controller.stageProcessBashGroup(bash)

  const target = controller.takeLatestToolDetail()
  assert.equal(target?.kind, 'process')
  if (target?.kind !== 'process') return
  assert.equal(target.group.readGroups.length, 1)
  assert.equal(target.group.bashGroups.length, 1)
  assert.equal(controller.takeLatestToolDetail(), null, 'included read/bash groups must not reopen as duplicate details')
})

test('controller prefers an unconsumed active group without flushing it and consumes each snapshot once', () => {
  const controller = new ToolGroupController()
  const settled: TruncatedToolInfo = { toolName: 'custom_tool', content: 'settled', isError: false }
  controller.pushUse('read', 'read_file', { file_path: 'active.ts' })
  controller.setLastTruncatedTool(settled)

  const active = controller.takeLatestToolDetail()
  assert.equal(active?.kind, 'read-search')
  assert.equal(active?.active, true)
  assert.equal(controller.isActiveGroup(), true, 'opening a snapshot must not settle the live group')
  assert.equal(controller.takeLatestToolDetail()?.kind, 'tool', 'an already opened active snapshot must not repeat')
  assert.equal(controller.takeLatestToolDetail(), null)

  controller.attachResult('read', 'new active content', false)
  assert.equal(controller.takeLatestToolDetail()?.kind, 'read-search', 'new group activity makes a fresh snapshot available')
})

test('controller offers active bash details symmetrically without flushing', () => {
  const controller = new ToolGroupController()
  controller.pushBashUse('bash', 'pwd', Date.now())
  const target = controller.takeLatestToolDetail()
  assert.equal(target?.kind, 'bash')
  assert.equal(target?.active, true)
  assert.equal(controller.isActiveBashGroup(), true)
  assert.equal(controller.takeLatestToolDetail(), null)
})

test('default mixed and intermediate turns keep successful bodies, raw paths and thinking summaries out of scrollback', async t => {
  const { app } = classicApp()
  t.after(() => app.dispose())
  const thinkingRecords: string[] = []
  const frontend = (app as any).frontend
  const record = frontend.record.bind(frontend)
  frontend.record = (entry: { kind: string; text?: string }) => {
    if (entry.kind === 'thinking') thinkingRecords.push(entry.text ?? '')
    record(entry)
  }

  app.callbacks.onThinkingDelta('THINK_TOOL_BOUNDARY')
  app.callbacks.onToolUse('read', 'read_file', { file_path: 'quiet.ts' })
  app.callbacks.onToolResult('read', 'read_file', 'READ_FULL_BODY\nREAD_BODY_TAIL', false, '/tmp/quiet-read.raw')
  ordinaryTool(app, 'ordinary', 'ORDINARY_1\nORDINARY_2\nORDINARY_3\nORDINARY_4\nORDINARY_5', '/tmp/quiet-tool.raw')
  app.callbacks.onToolUse('bash', 'bash', { command: 'pwd' })
  app.callbacks.onToolResult('bash', 'bash', 'BASH_FULL_BODY\nBASH_BODY_TAIL', false, '/tmp/quiet-bash.raw')
  app.callbacks.onThinkingDelta('THINK_INTERMEDIATE')
  app.callbacks.onTurnComplete({}, 1, false)
  await tick()

  let scrollback = plain(app.getScrollbackContent())
  assert.ok(!scrollback.includes('已推理'), 'tool boundaries and intermediate turns must not print thinking summaries')
  assert.ok(!scrollback.includes('READ_FULL_BODY'))
  assert.ok(!scrollback.includes('BASH_FULL_BODY'))
  assert.ok(!scrollback.includes('ORDINARY_1'))
  assert.ok(scrollback.includes('ORDINARY_5'), 'ordinary run output keeps its compact tail')
  assert.ok(!scrollback.includes('/tmp/quiet-read.raw'))
  assert.ok(!scrollback.includes('/tmp/quiet-tool.raw'))
  assert.ok(!scrollback.includes('/tmp/quiet-bash.raw'))
  assert.ok(!scrollback.includes('parameter-ordinary'), 'default cards do not print the full parameter JSON')

  app.callbacks.onThinkingDelta('THINK_FINAL')
  app.callbacks.onTextDelta('ANSWER_BODY')
  app.callbacks.onTurnComplete({}, 2, true)
  await tick()
  scrollback = plain(app.getScrollbackContent())
  assert.ok(scrollback.includes('ANSWER_BODY'))
  assert.ok(!scrollback.includes('已推理'))
  assert.deepEqual(thinkingRecords, ['THINK_TOOL_BOUNDARY', 'THINK_INTERMEDIATE', 'THINK_FINAL'])
  assert.equal((app as any).thinkingReview.peek()?.text, 'THINK_FINAL')
  assert.equal((app as any).state.thinkingText, '')
  assert.equal((app as any).state.isThinking, false)

  const beforeReview = app.getScrollbackContent()
  ;(app as any).performFrontendAction('thinking')
  assert.equal(app.activeOverlayId(), 'pager')
  assert.ok(pagerText(app).includes('THINK_FINAL'))
  assert.equal(app.getScrollbackContent(), beforeReview, 'thinking review remains read-only')
})

test('verbose ordinary results preserve parameters, full output, raw source and checkpoint notices', t => {
  const { app } = classicApp()
  t.after(() => app.dispose())
  app.setVerbose(true)
  ordinaryTool(app, 'verbose', 'VERBOSE_1\nVERBOSE_2\nVERBOSE_3\nVERBOSE_4', '/tmp/verbose.raw')
  app.callbacks.onCheckpoint?.('abcdef123456')

  const scrollback = plain(app.getScrollbackContent())
  for (const line of ['VERBOSE_1', 'VERBOSE_2', 'VERBOSE_3', 'VERBOSE_4', 'parameter-verbose']) {
    assert.ok(scrollback.includes(line), `verbose must retain ${line}`)
  }
  assert.equal(occurrences(scrollback, '/tmp/verbose.raw'), 1)
  assert.ok(scrollback.includes('Checkpoint saved: abcdef1 — /rollback to restore'))
})

test('default checkpoint notices stay out of scrollback', t => {
  const { app } = classicApp()
  t.after(() => app.dispose())
  app.callbacks.onCheckpoint?.('abcdef123456')
  assert.ok(!plain(app.getScrollbackContent()).includes('Checkpoint saved'))
})

test('compact errors keep the final four diagnostic lines', t => {
  const { app } = classicApp()
  t.after(() => app.dispose())
  ordinaryTool(app, 'error', 'ERROR_1\nERROR_2\nERROR_3\nERROR_4\nERROR_5\nERROR_6', undefined, true)
  const scrollback = plain(app.getScrollbackContent())
  assert.ok(!scrollback.includes('ERROR_1'))
  assert.ok(!scrollback.includes('ERROR_2'))
  for (const line of ['ERROR_3', 'ERROR_4', 'ERROR_5', 'ERROR_6']) assert.ok(scrollback.includes(line))
})

test('ordinary tool detail is a full read-only pager and queued commits do not pollute it', async t => {
  const { app, out } = classicApp()
  t.after(() => app.dispose())
  ordinaryTool(app, 'detail', 'DETAIL_1\nDETAIL_2\nDETAIL_3\nDETAIL_4\nDETAIL_5\nDETAIL_6', '/tmp/detail.raw')
  const before = app.getScrollbackContent()

  openLastTool(app)
  assert.equal(app.activeOverlayId(), 'pager')
  assert.equal(app.getScrollbackContent(), before)
  const detail = pagerText(app)
  for (let i = 1; i <= 6; i++) assert.ok(detail.includes(`DETAIL_${i}`), `detail must contain DETAIL_${i}`)
  assert.equal(occurrences(detail, '/tmp/detail.raw'), 1)

  out.clear()
  ordinaryTool(app, 'queued', 'QUEUED_HEAD\nQUEUED_MIDDLE\nQUEUED_TAIL')
  assert.ok(!plain(out.chunks.join('')).includes('QUEUED_TAIL'), 'tool commits must not write into the pager')
  assert.equal(app.getScrollbackContent(), before, 'overlay commits remain queued')
  app.deactivateOverlay()
  await tick()
  const after = plain(app.getScrollbackContent())
  assert.ok(after.includes('QUEUED_TAIL'))
  assert.ok(!after.includes('QUEUED_HEAD'), 'the queued card still uses compact rendering')
})

test('active read/search detail uses a snapshot without flushing or changing scrollback', t => {
  const { app } = classicApp()
  t.after(() => app.dispose())
  app.callbacks.onToolUse('read', 'read_file', { file_path: 'active.ts' })
  app.callbacks.onToolResult('read', 'read_file', 'ACTIVE_READ_1\nACTIVE_READ_2\nACTIVE_READ_3', false, '/tmp/active-read.raw')
  const before = app.getScrollbackContent()

  openLastTool(app)
  assert.equal(app.activeOverlayId(), 'pager')
  assert.equal((app as any).toolGroupController.isActiveGroup(), true)
  assert.equal(app.getScrollbackContent(), before)
  const detail = pagerText(app)
  for (let i = 1; i <= 3; i++) assert.ok(detail.includes(`ACTIVE_READ_${i}`))
  assert.equal(occurrences(detail, '/tmp/active-read.raw'), 1)

  app.deactivateOverlay()
  openLastTool(app)
  assert.equal(app.activeOverlayId(), null, 'the same active snapshot is consumed once')
  assert.equal(app.getScrollbackContent(), before)
})

test('active bash detail is symmetric and does not flush the group', t => {
  const { app } = classicApp()
  t.after(() => app.dispose())
  app.callbacks.onToolUse('bash', 'bash', { command: 'pwd' })
  app.callbacks.onToolResult('bash', 'bash', 'ACTIVE_BASH_1\nACTIVE_BASH_2', false, '/tmp/active-bash.raw')
  const before = app.getScrollbackContent()

  openLastTool(app)
  assert.equal(app.activeOverlayId(), 'pager')
  assert.equal((app as any).toolGroupController.isActiveBashGroup(), true)
  assert.equal(app.getScrollbackContent(), before)
  assert.ok(pagerText(app).includes('ACTIVE_BASH_1'))
  assert.ok(pagerText(app).includes('ACTIVE_BASH_2'))
  assert.equal(occurrences(pagerText(app), '/tmp/active-bash.raw'), 1)
})

test('app opens settled bash, ordinary and read/search details by actual recency', t => {
  const { app } = classicApp()
  t.after(() => app.dispose())
  app.callbacks.onToolUse('read', 'read_file', { file_path: 'oldest.ts' })
  app.callbacks.onToolResult('read', 'read_file', 'OLDEST_READ', false)
  ordinaryTool(app, 'ordinary', 'MIDDLE_1\nMIDDLE_2\nMIDDLE_3')
  app.callbacks.onToolUse('bash', 'bash', { command: 'pwd' })
  app.callbacks.onToolResult('bash', 'bash', 'NEWEST_BASH', false)
  app.callbacks.onTurnComplete({}, 1, false)

  openLastTool(app)
  assert.ok(pagerText(app).includes('NEWEST_BASH'), 'bash was settled most recently')
  app.deactivateOverlay()
  openLastTool(app)
  assert.ok(pagerText(app).includes('MIDDLE_1'), 'ordinary tool was settled second')
  app.deactivateOverlay()
  openLastTool(app)
  assert.ok(pagerText(app).includes('OLDEST_READ'), 'read/search was settled first')
})

test('default pending cards hide raw output tails and suppress the duplicate activity spinner', t => {
  const { app } = classicApp()
  t.after(() => app.dispose())
  const live = captureLive(app)
  app.callbacks.onToolUse('pending', 'custom_tool', {})
  app.callbacks.onToolResult('pending', 'custom_tool', 'PENDING_1\nPENDING_2\n')
  app.callbacks.onToolResult('pending', 'custom_tool', 'PENDING_3\n')
  live.render()
  const rows = live.lines().map(line => ({ ...line, text: plain(line.text) }))
  assert.ok(!rows.some(line => /PENDING_[123]/.test(line.text)))
  assert.equal(rows.filter(line => line.text.includes('custom_tool')).length, 1, 'only the live card names the current tool')
  assert.ok(!rows.some(line => line.livePart === 'status' && line.text.includes('custom_tool')))
})

test('verbose pending cards retain the latest three raw output lines', t => {
  const { app } = classicApp()
  t.after(() => app.dispose())
  app.setVerbose(true)
  const live = captureLive(app)
  app.callbacks.onToolUse('pending', 'custom_tool', {})
  app.callbacks.onToolResult('pending', 'custom_tool', 'VERBOSE_PENDING_1\nVERBOSE_PENDING_2\nVERBOSE_PENDING_3\nVERBOSE_PENDING_4\n')
  live.render()
  const text = live.lines().map(line => plain(line.text)).join('\n')
  assert.ok(!text.includes('VERBOSE_PENDING_1'))
  for (const line of ['VERBOSE_PENDING_2', 'VERBOSE_PENDING_3', 'VERBOSE_PENDING_4']) assert.ok(text.includes(line))
})

test('non-collapsed live cards suppress only activity, not stale safety guidance', t => {
  const { app } = classicApp()
  t.after(() => app.dispose())
  const live = captureLive(app)
  app.callbacks.onToolUse('pending', 'custom_tool', {})
  ;(app as any).streamRenderController.lastActivityMs = Date.now() - 20_000
  live.render()
  const rows = live.lines().map(line => ({ ...line, text: plain(line.text) }))
  assert.equal(rows.filter(line => line.text.includes('custom_tool')).length, 1)
  assert.ok(rows.some(line => line.livePart === 'status' && line.text.includes('Waiting for response')))
})

test('collapsed-only work keeps the spinner object and live group count', t => {
  const { app } = classicApp()
  t.after(() => app.dispose())
  const live = captureLive(app)
  app.callbacks.onToolUse('read', 'read_file', { file_path: 'active.ts' })
  live.render()
  const rows = live.lines().map(line => ({ ...line, text: plain(line.text) }))
  assert.ok(rows.some(line => line.livePart === 'status' && line.text.includes('Read(active.ts)')))
  assert.ok(rows.some(line => line.text.includes('1 pending')))
})

test('standard Ctrl+O still opens history while legacy Ctrl+O opens the tool pager', async t => {
  const standard = classicApp()
  t.after(() => standard.app.dispose())
  standard.app.setFrontendPreferences({ ...standard.app.getFrontendPreferences(), keymap: 'standard', bindings: {} })
  standard.stdin.dataHandler!('\x0f')
  for (let i = 0; i < 30 && standard.app.activeOverlayId() !== 'ui-history'; i++) await tick(10)
  assert.equal(standard.app.activeOverlayId(), 'ui-history')

  const legacy = classicApp()
  t.after(() => legacy.app.dispose())
  legacy.app.setFrontendPreferences({ ...legacy.app.getFrontendPreferences(), keymap: 'legacy', bindings: {} })
  ordinaryTool(legacy.app, 'legacy', 'LEGACY_1\nLEGACY_2\nLEGACY_3')
  const before = legacy.app.getScrollbackContent()
  legacy.stdin.dataHandler!('\x0f')
  await tick()
  assert.equal(legacy.app.activeOverlayId(), 'pager')
  assert.ok(pagerText(legacy.app).includes('LEGACY_1'))
  assert.equal(legacy.app.getScrollbackContent(), before)
})

function renderCurrentPagerBody(app: TuiApp): string {
  const internals = app as any
  const nav = internals.overlayController.nav()
  const data = projectedPager(app)
  const rows = internals.rows as number
  const pageSize = Math.max(1, rows - 4)
  const rendered = renderPager({
    ...data,
    page: nav.pagerPage,
    lineOffset: nav.pagerLineOffset,
    mode: nav.pagerMode,
    searchQuery: nav.pagerSearchQuery,
    searchMatches: data.searchRows?.(nav.pagerSearchQuery).length ?? 0,
    searchCurrent: nav.pagerSearchCurrent,
    selectedMessageIndex: nav.pagerSelectedMessage,
    verbose: nav.pagerVerbose,
  }, internals.columns, rows, getTheme())
  return rendered.slice(2, 2 + pageSize).map(plain).join('\n')
}

for (const kind of ['ordinary', 'collapsed'] as const) {
  test(`${kind} detail soft-wraps a long Chinese/ASCII line without losing its head, tail or rawPath`, async t => {
    const { app } = makeApp({ cols: 48, rows: 14 })
    app.registerOverlays({})
    t.after(() => app.dispose())
    const head = `${kind}_中文头_`
    const tail = `_${kind}_ASCII尾`
    const content = `${head}${'Ab中'.repeat(60)}${tail}`
    const rawPath = '/tmp/raw output/完整.log'
    if (kind === 'ordinary') ordinaryTool(app, kind, content, rawPath)
    else {
      app.callbacks.onToolUse(kind, 'read_file', { file_path: 'collapsed-long.ts' })
      app.callbacks.onToolResult(kind, 'read_file', content, false, rawPath)
      app.callbacks.onTurnComplete({}, 1, false)
      await tick()
    }

    openLastTool(app)
    assert.equal(app.activeOverlayId(), 'pager')
    assertCompleteLongDetail(app, head, tail, rawPath)
  })
}

test('ordinary short outputs and rawPath-only details retain their legacy pager entry', async t => {
  const { app } = classicApp()
  t.after(() => app.dispose())
  ordinaryTool(app, 'short', 'SHORT_ONLY')
  openLastTool(app)
  assert.equal(app.activeOverlayId(), 'pager')
  assert.ok(renderEntirePager(app).body.includes('SHORT_ONLY'))
  app.deactivateOverlay()
  await tick()

  const rawPath = '/tmp/short raw/output.log'
  ordinaryTool(app, 'raw-path', 'RAW_PATH_BODY', rawPath)
  openLastTool(app)
  assert.equal(app.activeOverlayId(), 'pager')
  const { body } = renderEntirePager(app)
  assert.ok(body.includes('RAW_PATH_BODY'))
  assert.equal(occurrences(body, rawPath), 1)
})

test('verbose commits a long single line in full without adding a duplicate detail target', t => {
  const { app } = classicApp()
  t.after(() => app.dispose())
  app.setVerbose(true)
  const content = `VERBOSE_中文头_${'LongAscii中'.repeat(50)}_VERBOSE尾`
  const rawPath = '/tmp/verbose raw/完整.log'
  ordinaryTool(app, 'verbose-long', content, rawPath)

  const scrollback = plain(app.getScrollbackContent())
  assert.ok(scrollback.includes(content), 'verbose commit must retain the complete unwrapped line')
  assert.equal(occurrences(scrollback, rawPath), 1)
  openLastTool(app)
  assert.equal(app.activeOverlayId(), null, 'verbose output is already fully committed')
})

test('an active read error commits its title and tail immediately and a late success reopens a pending group', async t => {
  const { app } = classicApp()
  t.after(() => app.dispose())
  app.callbacks.onToolUse('late-success', 'read_file', { file_path: 'late-success.ts' })
  app.callbacks.onToolUse('active-error', 'read_file', { file_path: 'ACTIVE_READ_ERROR_TITLE.ts' })
  app.callbacks.onToolResult('active-error', 'read_file',
    'ACTIVE_ERROR_1\nACTIVE_ERROR_2\nACTIVE_ERROR_3\nACTIVE_ERROR_4\nACTIVE_ERROR_5', true)

  const immediate = plain(app.getScrollbackContent())
  assert.ok(immediate.includes('ACTIVE_READ_ERROR_TITLE.ts'), 'error title must not wait for turn completion')
  for (const line of ['ACTIVE_ERROR_3', 'ACTIVE_ERROR_4', 'ACTIVE_ERROR_5']) assert.ok(immediate.includes(line))
  assert.ok(!immediate.includes('ACTIVE_ERROR_1'))
  assert.equal((app as any).toolGroupController.isActiveGroup(), false)

  app.callbacks.onToolResult('late-success', 'read_file', 'LATE_SUCCESS_BODY', false)
  const delayed = plain(app.getScrollbackContent())
  assert.ok(!delayed.includes('late-success.ts'), 'successful late results still aggregate instead of committing immediately')
  assert.equal((app as any).toolGroupController.isActiveGroup(), true)
  app.callbacks.onTurnComplete({}, 1, false)
  await tick()
  assert.ok(plain(app.getScrollbackContent()).includes('late-success.ts'))
})

test('detail search crosses soft wraps and keeps the current match visible after resize', t => {
  const { app, out, stdin } = makeApp({ cols: 24, rows: 14 })
  app.registerOverlays({})
  t.after(() => app.dispose())
  const query = '跨软折行搜索唯一目标定位'
  const content = [
    `前缀${'甲'.repeat(35)}${query}${'乙'.repeat(35)}`,
    ...Array.from({ length: 30 }, (_, index) => `尾部${index}_${'x'.repeat(30)}`),
  ].join('\n')
  ordinaryTool(app, 'search-detail', content)
  openLastTool(app)
  assert.equal(app.activeOverlayId(), 'pager')
  const initial = renderEntirePager(app).data
  assert.ok(!initial.content.split('\n').some(row => plain(row).includes(query)), 'query must span projected rows')
  assert.equal(initial.searchRows?.(query).length, 1)

  stdin.dataHandler!('/')
  stdin.dataHandler!(query)
  stdin.dataHandler!('\r')
  const nav = (app as any).overlayController.nav()
  assert.equal(nav.pagerSearchCurrent, 1)
  out.clear()
  out.columns = 72
  ;(app as any).renderLive()
  ;(app as any).overlay.rerender()

  const resized = projectedPager(app)
  const hit = resized.searchRows?.(query)[0]
  assert.notEqual(hit, undefined)
  const pageSize = Math.max(1, (app as any).rows - 4)
  const offset = nav.pagerLineOffset ?? nav.pagerPage * pageSize
  assert.ok(hit! >= offset && hit! < offset + pageSize, 'resize must remap the current search row')
  assert.equal(nav.pagerSearchCurrent, 1)
  assert.ok(renderCurrentPagerBody(app).includes(query), 'the rendered body, not only the search title, retains the match')
})

test('detail resize preserves the current logical reading row', t => {
  const { app, out } = makeApp({ cols: 40, rows: 14 })
  app.registerOverlays({})
  t.after(() => app.dispose())
  const content = [
    `开头${'甲'.repeat(80)}`,
    `阅读锚点${'x'.repeat(50)}`,
    ...Array.from({ length: 35 }, (_, index) => `后续${index}_${'y'.repeat(40)}`),
  ].join('\n')
  ordinaryTool(app, 'reading-detail', content)
  openLastTool(app)
  const initialHit = projectedPager(app).searchRows?.('阅读锚点')[0]
  assert.notEqual(initialHit, undefined)
  const nav = (app as any).overlayController.nav()
  nav.pagerLineOffset = initialHit
  nav.pagerPage = Math.floor(initialHit! / Math.max(1, (app as any).rows - 4))

  out.clear()
  out.columns = 20
  ;(app as any).renderLive()
  ;(app as any).overlay.rerender()
  const resizedHit = projectedPager(app).searchRows?.('阅读锚点')[0]
  assert.notEqual(resizedHit, undefined)
  assert.equal(nav.pagerLineOffset, resizedHit)
  assert.ok(renderCurrentPagerBody(app).includes('阅读锚点'))
})

test('ordinary detail stays literal instead of inheriting an active plan preview Markdown projection', t => {
  const { app } = classicApp()
  t.after(() => app.dispose())
  ordinaryTool(app, 'literal-detail', '**literal**\nLINE_2\nLINE_3\nLINE_4\nLINE_5')
  app.registerOverlays({ pagerContent: () => ({ content: 'PLAN_MARKDOWN', page: 0 }) })
  app.openPlanPreview('active-plan')
  openLastTool(app)

  assert.equal(app.activeOverlayId(), 'pager')
  const { body } = renderEntirePager(app)
  assert.ok(body.includes('**literal**'), 'detail must preserve its raw Markdown markers')
  assert.ok(!body.includes('PLAN_MARKDOWN'))
})
