import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cacheDiagnosticClass } from '../cache-diagnostic-class.js'

test('effective option changes cannot be labelled append-only, including historical diagnostics', () => {
  for (const comparison of ['configuration_changed', 'generation_changed']) {
    assert.equal(cacheDiagnosticClass({ wire: { comparison }, prefix: { changed: false } }), 'model_or_config_change')
  }
  assert.equal(cacheDiagnosticClass({ wire: { comparison: 'equal' } }), 'append_or_unchanged')
})
test('missing observed cache usage stays unknown', () => {
  assert.equal(cacheDiagnosticClass({ usageFields: { output_tokens: 'completion_tokens' } }), 'usage_unknown')
})
