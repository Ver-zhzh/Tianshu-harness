import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

test('production assembly wires the persistent owner inbox and host continuation consumers', () => {
  const source = (path: string) => readFileSync(resolve(import.meta.dirname, '../../..', path), 'utf8')
  const bootstrap = source('src/bootstrap.ts')
  const b1 = bootstrap.slice(bootstrap.indexOf('reg.register(createDeliverTaskTool('), bootstrap.indexOf('// update_goal —'))
  assert.doesNotMatch(b1, /reviewInbox/, '契约分离：deliver_task B1Context 不再接 reviewInbox')
  const hooks = source('src/agent/create-runtime-hooks.ts')
  assert.match(hooks, /createPostCommitReviewHooks\(\{ advisoryBus: deps\.advisoryBus, sessionId: deps\.sessionId, cwd: deps\.cwd \}/)
  assert.match(source('src/agent/hooks/post-commit-review-hook.ts'), /createReviewInbox\(options\.cwd, options\.sessionId\)/)
  assert.match(source('src/main.ts'), /app\.setReviewOwnerProvider\(\(\) => ctx \? \{ cwd: ctx\.agent\.cwd, sessionId: ctx\.sessionId \}/)
  const manager = source('src/server/session-manager.ts')
  assert.match(manager, /this\.scheduleQueueLaneFlush\(session\)[\s\S]*?session\.reviewFollowup\?\.settled\(\)/)
  assert.match(source('src/tui/slash-commands.ts'), /get\('review_changes'\)/)
  assert.doesNotMatch(source('src/tui/slash-commands.ts'), /await routeReviewWorkflow\(/)
})
