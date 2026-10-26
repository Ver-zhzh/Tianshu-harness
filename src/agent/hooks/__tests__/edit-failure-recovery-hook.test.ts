import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createEditFailureRecoveryHook } from '../edit-failure-recovery-hook.js'
import type { AdvisoryEntry } from '../../advisory-bus.js'
import type { RuntimeHookContext, RuntimeToolEvent } from '../../runtime-hooks.js'

function makeCtx(turn: number): RuntimeHookContext {
  return {
    snapshot: {
      cwd: '/fake',
      turn,
      recentToolHistory: [],
      sensorium: null,
    },
    effects: {},
  } as unknown as RuntimeHookContext
}

function makeTool(name: string, success: boolean, filePath?: string): RuntimeToolEvent {
  return {
    name,
    success,
    isError: !success,
    input: filePath ? { file_path: filePath } : undefined,
  } as unknown as RuntimeToolEvent
}

describe('createEditFailureRecoveryHook', () => {
  it('does not fire on first edit failure', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createEditFailureRecoveryHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeTool('edit_file', false, 'src/foo.ts'))
    assert.equal(submitted.length, 0)
  })

  it('fires on second consecutive failure on same file', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createEditFailureRecoveryHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeTool('edit_file', false, 'src/foo.ts'))
    hook.run(makeCtx(1), makeTool('edit_file', false, 'src/foo.ts'))
    assert.equal(submitted.length, 1)
    assert.equal(submitted[0]!.key, 'edit-failure-recovery:src/foo.ts')
    assert.equal(submitted[0]!.category, 'repair')
    assert.doesNotMatch(submitted[0]!.content, /调用 undo|全量覆写/)
    assert.match(submitted[0]!.content, /expected_version/)
    assert.match(submitted[0]!.content, /精确捕获/)
  })

  it('fires for mixed edit tools on the same file', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createEditFailureRecoveryHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeTool('edit_file', false, 'src/foo.ts'))
    hook.run(makeCtx(1), makeTool('hash_edit', false, 'src/foo.ts'))
    assert.equal(submitted.length, 1)
  })

  it('does not fire for failures on different files', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createEditFailureRecoveryHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeTool('edit_file', false, 'src/a.ts'))
    hook.run(makeCtx(1), makeTool('edit_file', false, 'src/b.ts'))
    assert.equal(submitted.length, 0)
  })

  it('resets count on success', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createEditFailureRecoveryHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeTool('edit_file', false, 'src/foo.ts'))
    hook.run(makeCtx(1), makeTool('edit_file', true, 'src/foo.ts'))
    hook.run(makeCtx(1), makeTool('edit_file', false, 'src/foo.ts'))
    assert.equal(submitted.length, 0)
  })

  it('ignores non-edit tools', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createEditFailureRecoveryHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeTool('read_file', false, 'src/foo.ts'))
    hook.run(makeCtx(1), makeTool('read_file', false, 'src/foo.ts'))
    assert.equal(submitted.length, 0)
  })

  it('same unresolved failure produces only one actionable recovery suggestion', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createEditFailureRecoveryHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeTool('edit_file', false, 'src/foo.ts'))
    hook.run(makeCtx(1), makeTool('edit_file', false, 'src/foo.ts'))
    hook.run(makeCtx(1), makeTool('edit_file', false, 'src/foo.ts'))
    assert.equal(submitted.length, 1)
  })

  const PATCH_DIFF = 'diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new\n'

  function makePatchTool(success: boolean): RuntimeToolEvent {
    return {
      name: 'apply_patch',
      success,
      isError: !success,
      input: { diff: PATCH_DIFF },
    } as unknown as RuntimeToolEvent
  }

  it('apply_patch：第二次失败触发补丁专用建议（不再推荐 apply_patch 自己）', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createEditFailureRecoveryHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makePatchTool(false))
    assert.equal(submitted.length, 0)
    hook.run(makeCtx(1), makePatchTool(false))
    assert.equal(submitted.length, 1)
    assert.equal(submitted[0]!.key, 'edit-failure-recovery:src/foo.ts')
    assert.match(submitted[0]!.content, /read_file/)
    assert.match(submitted[0]!.content, /edit_file/)
    assert.doesNotMatch(submitted[0]!.content, /改用 apply_patch/)
  })

  it('apply_patch：成功后重置计数', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createEditFailureRecoveryHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makePatchTool(false))
    hook.run(makeCtx(1), makePatchTool(true))
    hook.run(makeCtx(1), makePatchTool(false))
    assert.equal(submitted.length, 0)
  })

  it('apply_patch：无 diff 输入时忽略', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createEditFailureRecoveryHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    const empty = { name: 'apply_patch', success: false, isError: true, input: {} } as unknown as RuntimeToolEvent
    hook.run(makeCtx(1), empty)
    hook.run(makeCtx(1), empty)
    assert.equal(submitted.length, 0)
  })
})
