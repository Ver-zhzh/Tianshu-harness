import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ToolCallBudget } from '../tool-call-budget.js'

test('wall-clock rollback cannot enlarge the remaining machine-work budget', async t => {
  const controller = new AbortController(), budget = new ToolCallBudget('clock', 25, controller.signal)
  const now = Date.now
  const guard = setTimeout(() => controller.abort(new Error('test guard: budget failed to expire')), 200)
  try {
    await assert.rejects(budget.run(async () => {
      t.mock.method(Date, 'now', () => now() - 3_600_000)
      await budget.waiting(async () => {})
      await new Promise<never>(() => {})
    }), /timed out/)
  } finally { clearTimeout(guard) }
})
