/**
 * 工具表构造期锁死回归（2026-10-16，issue #500 根因修复）。
 *
 * 背景：resume 构造期 `toolCatalogPublished = !!executionSnapshot`
 * （原 `src/prompt/engine.ts:316`）曾把工具表永久锁死——LSP 晚到注册的
 * 合法 updateTools 失效，wire 工具表停在装配瞬间，与 prior 分裂，
 * 守卫 fail-closed 拒发（ContinuationPrefixError('tools')）。
 *
 * 本文件固化的三条契约：
 *   ① resume 继承后、首请求上网前：updateTools 必须生效（修复前红——issue #500 根因）
 *   ② 请求 proof 提交后（工具表已上网）：updateTools 被挡——有意冻结，防回潮
 *   ③ effort/compact 授权（authorizeCacheGeneration）是窄授权：只放宽连续性校验，
 *      不清除已发布工具表的冻结（10-13 b048444ff 契约；issue #500 修复评估后保留）
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PromptEngine } from '../engine.js'
import { proveWirePrefix } from '../../api/continuation-prefix.js'
import type { ToolDefinition } from '../../api/types.js'

function mkTool(name: string): ToolDefinition {
  return { name, description: `${name} tool`, input_schema: { type: 'object', properties: {} } } as ToolDefinition
}

function mkEngine(tools: ToolDefinition[], inherit?: PromptEngine): PromptEngine {
  return new PromptEngine({
    model: 'test-model',
    maxTokens: 4096,
    staticCtx: { tools },
    volatileCtx: { cwd: '/repo' },
    habituationThreshold: 0,
    ...(inherit ? { inheritFrozenFrom: inherit } : {}),
  })
}

/** 模拟一次成功请求的 proof 提交——走 engine 的真实提交钩子（buildOaiRequest → onExecutionSnapshot）。 */
function commitProof(engine: PromptEngine): void {
  const request = engine.buildOaiRequest([{ role: 'user', content: 'hello' }])
  const proof = {
    ...proveWirePrefix(
      { model: 'test-model', messages: request.messages as never[], tools: request.tools ?? [] },
      'fixture',
      'req-1',
    ),
    cacheGenerationId: 'gen-a',
    credentialScope: 'fixture:default',
  }
  ;(request.onExecutionSnapshot as ((p: unknown) => void | Promise<void>) | undefined)?.(proof)
}

describe('工具表构造期锁死（issue #500）', () => {
  it('① resume 继承后、首请求上网前：updateTools 必须生效', () => {
    const a = mkEngine([mkTool('t1')])
    commitProof(a) // 会话 A 已发生过请求 → executionSnapshot 存在（resume 的前提）
    const b = mkEngine([], a) // resume 装配：继承 A 的 frozen 快照，装配瞬间工具表为空（LSP 未就绪）

    b.updateTools([mkTool('t1'), mkTool('t2')]) // LSP 晚到注册 → agent.updateTools()

    assert.equal(
      b.getTools().length,
      2,
      'resume 后、首请求上网前的合法工具表更新不得被构造期锁死（修复前此处恒 0）',
    )
  })

  it('② 请求 proof 提交后（已上网）：updateTools 被挡（有意冻结）', () => {
    const e = mkEngine([mkTool('t1')])
    e.updateTools([mkTool('t1'), mkTool('t2')]) // 上网前：生效
    assert.equal(e.getTools().length, 2)

    commitProof(e) // 首次请求上网 → 工具表定稿

    e.updateTools([mkTool('t1'), mkTool('t2'), mkTool('t3')])
    assert.equal(e.getTools().length, 2, '已上网会话工具表必须冻结——宁可新工具本会话不生效，也不碎前缀')
  })

  it('③ effort 授权是窄授权：不清除已发布工具表的冻结（10-13 b048444ff 契约）', () => {
    const e = mkEngine([mkTool('t1')])
    commitProof(e) // 已上网 → 冻结
    e.updateTools([mkTool('t1'), mkTool('t2')])
    assert.equal(e.getTools().length, 1)

    e.authorizeCacheGeneration() // effort/compact 授权：只放宽连续性校验，不放宽工具冻结

    e.updateTools([mkTool('t1'), mkTool('t2')])
    assert.equal(
      e.getTools().length,
      1,
      '已发布工具表在 effort 授权后仍冻结——窄授权；工具表变更需独立授权路径（engine.test.ts 同契约）',
    )
  })
})
