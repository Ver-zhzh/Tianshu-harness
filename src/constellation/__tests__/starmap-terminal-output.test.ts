import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { WriteStream } from 'node:tty'
import { createConstellation, normalizeConstellation } from '../schema.js'
import { formatMilestoneLine } from '../format.js'
import { renderStarmap } from '../../tui/format/overlay.js'
import { OverlayEngine } from '../../tui/engine/overlay-engine.js'
import { getTheme } from '../../tui/theme.js'

test('persisted milestone fields remain single-row plain text through overlay stdout', () => {
  const raw = {
    ...createConstellation({ projectId: 'fixture', name: 'fixture', now: 1 }),
    milestones: [{
      id: 'fixture', timestamp: 1, type: 'fix', verificationStatus: 'verified',
      summary: 'begin\x1b]52;c;Zml4dHVyZQ==\x07\x1b[2J\u009bend\rFAKE\nROW\tTAB',
      agentMark: { numericId: 1, symbol: '⚘\rSYM\nBOL\tX', domain: 'dom\rAIN\nNAME\tY' },
    }],
  }
  const stored = normalizeConstellation(JSON.parse(JSON.stringify(raw)))!
  const line = formatMilestoneLine(stored.milestones[0]!, 1)
  assert.doesNotMatch(line, /[\u0000-\u001f\u007f-\u009f]/)
  assert.match(line, /begin end FAKE ROW TAB/)
  assert.match(line, /⚘ SYM BOL X/)
  assert.match(line, /dom AIN NAME Y/)

  const render = (milestone: string) => renderStarmap({ entries: [], milestones: [milestone] }, 200, 24, getTheme())
  const writes: string[] = []
  const engine = new OverlayEngine({
    stdout: { write: (chunk: string) => { writes.push(chunk); return true } } as unknown as WriteStream,
    getSize: () => ({ cols: 200, rows: 24 }),
  })
  engine.register('starmap', { render: () => render(line) })
  engine.activate('starmap')
  const expectedWrites: string[] = []
  const cleanEngine = new OverlayEngine({
    stdout: { write: (chunk: string) => { expectedWrites.push(chunk); return true } } as unknown as WriteStream,
    getSize: () => ({ cols: 200, rows: 24 }),
  })
  cleanEngine.register('starmap', { render: () => render('🔧 ✓ begin end FAKE ROW TAB — dom AIN NAME Y·#1·⚘ SYM BOL X, just now') })
  cleanEngine.activate('starmap')
  assert.deepEqual(writes, expectedWrites, 'final stdout must match a frame made from known safe text')
})
