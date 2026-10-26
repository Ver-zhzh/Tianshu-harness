import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createSelfVerifyHook, detectScopeMismatch, moduleOf, escalatedPriority, DEBT_ESCALATION_STEPS } from '../self-verify-hook.js'
import type { AdvisoryEntry } from '../../advisory-bus.js'
import type { RuntimeHookContext } from '../../runtime-hooks.js'
import type { VerificationMetadata } from '../../../tools/types.js'

function makeCtx(tools: Array<{ tool: string; status: 'success' | 'failed' | 'running'; target: string }>): RuntimeHookContext {
  return {
    snapshot: {
      cwd: '/test',
      turn: 3,
      recentToolHistory: tools,
      sensorium: null,
      strategy: null,
      vigor: null,
      gitChangeRate: 0,
      season: null,
    },
    effects: {
      setSensorium() {}, setStrategy() {}, setVigor() {},
      setGitChangeRate() {}, injectUserMessage() {},
      requestThetaCheck() {}, emitPhaseChange() {},
      emitDecisionShift() {}, markClaimStale() {},
    },
  }
}

describe('SelfVerifyHook', () => {
  it('fires when all tools are read-class with no verification', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSelfVerifyHook({
      advisoryBus: { submit(e: AdvisoryEntry) { submitted.push(e) } },
    })
    hook.run(makeCtx([
      { tool: 'read_file', status: 'success', target: 'src/a.ts' },
      { tool: 'grep', status: 'success', target: 'src/' },
      { tool: 'web_fetch', status: 'success', target: 'https://x.com' },
    ]))
    assert.equal(submitted.length, 1)
    assert.match(submitted[0]!.content, /没有独立验证/)
    assert.equal(submitted[0]!.category, 'discipline')
  })

  it('does NOT fire when a verify-class tool was used', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSelfVerifyHook({
      advisoryBus: { submit(e: AdvisoryEntry) { submitted.push(e) } },
    })
    hook.run(makeCtx([
      { tool: 'read_file', status: 'success', target: 'src/a.ts' },
      { tool: 'run_tests', status: 'success', target: 'src/' },
    ]))
    assert.equal(submitted.length, 0)
  })

  it('does NOT fire when bash actually verifies (tsc/test/lint/build)', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSelfVerifyHook({
      advisoryBus: { submit(e: AdvisoryEntry) { submitted.push(e) } },
    })
    hook.run(makeCtx([
      { tool: 'read_file', status: 'success', target: 'src/a.ts' },
      { tool: 'bash', status: 'success', target: 'tsc --noEmit' },
    ]))
    assert.equal(submitted.length, 0)
  })

  it('FIRES when bash is a non-verifying read (cat doc) — the core 看文档不验证 case', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSelfVerifyHook({
      advisoryBus: { submit(e: AdvisoryEntry) { submitted.push(e) } },
    })
    hook.run(makeCtx([
      { tool: 'read_file', status: 'success', target: 'src/a.ts' },
      { tool: 'bash', status: 'success', target: 'cat docs/design.md' },
    ]))
    assert.equal(submitted.length, 1)
    assert.match(submitted[0]!.content, /没有独立验证/)
  })

  it('does NOT fire when no tools were used', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSelfVerifyHook({
      advisoryBus: { submit(e: AdvisoryEntry) { submitted.push(e) } },
    })
    hook.run(makeCtx([]))
    assert.equal(submitted.length, 0)
  })

  it('fires when write tools used but no verify tools', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSelfVerifyHook({
      advisoryBus: { submit(e: AdvisoryEntry) { submitted.push(e) } },
    })
    // edit_file is write-class but NOT verify-class
    hook.run(makeCtx([
      { tool: 'edit_file', status: 'success', target: 'src/a.ts' },
    ]))
    assert.equal(submitted.length, 1)
    assert.match(submitted[0]!.content, /没有独立验证/)
  })

  // ── 浏览器/桌面视觉验证计为 ground truth（2026-07-15）──
  it('does NOT fire when browser_debug screenshot verified the UI', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSelfVerifyHook({
      advisoryBus: { submit(e: AdvisoryEntry) { submitted.push(e) } },
    })
    hook.run(makeCtx([
      { tool: 'edit_file', status: 'success', target: 'src/App.tsx' },
      { tool: 'browser_debug', status: 'success', target: 'screenshot' },
    ]))
    assert.equal(submitted.length, 0)
  })

  it('does NOT fire when browser_debug console/network gathered evidence', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSelfVerifyHook({
      advisoryBus: { submit(e: AdvisoryEntry) { submitted.push(e) } },
    })
    hook.run(makeCtx([
      { tool: 'edit_file', status: 'success', target: 'src/api.ts' },
      { tool: 'browser_debug', status: 'success', target: 'network http://localhost:3000/api' },
    ]))
    assert.equal(submitted.length, 0)
  })

  it('browser_debug open/navigate/click are operations, NOT verification', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSelfVerifyHook({
      advisoryBus: { submit(e: AdvisoryEntry) { submitted.push(e) } },
    })
    hook.run(makeCtx([
      { tool: 'edit_file', status: 'success', target: 'src/App.tsx' },
      { tool: 'browser_debug', status: 'success', target: 'navigate http://localhost:3000' },
    ]))
    // navigate 不是取证——但 browser_debug 未分类为 read/write，保守不触发
    // （isReadOrWriteCall 对未知工具返回 false → allReadOrWrite 为 false）
    assert.equal(submitted.length, 0)
  })

  it('does NOT fire when computer_use snapshot verified the desktop UI', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSelfVerifyHook({
      advisoryBus: { submit(e: AdvisoryEntry) { submitted.push(e) } },
    })
    hook.run(makeCtx([
      { tool: 'edit_file', status: 'success', target: 'src/window.ts' },
      { tool: 'computer_use', status: 'success', target: 'snapshot MyApp' },
    ]))
    assert.equal(submitted.length, 0)
  })
})

// ─── W5: 粗粒度验证-改动错配 ────────────────────────────────────

function verification(over: Partial<VerificationMetadata>): VerificationMetadata {
  return {
    command: 'npx tsx --test src/a/__tests__/a.test.ts',
    status: 'passed',
    scope: 'targeted',
    exitCode: 0,
    passed: 1,
    failed: 0,
    skipped: 0,
    durationMs: 10,
    ...over,
  }
}

describe('detectScopeMismatch (W5)', () => {
  it('moduleOf groups by the first two path segments', () => {
    assert.equal(moduleOf('src/agent/hooks/x.ts'), 'src/agent')
    assert.equal(moduleOf('src/tools/y.ts'), 'src/tools')
    assert.equal(moduleOf('main.ts'), 'main.ts')
    assert.equal(moduleOf('lib/z.ts'), 'lib')
  })

  it('flags mismatch: 3+ modules, all verifications targeted', () => {
    const result = detectScopeMismatch(
      new Set(['src/agent/a.ts', 'src/tools/b.ts', 'src/api/c.ts']),
      [verification({})],
    )
    assert.equal(result.mismatch, true)
    assert.equal(result.moduleCount, 3)
  })

  it('no mismatch when a full-scope verification exists', () => {
    const result = detectScopeMismatch(
      new Set(['src/agent/a.ts', 'src/tools/b.ts', 'src/api/c.ts']),
      [verification({}), verification({ scope: 'full', command: 'npm test' })],
    )
    assert.equal(result.mismatch, false)
  })

  it('no mismatch below the module threshold', () => {
    const result = detectScopeMismatch(
      new Set(['src/agent/a.ts', 'src/agent/hooks/b.ts', 'src/tools/c.ts']),
      [verification({})],
    )
    assert.equal(result.mismatch, false)
    assert.equal(result.moduleCount, 2)
  })

  it('no mismatch with zero verifications (零验证由既有检测覆盖)', () => {
    const result = detectScopeMismatch(
      new Set(['src/agent/a.ts', 'src/tools/b.ts', 'src/api/c.ts']),
      [],
    )
    assert.equal(result.mismatch, false)
  })
})

describe('SelfVerifyHook — scope mismatch advisory (W5)', () => {
  function makeEvidence(files: string[], verifications: VerificationMetadata[]) {
    return () => ({ filesModified: new Set(files), verifications })
  }

  it('submits scope-mismatch advisory when changes span 3+ modules with only targeted verifications', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSelfVerifyHook({
      advisoryBus: { submit(e: AdvisoryEntry) { submitted.push(e) } },
      getEvidenceState: makeEvidence(
        ['src/agent/a.ts', 'src/tools/b.ts', 'src/api/c.ts'],
        [verification({})],
      ),
    })
    hook.run(makeCtx([
      { tool: 'run_tests', status: 'success', target: 'src/a' },
    ]))
    const mismatch = submitted.filter(e => e.key === 'self-verify-scope-mismatch')
    assert.equal(mismatch.length, 1)
    assert.match(mismatch[0]!.content, /涉及 3 个模块/)
    assert.match(mismatch[0]!.content, /不要自动追加全量测试/)
    assert.equal(mismatch[0]!.tier, 'informational')
  })

  it('does not repeat the advisory for the same module count (nag 抑制)', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSelfVerifyHook({
      advisoryBus: { submit(e: AdvisoryEntry) { submitted.push(e) } },
      getEvidenceState: makeEvidence(
        ['src/agent/a.ts', 'src/tools/b.ts', 'src/api/c.ts'],
        [verification({})],
      ),
    })
    const ctx = makeCtx([{ tool: 'run_tests', status: 'success', target: 'src/a' }])
    hook.run(ctx)
    hook.run(ctx)
    const mismatch = submitted.filter(e => e.key === 'self-verify-scope-mismatch')
    assert.equal(mismatch.length, 1)
  })

  it('stays silent when a full-scope verification exists', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSelfVerifyHook({
      advisoryBus: { submit(e: AdvisoryEntry) { submitted.push(e) } },
      getEvidenceState: makeEvidence(
        ['src/agent/a.ts', 'src/tools/b.ts', 'src/api/c.ts'],
        [verification({ scope: 'full', command: 'npm test' })],
      ),
    })
    hook.run(makeCtx([{ tool: 'run_tests', status: 'success', target: 'src' }]))
    assert.equal(submitted.filter(e => e.key === 'self-verify-scope-mismatch').length, 0)
  })

  it('no getEvidenceState dep → unchanged behavior', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSelfVerifyHook({
      advisoryBus: { submit(e: AdvisoryEntry) { submitted.push(e) } },
    })
    hook.run(makeCtx([{ tool: 'run_tests', status: 'success', target: 'src' }]))
    assert.equal(submitted.length, 0)
  })
})

describe('W3 债龄阶梯（2026-07-25 advisory-ecology-repair）', () => {
  const READ_ONLY = [
    { tool: 'read_file', status: 'success' as const, target: 'src/a.ts' },
    { tool: 'grep', status: 'success' as const, target: 'src/' },
  ]

  it('escalatedPriority：<10 轮基线，≥10 轮 0.7，≥20 轮 0.79 封顶', () => {
    assert.equal(escalatedPriority(0.58, 0), 0.58)
    assert.equal(escalatedPriority(0.58, 9), 0.58)
    assert.equal(escalatedPriority(0.58, 10), 0.7)
    assert.equal(escalatedPriority(0.58, 19), 0.7)
    assert.equal(escalatedPriority(0.58, 20), 0.79)
    assert.equal(escalatedPriority(0.58, 100), 0.79, '封顶不再上浮')
    assert.equal(escalatedPriority(0.9, 20), 0.9, '基线更高时不降级')
  })

  it('封顶必须低于 efficacy fail-open 豁免线 0.8——陈债涨价但不豁免问责', () => {
    // advisory-bus 的负反馈环对 priority ≥ 0.8 fail-open；阶梯若越线，
    // 陈债提醒将永久逃逸「送达多次零采纳 → 冷却/静默」，重现 714c5d9b。
    for (const step of DEBT_ESCALATION_STEPS) {
      assert.ok(step.priority < 0.8, `阶梯档 ${step.priority} 必须 < 0.8`)
    }
  })

  it('债连续在场 → 计数陈化 → 提交 priority 上浮；债消失 → 清零回基线', () => {
    const submitted: AdvisoryEntry[] = []
    let debt = true
    const hook = createSelfVerifyHook({
      advisoryBus: { submit(e: AdvisoryEntry) { submitted.push(e) } },
      getVerificationDebt: () => debt,
    })

    // 债在场跑 10 轮（每轮 postTurn 计数一次）
    for (let i = 0; i < 10; i++) hook.run(makeCtx(READ_ONLY))
    const atTen = submitted.filter(e => e.key === 'self-verify').at(-1)!
    assert.equal(atTen.priority, 0.7, '债龄 ≥10 轮 → priority 上浮到 0.7')

    // 继续陈化到 20 轮
    for (let i = 0; i < 10; i++) hook.run(makeCtx(READ_ONLY))
    const atTwenty = submitted.filter(e => e.key === 'self-verify').at(-1)!
    assert.equal(atTwenty.priority, 0.79, '债龄 ≥20 轮 → priority 上浮到 0.79 封顶')

    // 债清偿 → 计数清零，下次触发回基线
    debt = false
    hook.run(makeCtx(READ_ONLY))
    debt = true
    hook.run(makeCtx(READ_ONLY))
    const afterReset = submitted.filter(e => e.key === 'self-verify').at(-1)!
    assert.equal(afterReset.priority, 0.58, '债消失即清零——计的是这笔债的驻留，不是会话累计')
  })

  it('阶梯只调 priority 不额外发条目——发射时机仍由 hook 自身判据决定', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSelfVerifyHook({
      advisoryBus: { submit(e: AdvisoryEntry) { submitted.push(e) } },
      getVerificationDebt: () => true,
    })
    // 债在场但每轮都有验证 → hook 判据不触发，债龄再高也零提交
    for (let i = 0; i < 25; i++) {
      hook.run(makeCtx([{ tool: 'run_tests', status: 'success', target: 'src' }]))
    }
    assert.equal(submitted.length, 0, '边沿纪律不破：债龄不制造新的发射时机')
  })

  it('无 getVerificationDebt dep → 阶梯禁用，priority 恒为基线', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSelfVerifyHook({
      advisoryBus: { submit(e: AdvisoryEntry) { submitted.push(e) } },
    })
    for (let i = 0; i < 25; i++) hook.run(makeCtx(READ_ONLY))
    assert.ok(submitted.length > 0)
    assert.ok(submitted.every(e => e.priority === 0.58), '缺省行为与旧版一致')
  })
})
