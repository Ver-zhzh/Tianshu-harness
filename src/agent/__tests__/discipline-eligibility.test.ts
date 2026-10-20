import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveDisciplineEligibility,
  detectProblemSignal,
  noteEligibilityMissing,
  __resetEligibilityMissingForTest,
  type DisciplineEligibility,
} from '../discipline-eligibility.js'
import type { IntentTaskKind } from '../intent-retrieval-route.js'
import type { TurnMode } from '../../context/task-contract.js'

function e(input: {
  turnMode?: TurnMode
  taskKinds?: readonly IntentTaskKind[]
  explicitNoMutation?: boolean
  mentionedCodeFileCount?: number
  problemSignal?: boolean
}): DisciplineEligibility {
  return deriveDisciplineEligibility({
    turnMode: input.turnMode ?? 'task',
    taskKinds: input.taskKinds ?? [],
    explicitNoMutation: input.explicitNoMutation,
    mentionedCodeFileCount: input.mentionedCodeFileCount,
    problemSignal: input.problemSignal,
  })
}

describe('deriveDisciplineEligibility — discriminant matrix', () => {
  for (const turnMode of ['task', 'followUp'] as const) {
    for (const taskKinds of [[], ['social_idle']] as const) {
      for (const mentionedCodeFileCount of [1, 2]) {
        it(`explicitNoMutation overrides fallback: ${turnMode}, ${taskKinds.length} kinds, ${mentionedCodeFileCount} files`, () => {
          const d = e({ turnMode, taskKinds, mentionedCodeFileCount, problemSignal: true, explicitNoMutation: true })
          assert.equal(d.requiresEngineeringDiscipline, false)
          assert.equal(d.requiresCodeVerification, false)
          assert.equal(d.canSuggestPlan, false)
          assert.equal(d.canDispatch, false)
          assert.equal(d.projectionMode, 'light')
        })
      }
    }
  }
  // ── chat / social ──
  it('chat + social_idle → all false, projection none', () => {
    const d = e({ turnMode: 'chat', taskKinds: ['social_idle'] })
    assert.equal(d.responseActionable, false)
    assert.equal(d.requiresEngineeringDiscipline, false)
    assert.equal(d.requiresCodeVerification, false)
    assert.equal(d.canSuggestPlan, false)
    assert.equal(d.canDispatch, false)
    assert.equal(d.projectionMode, 'none')
  })

  it('chat mode forces none regardless of taskKinds', () => {
    const d = e({ turnMode: 'chat', taskKinds: ['bug_fix'] })
    assert.equal(d.requiresEngineeringDiscipline, false)
    assert.equal(d.projectionMode, 'none')
  })

  // ── usage question ──
  it('usage_question → light, no engineering', () => {
    const d = e({ taskKinds: ['usage_question'] })
    assert.equal(d.responseActionable, true)
    assert.equal(d.requiresEngineeringDiscipline, false)
    assert.equal(d.requiresCodeVerification, false)
    assert.equal(d.canSuggestPlan, false)
    assert.equal(d.projectionMode, 'light')
  })

  // ── code explanation ──
  it('code_explanation → light, repo read allowed, no code verification', () => {
    const d = e({ taskKinds: ['code_explanation'] })
    assert.equal(d.responseActionable, true)
    assert.equal(d.requiresEngineeringDiscipline, false)
    assert.equal(d.requiresCodeVerification, false)
    assert.equal(d.canSuggestPlan, false)
    assert.equal(d.canDispatch, false)
    assert.equal(d.projectionMode, 'light')
  })

  it('code_explanation + explicitNoMutation → still light, no engineering', () => {
    const d = e({ taskKinds: ['code_explanation'], explicitNoMutation: true })
    assert.equal(d.requiresEngineeringDiscipline, false)
    assert.equal(d.requiresCodeVerification, false)
    assert.equal(d.projectionMode, 'light')
  })

  // ── architecture / analysis ──
  it('architecture_design → light, no engineering', () => {
    const d = e({ taskKinds: ['architecture_design'] })
    assert.equal(d.requiresEngineeringDiscipline, false)
    assert.equal(d.requiresCodeVerification, false)
    assert.equal(d.projectionMode, 'light')
  })

  it('codebase_overview → light, no engineering', () => {
    const d = e({ taskKinds: ['codebase_overview'] })
    assert.equal(d.requiresEngineeringDiscipline, false)
    assert.equal(d.projectionMode, 'light')
  })

  // ── engineering tasks ──
  it('bug_fix → engineering + code verification', () => {
    const d = e({ taskKinds: ['bug_fix'] })
    assert.equal(d.responseActionable, true)
    assert.equal(d.requiresEngineeringDiscipline, true)
    assert.equal(d.requiresCodeVerification, true)
    assert.equal(d.canSuggestPlan, true)
    assert.equal(d.canDispatch, true)
    assert.equal(d.projectionMode, 'engineering')
  })

  it('refactor → engineering + code verification', () => {
    const d = e({ taskKinds: ['refactor'] })
    assert.equal(d.requiresEngineeringDiscipline, true)
    assert.equal(d.requiresCodeVerification, true)
    assert.equal(d.projectionMode, 'engineering')
  })

  it('new_feature → engineering + code verification', () => {
    const d = e({ taskKinds: ['new_feature'] })
    assert.equal(d.requiresEngineeringDiscipline, true)
    assert.equal(d.requiresCodeVerification, true)
    assert.equal(d.projectionMode, 'engineering')
  })

  it('performance_diagnosis → engineering, code verification optional', () => {
    const d = e({ taskKinds: ['performance_diagnosis'] })
    assert.equal(d.requiresEngineeringDiscipline, true)
    assert.equal(d.requiresCodeVerification, false) // diagnosis is read-heavy
    assert.equal(d.projectionMode, 'engineering')
  })

  // ── verification / audit ──
  it('verification → evidence, no code verification, no TDD obligation', () => {
    const d = e({ taskKinds: ['verification'] })
    assert.equal(d.responseActionable, true)
    assert.equal(d.allowsEvidenceReview, true)
    assert.equal(d.requiresEngineeringDiscipline, false)
    assert.equal(d.requiresCodeVerification, false)
    assert.equal(d.canSuggestPlan, false)
    assert.equal(d.projectionMode, 'evidence')
  })

  it('review_audit → evidence, no TDD requirement', () => {
    const d = e({ taskKinds: ['review_audit'] })
    assert.equal(d.allowsEvidenceReview, true)
    assert.equal(d.requiresCodeVerification, false)
    assert.equal(d.projectionMode, 'evidence')
  })

  it('security_safety → evidence + repo read, fail-closed safety gate', () => {
    const d = e({ taskKinds: ['security_safety'] })
    assert.equal(d.allowsEvidenceReview, true)
    // security is not general engineering — it has its own gate
    assert.equal(d.requiresEngineeringDiscipline, false)
    assert.equal(d.requiresCodeVerification, false)
    assert.equal(d.projectionMode, 'evidence')
  })

  // ── followUp semantics ──
  it('followUp + engineering taskKind → engineering', () => {
    const d = e({ turnMode: 'followUp', taskKinds: ['bug_fix'] })
    assert.equal(d.requiresEngineeringDiscipline, true)
    assert.equal(d.requiresCodeVerification, true)
  })

  it('followUp + explanation → no engineering', () => {
    const d = e({ turnMode: 'followUp', taskKinds: ['code_explanation'] })
    assert.equal(d.requiresEngineeringDiscipline, false)
    assert.equal(d.requiresCodeVerification, false)
  })

  // ── explicitNoMutation override ──
  it('explicitNoMutation overrides engineering kind → light', () => {
    const d = e({ taskKinds: ['bug_fix'], explicitNoMutation: true })
    assert.equal(d.requiresEngineeringDiscipline, false)
    assert.equal(d.requiresCodeVerification, false)
    assert.equal(d.projectionMode, 'light')
  })

  it('explicitNoMutation does not affect already-non-engineering kinds', () => {
    const d = e({ taskKinds: ['code_explanation'], explicitNoMutation: true })
    assert.equal(d.requiresEngineeringDiscipline, false)
    assert.equal(d.projectionMode, 'light')
  })

  // ── multi-kind disambiguation ──
  it('bug_fix + code_explanation → engineering wins (action dominates)', () => {
    const d = e({ taskKinds: ['bug_fix', 'code_explanation'] })
    assert.equal(d.requiresEngineeringDiscipline, true)
    assert.equal(d.requiresCodeVerification, true)
    assert.equal(d.projectionMode, 'engineering')
  })

  it('code_explanation + review_audit → no engineering, review evidence', () => {
    const d = e({ taskKinds: ['code_explanation', 'review_audit'] })
    assert.equal(d.requiresEngineeringDiscipline, false)
    assert.equal(d.requiresCodeVerification, false)
    assert.equal(d.allowsEvidenceReview, true)
    // evidence wins over light when review_audit present
    assert.equal(d.projectionMode, 'evidence')
  })

  it('security_safety + bug_fix → engineering + evidence', () => {
    const d = e({ taskKinds: ['security_safety', 'bug_fix'] })
    assert.equal(d.requiresEngineeringDiscipline, true)
    assert.equal(d.allowsEvidenceReview, true)
    assert.equal(d.projectionMode, 'engineering')
  })

  // ── empty / default ──
  it('empty taskKinds → light, no engineering (conservative de-escalation)', () => {
    const d = e({ taskKinds: [] })
    assert.equal(d.responseActionable, true)
    assert.equal(d.requiresEngineeringDiscipline, false)
    assert.equal(d.requiresCodeVerification, false)
    assert.equal(d.canSuggestPlan, false)
    assert.equal(d.projectionMode, 'light')
  })

  it('empty taskKinds + ≥2 code files → engineering (safety net)', () => {
    // intent router 漏判但用户明确提到多个代码文件 → 保守升级
    const d = e({ taskKinds: [], mentionedCodeFileCount: 2 })
    assert.equal(d.requiresEngineeringDiscipline, true)
    assert.equal(d.requiresCodeVerification, true)
    assert.equal(d.canSuggestPlan, true)
    assert.equal(d.projectionMode, 'engineering')
  })

  it('empty taskKinds + 1 code file → still light (below safety threshold)', () => {
    const d = e({ taskKinds: [], mentionedCodeFileCount: 1 })
    assert.equal(d.requiresEngineeringDiscipline, false, 'single file mention is too weak for safety net')
    assert.equal(d.projectionMode, 'light')
  })

  // ── structural invariants ──
  it('requiresCodeVerification implies requiresEngineeringDiscipline', () => {
    const allKinds: IntentTaskKind[] = [
      'bug_fix', 'refactor', 'new_feature', 'performance_diagnosis',
      'code_explanation', 'usage_question', 'codebase_overview',
      'architecture_design', 'review_audit', 'verification',
      'security_safety', 'social_idle',
    ]
    for (const kind of allKinds) {
      const d = e({ taskKinds: [kind] })
      if (d.requiresCodeVerification) {
        assert.ok(d.requiresEngineeringDiscipline,
          `${kind}: requiresCodeVerification → requiresEngineeringDiscipline`)
      }
    }
  })

  it('projectionMode none → no actionable signals', () => {
    const d = e({ turnMode: 'chat', taskKinds: ['social_idle'] })
    if (d.projectionMode === 'none') {
      assert.equal(d.responseActionable, false)
      assert.equal(d.canSuggestPlan, false)
      assert.equal(d.canDispatch, false)
    }
  })

  it('engineering projectionMode → requiresEngineeringDiscipline', () => {
    const d = e({ taskKinds: ['bug_fix'] })
    if (d.projectionMode === 'engineering') {
      assert.ok(d.requiresEngineeringDiscipline)
    }
  })
})


// ── safety net 次级触发（窗口 1：单文件 bug 报告）+ 缺省遥测 ──────────────

describe('safety net — problemSignal second trigger', () => {
  it('empty taskKinds + 1 code file + problemSignal → engineering', () => {
    // "看看 src/auth.ts 登录有点怪"——单文件 bug 报告不再漏网
    const d = e({ taskKinds: [], mentionedCodeFileCount: 1, problemSignal: true })
    assert.equal(d.requiresEngineeringDiscipline, true)
    assert.equal(d.requiresCodeVerification, true)
    assert.equal(d.projectionMode, 'engineering')
  })

  it('empty taskKinds + 1 code file, no problemSignal → light (解释类不误升级)', () => {
    const d = e({ taskKinds: [], mentionedCodeFileCount: 1, problemSignal: false })
    assert.equal(d.requiresEngineeringDiscipline, false)
    assert.equal(d.projectionMode, 'light')
  })

  it('empty taskKinds + problemSignal but no file → light (信号无锚点不升级)', () => {
    const d = e({ taskKinds: [], mentionedCodeFileCount: 0, problemSignal: true })
    assert.equal(d.requiresEngineeringDiscipline, false)
    assert.equal(d.projectionMode, 'light')
  })
})

describe('detectProblemSignal', () => {
  it('matches problem phrasings', () => {
    for (const s of ['登录有点怪', '这里不对', '报错了', '一直失败', 'weird behavior', 'there is a bug', 'it crashes']) {
      assert.equal(detectProblemSignal(s), true, s)
    }
  })
  it('does not match neutral/explanation phrasings', () => {
    for (const s of ['解释 loop.ts 的逻辑', '这个设计怎么看', '怎么用 delegate_task']) {
      assert.equal(detectProblemSignal(s), false, s)
    }
  })
})

describe('noteEligibilityMissing', () => {
  it('reports once per source, then dedups', () => {
    __resetEligibilityMissingForTest()
    assert.equal(noteEligibilityMissing('test-source-a'), true)
    assert.equal(noteEligibilityMissing('test-source-a'), false)
    assert.equal(noteEligibilityMissing('test-source-b'), true)
    __resetEligibilityMissingForTest()
  })
})
