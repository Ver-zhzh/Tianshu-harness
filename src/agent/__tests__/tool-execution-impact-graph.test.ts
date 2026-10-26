/**
 * 冷库回落后台化的 executeBatch 真实接线回归（2026-09-12 两轮审查驱动）。
 *
 * 初版把图与构建 Promise 挂在逐调用新建的 deps 包上（tool-execution 的
 * buildDeps 每次调用都新构 ToolPipelineDeps，只有 config 是引用转发）——
 * 后果一：impact hint 在冷库路径静默全灭（图永远到不了下一调用）；
 * 后果二：每次写工具重复点火一次全仓异步扫描（building 守卫恒 undefined）。
 * 且旧回归走 executeToolUse + 手搓共享 deps 的形状，永远测不到这条断链。
 * 修正（共享盒挂 deps.config，AgentLoop 会话级持有者）必须经 executeBatch
 * 真实接线验证——同类断链只有这一层能抓住。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ToolExecutionController, type ToolExecutionDeps, type ToolExecBatchInput } from '../tool-execution.js'
import { createTurnBudget } from '../turn-budget.js'
import { createPredictionAccumulator } from '../prediction-error.js'
import type { AgentConfig } from '../loop-types.js'

const mockEvidence = () => ({
  getState: () => ({ filesModified: new Set<string>() }),
  trackFileRead: () => {},
  trackFileModified: () => {},
  trackImpact: (_files: string[], _tests: string[]) => {},
  trackVerification: () => {},
  getGateState: () => ({ editsSinceLastTest: 0, hasFailedTests: false, verifications: 0 }),
})

function makeController(cwd: string, evidence: ReturnType<typeof mockEvidence>, config: AgentConfig) {
  // config 必须原引用进 deps（不得展开拷贝）——共享盒挂在这个对象上，
  // 断言读的也是它；拷一份就复刻了「写错对象」的断链形态。
  Object.assign(config, {
    toolRegistry: {
      execute: async () => ({ content: 'ok', isError: false }),
      get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false, timeoutMs: () => 5000 }),
      needsApproval: () => false,
      resolveName: (n: string) => n,
    },
    hooks: null,
    lspEnabled: false,
    contextClaimStore: undefined,
    sessionId: 'test-session',
    contextWindow: 200_000,
    promptEngine: { markGitDirty: () => {}, getModel: () => 'test-model' },
    // 冷库：索引已建但 files 表为空——落回 import-graph 后台构建分支。
    meridianIndexer: { getDb: () => ({ hasFiles: () => false }) },
  })
  const deps = {
    config,
    cwd,
    harness: {
      executeTool: async ({ execute }: any) => {
        const r = await execute()
        return { content: r.content, isError: r.isError ?? false, retried: false }
      },
    },
    prewarm: { get: () => null, invalidate: () => {} },
    evidence,
    repairHintTracker: { recordSuccess: () => {}, recordFailure: () => {} },
    repairPipeline: { run: (input: any) => ({ output: input, telemetry: [] }) },
    runtimeHooks: { runPostTool: async () => {} },
    contextInjection: { setCerebellarHint: () => {}, clearCerebellarHint: () => {} },
    trajectory: { getEntries: () => [] },
    getPredictionAccumulator: () => createPredictionAccumulator(),
    setPredictionAccumulator: () => {},
    getVigorState: () => ({}),
    setVigorState: () => {},
    getDoomLoopLevel: () => 'none' as const,
    getSessionTurnCount: () => 1,
    getSessionId: () => 'test-session',
    addToolResults: () => {},
    recordToolHistory: () => {},
    buildRuntimeSnapshot: () => ({}),
    requestThetaCheck: () => {},
    getAutoReasoning: () => false,
    getReasoningEffort: () => undefined,
    setClientReasoningEffort: () => {},
    getSensorium: () => null,
    getReliabilityDecision: () => null,
    getTurnBudget: () => createTurnBudget(0),
  } as unknown as ToolExecutionDeps
  return new ToolExecutionController(deps)
}

function makeBatch(cwd: string, id: string, file: string, content: string): ToolExecBatchInput {
  return {
    toolUses: [{ id, name: 'write_file', input: { file_path: join(cwd, file), content } }],
    callbacks: { onToolResult: () => {} } as any,
    turn: 1,
    checkpointCreatedThisTurn: false,
    abortSignal: new AbortController().signal,
    traceStore: { events: [], toolFingerprints: [] } as any,
    importGraph: null,
    lastConflictCheckCount: 0,
    latestRisk: { level: 'none', reasons: [], suggestedAction: '' } as any,
  }
}

describe('冷库回落后台化（executeBatch 真实接线）', () => {
  let dir: string
  const cleanup: string[] = []
  function fixtureRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ig-batch-'))
    cleanup.push(dir)
    writeFileSync(join(dir, 'a.ts'), `import { b } from './b'\nexport const a = b\n`)
    writeFileSync(join(dir, 'b.ts'), `export const b = 1\n`)
    return dir
  }

  it('守卫：构建在飞（共享盒 building 非空）时不得重复点火', async () => {
    dir = fixtureRepo()
    try {
      const config = {} as AgentConfig
      // 预置「构建在飞」——初版守卫写在逐调用新建的 deps 包上恒 undefined，
      // 每次写都重复点火全扫（审查后果二）。共享盒下永不解除的 Promise 也必须挡住。
      const neverSettles = new Promise<void>(() => {})
      config.impactGraphState = { graph: null, building: neverSettles }
      const impacts: string[][] = []
      const evidence = { ...mockEvidence(), trackImpact: (f: string[], _t: string[]) => { impacts.push(f) } }
      const controller = makeController(dir, evidence as never, config)

      await controller.executeBatch(makeBatch(dir, 'tu-g1', 'b.ts', 'export const b = 2\n'))
      assert.equal(config.impactGraphState.building, neverSettles, '在飞构建不得被替换/重复点火')
      assert.equal(config.impactGraphState.graph, null)
      assert.equal(impacts.length, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('multiple actual write dispatches never start background impact discovery or expand verification', async () => {
    dir = fixtureRepo()
    try {
      let executions = 0, impacts = 0
      const config = {} as AgentConfig
      const controller = makeController(dir, { ...mockEvidence(), trackImpact: () => { impacts++ } } as never, config)
      config.toolRegistry.execute = async () => { executions++; return { content: 'written' } }
      await controller.executeBatch(makeBatch(dir, 'one', 'b.ts', 'export const b = 2'))
      await controller.executeBatch(makeBatch(dir, 'two', 'b.ts', 'export const b = 3'))
      assert.equal(executions, 2)
      assert.equal(config.impactGraphState, undefined)
      assert.equal(impacts, 0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
