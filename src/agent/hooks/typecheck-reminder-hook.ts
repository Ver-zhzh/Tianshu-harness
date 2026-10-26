import type { PostTurnRuntimeHook, RuntimeHookContext } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'

/**
 * Typecheck-Reminder Hook — postTurn nudge that fills self-verify's blind spot.
 *
 * self-verify treats `run_tests` as "verified". But the test runner (tsx) and
 * the post-edit syntaxCheck both use esbuild, which only transpiles — it never
 * type-checks. So duplicate object keys, duplicate interface members, impossible
 * comparisons and dangling references from accidental deletions pass tests
 * green yet break `tsc`. This is exactly the failure mode that shipped a broken
 * typecheck while every test was green.
 *
 * Trigger (task-level, NOT the 5-entry window — see RuntimeHookSnapshot flags):
 *   touchedTsFiles            — a .ts/.tsx file was written this session
 *   ∧ !sawTypecheckThisTask   — no real `tsc`/typecheck has run since that edit
 *   ∧ run_tests in window     — the agent just verified via tests (a "done" moment)
 *
 * On trigger, discloses the missing check once. It never requests a check
 * as a prerequisite for committing or finishing and runs no tsc.
 */
export interface TypecheckReminderHookDeps {
  /** Only `submit` is used — narrowed for testability (interface segregation). */
  advisoryBus: Pick<AdvisoryBus, 'submit'>
}

export function createTypecheckReminderHook(deps: TypecheckReminderHookDeps): PostTurnRuntimeHook {
  let notified = false
  return {
    phase: 'postTurn',
    name: 'typecheck-reminder',
    run(ctx: RuntimeHookContext) {
      const { snapshot } = ctx
      if (!snapshot.touchedTsFiles) return
      if (snapshot.sawTypecheckThisTask) { notified = false; return }
      if (notified) return

      const ranTests = snapshot.recentToolHistory.some(h => h.tool === 'run_tests')
      if (!ranTests) return

      notified = true
      deps.advisoryBus.submit({
        key: 'typecheck-reminder',
        priority: 0.6,
        category: 'typecheck',
        tier: 'informational',
        content: '【天梁】你改了 TS 文件、跑了测试,但没跑类型检查。esbuild/tsx 只转译不查类型——重复键/重复成员/悬空引用都不会报。当前类型检查尚未执行，请如实披露；需要时由用户选择独立运行，不追加检查或阻止提交。',
        ttl: 1,
        observe: { turns: 1 },
      })
    },
  }
}
