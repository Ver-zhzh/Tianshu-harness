import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PromptEngine } from '../../prompt/engine.js'
import { STAR_DOMAINS } from '../star-domain-data.js'
import { createErrorDiagnosisHook } from '../hooks/error-diagnosis-hook.js'
import { createSelfVerifyHook } from '../hooks/self-verify-hook.js'
import { verificationAttempted } from '../verification-activity.js'
import { buildSystemPrompt } from '../../prompt/static.js'
import type { AdvisoryEntry } from '../advisory-bus.js'
import type { RuntimeHookContext, RuntimeToolEvent } from '../runtime-hooks.js'

describe('obstacle recovery at the actual prompt consumers', () => {
  for (const domain of ['taiyi', 'yaoguang'] as const) {
    it(`${domain} main request contains bounded recovery without changing published messages`, () => {
      const d = STAR_DOMAINS[domain]
      const engine = new PromptEngine({ model: 'deepseek-flash', maxTokens: 4096,
        staticCtx: { tools: [] }, volatileCtx: { cwd: '/fixture', activeDomain: { name: d.name, motto: d.motto, volatileBlock: d.volatileBlock } } })
      const history = [{ role: 'user' as const, content: '完成当前环境可执行的验证', origin: 'human' as const }]
      const first = engine.buildOaiRequest(history).messages
      const rendered = JSON.stringify(first)
      for (const pattern of [/obstacle-recovery/, /本次路径失败/, /授权.*凭据.*平台.*预算/, /不把代理结果.*原生通过/, /最短.*判别动作/]) {
        assert.ok(pattern.test(rendered), `main request must carry ${pattern}`)
      }
      assert.ok(rendered.includes(domain === 'taiyi' ? '缺少平台或凭据只暂停对应步骤' : '遇阻先确认最小环境和实际入口'), 'the domain recovery instruction must reach the main request')
      const second = engine.buildOaiRequest([...history, { role: 'assistant' as const, content: '已确认第一条失败路径' }]).messages
      assert.deepEqual(second.slice(0, first.length), first, 'a tool-loop continuation must retain the published bytes')
    })
  }

  it('static attribution does not equate isolated green or stale with external pollution', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('隔离单文件绿而全量红，只是定位范围的线索'))
    assert.ok(prompt.includes('stale 只说明验证绑定不再有效'))
    assert.ok(!prompt.includes('⇒ 外部阻塞/污染'))
    assert.ok(!prompt.includes('验证门禁已重置（编辑计数清零）'))
    assert.ok(!prompt.includes('门能跑但被影响面覆盖义务卡死'))
    assert.ok(prompt.includes('仍须满足所选文件的覆盖、版本和所有权检查'))
  })

  it('Yaoguang worker keeps negative reproduction separate from a repair acceptance', () => {
    const prompt = STAR_DOMAINS.yaoguang.systemPromptSuffix
    assert.match(prompt, /目标.*判断.*复现/)
    assert.match(prompt, /修复.*验收.*未复现.*状态/)
    assert.doesNotMatch(prompt, /stash\/worktree|复现成功或失败都是结论/)
  })

  for (const failureClass of ['missing_dep', 'env_missing', 'api_error'] as const) {
    it(`${failureClass} delivery does not turn a failure class into an exonerating cause`, () => {
      const entries: AdvisoryEntry[] = []
      const hook = createErrorDiagnosisHook({ advisoryBus: { submit: entry => entries.push(entry) } })
      hook.run({ snapshot: { turn: 1 } } as RuntimeHookContext,
        { name: 'bash', target: 'fixture-command', isError: true, success: false, failureClass, input: { command: 'fixture-command' } } as RuntimeToolEvent)
      assert.equal(entries.length, 1)
      assert.match(entries[0]!.content, /分类.*不等于根因/)
      assert.doesNotMatch(entries[0]!.content, /不是代码(?:逻辑)?问题|等待后重试即可/)
      if (failureClass === 'missing_dep') assert.match(entries[0]!.content, /项目.*入口/)
      if (failureClass === 'env_missing') assert.match(entries[0]!.content, /只报告字段名/)
    })
  }

  it('self-verify promises the same evidence it actually accounts, without broadening test coverage', () => {
    const entries: AdvisoryEntry[] = []
    const hook = createSelfVerifyHook({ advisoryBus: { submit: e => entries.push(e) } })
    hook.run({ snapshot: { cwd: '/fixture', turn: 3, recentToolHistory: [
      { tool: 'read_file', status: 'success', target: 'src/a.ts' },
      { tool: 'edit_file', status: 'success', target: 'src/a.ts' },
    ] } } as RuntimeHookContext)
    const entry = entries.find(e => e.key === 'self-verify')!
    assert.ok(entry)
    assert.equal(entry.expect?.kind, 'verify_attempted')
    assert.match(entry.content, /不补测试.*义务/)
    assert.doesNotMatch(entry.content, /跑测试\/读原文\/用原输入自检/)
    assert.equal(verificationAttempted('read_file', { file_path: 'src/a.ts' }), false)
    assert.equal(verificationAttempted('browser_debug', { action: 'observe' }), false)
    assert.equal(verificationAttempted('run_tests', {}), true)
  })
})
