import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderJobsOverlay } from '../jobs-panel.js'
import { getTheme } from '../../theme.js'
import type { JobRow } from '../../job-registry.js'

const theme = getTheme()
function stripAnsi(s: string): string { return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '') }

function running(id: string, command: string, lastLine = ''): JobRow {
  return { id, command, status: 'running', startedAt: Date.now() - 5000, lastLine, terminal: false, unread: false }
}
function exited(id: string, command: string, code: number): JobRow {
  return { id, command, status: 'exited', exitCode: code, startedAt: Date.now() - 9000, endedAt: Date.now(), lastLine: 'bye', terminal: true, unread: code !== 0 }
}

describe('renderJobsOverlay', () => {
  it('renders an empty-state line when there are no jobs', () => {
    const out = stripAnsi(renderJobsOverlay([], 80, 24, theme, 0).join('\n'))
    assert.match(out, /没有后台任务|No background jobs/)
  })

  it('lists a running job with its command and a spinner glyph', () => {
    const out = stripAnsi(renderJobsOverlay([running('a1b2', 'npm run dev', 'Listening :3000')], 80, 24, theme, 0).join('\n'))
    assert.match(out, /npm run dev/)
    assert.match(out, /a1b2/)
    assert.match(out, /Listening :3000/)
  })

  it('shows exit code for a terminal job', () => {
    const out = stripAnsi(renderJobsOverlay([exited('c3', 'build', 1)], 80, 24, theme, 0).join('\n'))
    assert.match(out, /build/)
    assert.match(out, /exit 1|✗/)
  })

  it('flattens embedded newlines in lastLine (LiveEngine safety)', () => {
    const row = running('a1', 'srv', 'line1\nline2\rline3')
    const lines = renderJobsOverlay([row], 80, 24, theme, 0)
    for (const l of lines) assert.equal(l.includes('\n'), false)
  })

  it('marks the selected row', () => {
    const rows = [running('a1', 'one'), running('b2', 'two')]
    const out = stripAnsi(renderJobsOverlay(rows, 80, 24, theme, 1).join('\n'))
    const twoLine = out.split('\n').find(l => l.includes('two'))!
    assert.match(twoLine, />/)
  })

  it('does not produce newlines in any overlay line (end to end)', () => {
    const rows: JobRow[] = [
      { id: 'x1', command: 'npm run dev', status: 'running', startedAt: 1000, lastLine: 'ready\nextra', terminal: false, unread: false },
      { id: 'x2', command: 'build', status: 'exited', exitCode: 1, startedAt: 500, endedAt: 3000, lastLine: 'fail', terminal: true, unread: true },
    ]
    const lines = renderJobsOverlay(rows, 100, 30, theme, 0)
    assert.ok(lines.length > 0)
    for (const l of lines) assert.equal(l.includes('\n'), false)
  })
})
