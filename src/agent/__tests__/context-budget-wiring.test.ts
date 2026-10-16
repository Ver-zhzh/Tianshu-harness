import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
/** src/pro 与 desktop/ 是闭源资产（公开仓不随 sync）：缺失返回 null，契约断言跳过。 */
const maybeSource = (path: string): string | null => {
  try { return source(path) } catch { return null }
}

test('budget reaches the real request builder, transport callbacks and desktop wrapper', () => {
  assert.match(source('../request-context-controller.ts'), /preview: request => .*previewContextRequest/ )
  assert.match(source('../turn-step-producer.ts'), /await this\.self\.prepareBudgetedRequest\(/)
  assert.match(source('../loop-factory.ts'), /recordContextBudget: budget => self\.recordContextBudget\(budget\)/)
  assert.match(source('../loop-factory.ts'), /preserveUserOnError: \(\) => !!self\.config\.promptEngine\.getRequestBudgetPolicy\(\)/)
  assert.match(source('../turn-orchestrator.ts'), /onContextBudget: callbacks\.onContextBudget/)
  assert.match(source('../../server/serve-agent.ts'), /getContextBudget: \(\) => agent\.getContextBudget\(\)/)
  assert.match(source('../../server/session-manager.ts'), /this\.append\(session, 'context_budget'/)
  assert.match(source('../create-agent-config.ts'), /requestBudgetPolicy: primaryClient\.previewContextRequest \? deepSeekBudgetPolicy\(provider\.baseUrl, model\.id, model\.contextWindow\)/)
  // wire 侧的输出封顶窗口必须与预算侧同源（issue #372 F3）：`agent.config.contextWindow`
  // 取自解析后的 model spec（走 key 池 contractModels），工厂侧若直接读顶层 provider.models
  // 迁移快照会取到另一个数，两侧各自的 capOutputReserve 于是算出不同预留，
  // `input + max_tokens ≤ window` 失去保障。原先这里钉的是顶层查找——等于把缺陷写成了契约。
  assert.match(source('../../api/factory.ts'), /contextWindow: modelContextWindow\(provider, params\.model\)/)
})

test('manual and isolated entry points use the same budget contract', () => {
  assert.match(source('../../server/serve-agent.ts'), /compactContext: \(\) => agent\.compactContext\(\)/)
  assert.match(source('../../tui/slash-commands.ts'), /ctx\.agent\.compactContext\(\)/)
  // src/pro 与 desktop/ 是闭源资产（公开仓不随 sync）：公开仓形态下整族缺席。
  // 逐个「缺失即跳过」会让路径漂移静默吞掉契约——改用「全有或全无」对账守卫：
  // 整族缺席（公开仓）放行；部分在位（路径漂移/资产挪位）立刻红，与硬性 ENOENT
  // 相比只是把「恒红」换成了「只在真漂移时红」。
  const closedSources = [
    maybeSource('../../pro/runtime/protocol.ts'),
    maybeSource('../../pro/runtime/backend.ts'),
    maybeSource('../../pro/runtime/engine.ts'),
    maybeSource('../../../desktop/src/surfaces/ThreadView.tsx'),
  ]
  const present = closedSources.filter((s): s is string => s !== null).length
  assert.ok(
    present === 0 || present === closedSources.length,
    `闭源资产应整族在位或整族缺席，当前 ${present}/${closedSources.length}——部分在位即路径漂移，`
      + '逐个「缺失即跳过」会让下面的契约断言静默失效',
  )
  const [proProtocol, proBackend, proEngine, threadView] = closedSources
  if (proProtocol) {
    assert.match(proProtocol, /'getContextBudget'/)
    assert.match(proProtocol, /'compactContext'/)
  }
  if (proBackend) assert.match(proBackend, /method === 'switchModel' \|\| method === 'compactContext'/)
  if (proEngine) assert.match(proEngine, /'rewindToMessages', 'compactContext'\]\.includes\(method\)/)
  if (threadView) {
    assert.match(threadView, /await compactSession\(session\.id\)/)
    assert.doesNotMatch(threadView, /onSend\('Context is getting long/)
  }
})
