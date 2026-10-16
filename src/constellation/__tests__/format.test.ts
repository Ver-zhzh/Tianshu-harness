import { test } from 'node:test'
import assert from 'node:assert/strict'
import { relativeTime, formatMilestoneLine, formatConstellationView, formatConstellationHistory } from '../format.js'
import { createConstellation, type Milestone } from '../schema.js'

function m(id: string, over: Partial<Milestone> = {}): Milestone {
  return {
    id, timestamp: 1000, sessionId: 's',
    agentMark: { numericId: 7281, symbol: '⚘', domain: 'yaoguang' },
    domain: 'yaoguang', summary: `summary ${id}`, filesChanged: ['a.ts', 'b.ts'],
    type: 'feature', verificationStatus: 'verified', cycleClose: 'cc', tags: [],
    ...over,
  }
}

test('relativeTime buckets correctly', () => {
  const now = 10_000_000
  assert.equal(relativeTime(now, now), 'just now')
  assert.equal(relativeTime(now - 5 * 60_000, now), '5m ago')
  assert.equal(relativeTime(now - 3 * 3_600_000, now), '3h ago')
  assert.equal(relativeTime(now - 2 * 86_400_000, now), '2d ago')
})

test('formatMilestoneLine includes symbol, mark, file count', () => {
  const line = formatMilestoneLine(m('x'), 1000)
  assert.match(line, /summary x/)
  assert.match(line, /yaoguang·#7281·⚘/)
  assert.match(line, /\(2f\)/)
  assert.match(line, /✓/) // verified glyph
})

test('formatConstellationView shows skeleton + recent milestones newest-first', () => {
  const c = createConstellation({ projectId: 'p', name: 'Demo', now: 1 })
  c.skeleton.modules.push({ path: 'src/agent' })
  c.skeleton.techStack.push('typescript')
  c.milestones.push(m('old', { timestamp: 1, summary: 'old one' }))
  c.milestones.push(m('new', { timestamp: 2, summary: 'new one' }))
  const out = formatConstellationView(c, { now: 1000 })
  assert.match(out, /Constellation — Demo/)
  assert.match(out, /src\/agent/)
  assert.match(out, /typescript/)
  const oldIdx = out.indexOf('old one')
  const newIdx = out.indexOf('new one')
  assert.ok(newIdx >= 0 && oldIdx >= 0)
  assert.ok(newIdx < oldIdx, 'newest milestone should appear first')
})

test('formatConstellationView handles empty milestones gracefully', () => {
  const c = createConstellation({ projectId: 'p', name: 'Empty' })
  const out = formatConstellationView(c)
  assert.match(out, /none yet/)
})

test('formatConstellationHistory reports total and empty state', () => {
  const empty = createConstellation({ projectId: 'p', name: 'E' })
  assert.match(formatConstellationHistory(empty), /No milestones/)
  empty.milestones.push(m('a'))
  assert.match(formatConstellationHistory(empty), /1 total/)
})

// §6 security: milestone fields come from git-tracked .rivet/constellation.json
// (pre-seeded by a malicious repo). formatMilestoneLine output goes straight to
// the Starmap overlay (renderStarmap → overlay-engine stdout.write) without
// passing enforceTextContract, so the line itself must strip terminal escapes.
test('formatMilestoneLine strips OSC 52 clipboard-overwrite from summary', () => {
  const line = formatMilestoneLine(m('osc', { summary: 'pwn\x1b]52;c;aGFjaw==\x07end' }))
  assert.ok(!line.includes('\x1b'), 'ESC must not survive')
  assert.ok(!line.includes('\x07'), 'BEL must not survive')
  assert.match(line, /pwn/)
  assert.match(line, /end/)
})

test('formatMilestoneLine strips CSI clear-screen from summary', () => {
  const line = formatMilestoneLine(m('csi', { summary: 'a\x1b[2Jb' }))
  assert.ok(!line.includes('\x1b'))
  assert.match(line, /ab/)
})

test('formatMilestoneLine sanitizes C1 controls and C0 from every field', () => {
  const line = formatMilestoneLine(
    m('c1', {
      summary: 'sum\u009b2J\u0001x',
      sessionId: 's\u009b',
      agentMark: { numericId: 1, symbol: '\u009b\u001b', domain: 'dom\u0090' },
      type: 'fix',
    }),
  )
  assert.ok(!/\x1b/.test(line), 'no ESC')
  assert.ok(!/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(line), 'no C0/DEL')
  assert.ok(!/[\u0080-\u009F]/.test(line), 'no C1')
})

test('formatMilestoneLine preserves legit glyphs after sanitizing', () => {
  const line = formatMilestoneLine(m('glyph', { type: 'refactor', verificationStatus: 'blocked' }))
  assert.match(line, /♻/)
  assert.match(line, /⚠/)
  assert.match(line, /⚘/)
})
