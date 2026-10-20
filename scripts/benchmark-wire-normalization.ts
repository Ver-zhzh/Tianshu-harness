import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { normalizeWireMessages } from '../src/api/wire-normalization.js'
import { sanitizeForJsonTransport } from '../src/utils/sanitize.js'
import type { OaiMessage } from '../src/api/oai-types.js'

// Compare equivalent full scans; the former incremental shortcut was incorrect.
function cloneSanitize(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeForJsonTransport(value)
  if (Array.isArray(value)) return value.map(cloneSanitize)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneSanitize(child)]))
  return value
}
function allocatedContainers(before: unknown, after: unknown): number {
  if (!after || typeof after !== 'object') return 0
  const source = before as Record<string, unknown> | undefined
  return Number(before !== after) + Object.entries(after).reduce((sum, [key, child]) => sum + allocatedContainers(source?.[key], child), 0)
}
function medianMs(operation: () => unknown): number {
  for (let i = 0; i < 3; i++) operation()
  const samples = Array.from({ length: 7 }, () => {
    const start = performance.now()
    for (let i = 0; i < 5; i++) operation()
    return (performance.now() - start) / 5
  }).sort((a, b) => a - b)
  return Number(samples[3]!.toFixed(3))
}
const rows = []
for (const size of [6_000, 150_000, 700_000, 1_200_000]) {
  for (const form of ['clean', 'NFD'] as const) {
    const content = (form === 'NFD' ? 'e\u0301'.repeat(50) : 'é'.repeat(50)).padEnd(size, 'x')
    const messages: OaiMessage[] = [{ role: 'system', content: 'stable system' },
      { role: 'user', content }, { role: 'assistant', content: 'ok' }]
    const output = normalizeWireMessages(messages)
    const baseline = cloneSanitize(messages)
    assert.deepEqual(output.messages, baseline)
    rows.push({ size, form, cloneFullScanMs: medianMs(() => cloneSanitize(messages)),
      canonicalCowMs: medianMs(() => normalizeWireMessages(messages)),
      cloneContainers: allocatedContainers(messages, baseline), cowContainers: allocatedContainers(messages, output.messages) })
  }
}
process.stdout.write(JSON.stringify(rows, null, 2) + '\n')
