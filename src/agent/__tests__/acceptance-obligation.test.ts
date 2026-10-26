/**
 * 交付前行为验收闸门（2026-07-25）。
 *
 * 补的是证据体系里缺失的一维：「验证跑在哪个层级」。既有三套机制共用
 * 「跑没跑过测试」这个二值谓词，任意一条 passed 单测就能把交付义务关掉——
 * 用户报的 PyQt5 场景（验了 go_back() 逻辑和信号链路就说修好了，从没模拟
 * 按 ESC 看弹窗）在旧体系里没有任何一道门看得见。
 *
 * 靶心用例复刻该场景：改非 UI 源文件 + 跑一条 passed 单测 → acceptance
 * 义务必须仍然未决，且续轮席位归它而不是 delivery。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { VerificationMetadata } from '../../tools/types.js'
import {
  applyProbeEvent,
  applyVerificationEvent,
  createObligation,
  decideAcceptanceOutcome,
  describeAction,
  evaluateFinalCandidate,
  firstActionFor,
  type ObligationStore,
} from '../evidence-obligation.js'
import { ObligationTracker } from '../obligation-tracker.js'
import { signalsFromObligations } from '../control-plane-adapters.js'

function passedUnitTest(over: Partial<VerificationMetadata> = {}): VerificationMetadata {
  return {
    command: 'python -m pytest tests/test_navigation.py',
    status: 'passed',
    scope: 'targeted',
    exitCode: 0,
    passed: 3,
    failed: 0,
    skipped: 0,
    durationMs: 120,
    ...over,
  }
}

function acceptanceObligation() {
  return createObligation({
    family: 'acceptance',
    claim: '本任务已通过用户级行为验收（声明的可观察完成标志已实际执行）',
    targets: [],
    risk: 'high',
  })
}

function deliveryObligation() {
  return createObligation({
    family: 'delivery',
    claim: '本任务修改的代码已通过相关验证',
    targets: [],
    risk: 'high',
  })
}

describe('acceptance 义务：跑测试关不掉（靶心）', () => {
  it('PyQt5 场景复刻：一条 passed 单测关掉 delivery，acceptance 仍未决但允许诚实结束', () => {
    const acceptance = acceptanceObligation()
    const delivery = deliveryObligation()
    const store: ObligationStore = { obligations: [delivery, acceptance] }

    const after = applyVerificationEvent(store, passedUnitTest())

    const deliveryAfter = after.obligations.find(o => o.family === 'delivery')!
    const acceptanceAfter = after.obligations.find(o => o.family === 'acceptance')!
    assert.equal(deliveryAfter.state, 'satisfied', '任意 passed 验证仍应关闭 delivery（既有语义不变）')
    assert.equal(acceptanceAfter.state, 'open', 'acceptance 绝不能被任意测试关闭——这是本机制的支点')

    const verdict = evaluateFinalCandidate(after)
    assert.equal(verdict.verdict, 'allow')
    assert.equal(verdict.nextAction, undefined)
    assert.equal(acceptanceAfter.requiredAction, 'user_acceptance')
  })

  it('跑多少次、跑 full scope 都关不掉 acceptance', () => {
    let store: ObligationStore = { obligations: [acceptanceObligation()] }
    store = applyVerificationEvent(store, passedUnitTest())
    store = applyVerificationEvent(store, passedUnitTest({ scope: 'full', command: 'npm test' }))
    store = applyVerificationEvent(store, passedUnitTest({ command: 'npm run typecheck' }))
    assert.equal(store.obligations[0]!.state, 'open')
  })

  it('探针也关不掉——applyProbeEvent 的家族过滤同样把 acceptance 排除在外', () => {
    const store: ObligationStore = { obligations: [acceptanceObligation()] }
    const after = applyProbeEvent(store, { tool: 'read_file', target: 'src/ui/dialog.py' })
    assert.equal(after.obligations[0]!.state, 'open')
  })
})

describe('验证记录保留，但不调度后续执行', () => {
  it('两个验证缺口都不自动续轮', () => {
    const acceptance = acceptanceObligation()
    const store: ObligationStore = { obligations: [deliveryObligation(), acceptance] }
    const verdict = evaluateFinalCandidate(store)
    assert.equal(verdict.nextAction, undefined)
  })

  it('任意入库顺序不产生验证续轮', () => {
    const acceptance = acceptanceObligation()
    const store: ObligationStore = { obligations: [acceptance, deliveryObligation()] }
    assert.equal(evaluateFinalCandidate(store).nextAction, undefined)
  })

  it('bugfix 和 acceptance 都只保留待验证状态', () => {
    const bugfix = createObligation({ family: 'bugfix', claim: '缺陷已复现并修复', risk: 'high' })
    const store: ObligationStore = { obligations: [acceptanceObligation(), bugfix] }
    assert.equal(evaluateFinalCandidate(store).nextAction, undefined)
  })

  it('历史续轮 latch 不恢复自动验证', () => {
    const tracker = new ObligationTracker()
    const acceptanceId = tracker.upsert({
      family: 'acceptance',
      claim: '本任务已通过用户级行为验收（声明的可观察完成标志已实际执行）',
      targets: [],
      risk: 'high',
    })
    tracker.upsert({ family: 'delivery', claim: '本任务修改的代码已通过相关验证', targets: [], risk: 'high' })

    const first = tracker.evaluateFinal()
    assert.equal(first.verdict, 'allow')
    assert.equal(first.nextAction, undefined)
    tracker.markContinued(acceptanceId)

    // 第二次收尾：unresolved[0] 仍是 acceptance 且已在 latch 里 → 直接降
    // honest_blocked，根本不会往下看 delivery。这正是 acceptance 必须排前面
    // 的真实理由——不是执行顺序，是席位分配。
    const second = tracker.evaluateFinal()
    assert.equal(second.verdict, 'allow')
    assert.equal(second.alreadyContinued, false)
  })
})

describe('核销状态机 decideAcceptanceOutcome', () => {
  it('空清单不产生判定', () => {
    assert.equal(decideAcceptanceOutcome([]), null)
  })

  it('仍有待执行项 → declared（只留痕，义务不关）', () => {
    const out = decideAcceptanceOutcome([
      { criterion: '按 ESC 后弹窗 isVisible() 为 False', status: 'met', evidence: 'QTest.keyPress 后断言通过' },
      { criterion: '取消后流程状态为 cancelled', status: 'pending' },
    ])
    assert.deepEqual(out, { kind: 'declared' })
  })

  it('标了 met 却没写 evidence → missing_evidence，不放行', () => {
    const out = decideAcceptanceOutcome([
      { criterion: '按 ESC 后弹窗消失', status: 'met' },
    ])
    assert.deepEqual(out, { kind: 'missing_evidence' })
  })

  it('evidence 只有空白等同没写', () => {
    const out = decideAcceptanceOutcome([
      { criterion: '按 ESC 后弹窗消失', status: 'met', evidence: '   ' },
    ])
    assert.deepEqual(out, { kind: 'missing_evidence' })
  })

  it('有受阻项且无待执行项 → blocked，理由带进披露文本', () => {
    const out = decideAcceptanceOutcome([
      { criterion: '按 ESC 后弹窗消失', status: 'blocked', evidence: '无 GUI 环境，QTest 起不来' },
    ])
    assert.equal(out?.kind, 'blocked')
    assert.match((out as { reason: string }).reason, /无 GUI 环境/)
  })

  it('受阻项没写原因时退回用 criterion 说明是哪条卡住', () => {
    const out = decideAcceptanceOutcome([
      { criterion: '按 ESC 后弹窗消失', status: 'blocked' },
    ])
    assert.match((out as { reason: string }).reason, /按 ESC 后弹窗消失/)
  })

  it('全部达标且有据 → met，evidence 汇入证据引用', () => {
    const out = decideAcceptanceOutcome([
      { criterion: '按 ESC 后弹窗 isVisible() 为 False', status: 'met', evidence: 'QTest.keyPress(ESC) 后 isVisible() == False' },
      { criterion: '流程状态为 cancelled', status: 'met', evidence: 'state == cancelled' },
    ])
    assert.equal(out?.kind, 'met')
    assert.match((out as { evidenceRef: string }).evidenceRef, /^acceptance:/)
    assert.match((out as { evidenceRef: string }).evidenceRef, /QTest\.keyPress/)
  })

  it('blocked 优先于 met——一条卡住就不算整体达标', () => {
    const out = decideAcceptanceOutcome([
      { criterion: 'a', status: 'met', evidence: '跑过了' },
      { criterion: 'b', status: 'blocked', evidence: '没环境' },
    ])
    assert.equal(out?.kind, 'blocked')
  })
})

describe('新家族的配套站点', () => {
  it('第一动作是 user_acceptance', () => {
    assert.equal(firstActionFor('acceptance'), 'user_acceptance')
  })

  it('措辞不是裸枚举名——续轮提醒会把它直接塞进中文句子', () => {
    const copy = describeAction('user_acceptance')
    assert.ok(copy.length > 10)
    assert.ok(!copy.includes('user_acceptance'))
    assert.match(copy, /acceptance 字段/)
  })

  it('VERIFY_FAMILIES 手工站点已补：控制面信号用 verify 动词而非 inspect', () => {
    const signals = signalsFromObligations({ obligations: [acceptanceObligation()] })
    assert.equal(signals.length, 1)
    assert.match(signals[0]!.key, /^obligation:verify:/)
  })

  it('义务块披露未验证，不要求模型立即补验证', () => {
    const tracker = new ObligationTracker()
    tracker.upsert({
      family: 'acceptance',
      claim: '本任务已通过用户级行为验收（声明的可观察完成标志已实际执行）',
      targets: [],
      risk: 'high',
    })
    const block = tracker.renderBlock()
    assert.match(block, /acceptance:/)
    assert.match(block, /时机由用户决定/)
    assert.doesNotMatch(block, /next=/)
  })
})
