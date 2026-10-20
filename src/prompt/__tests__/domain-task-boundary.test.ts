import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PromptEngine } from '../engine.js'
import { STAR_DOMAINS } from '../../agent/star-domain-data.js'
import { parseFrozenSnapshotData } from '../frozen-snapshot.js'
import type { OaiMessage } from '../../api/oai-types.js'

const custom = { name: 'Release analyst', motto: 'Check the observable result', volatileBlock: 'Inspect release risks.' }
const tools = [{ name: 'edit_file', description: 'Edit a file', input_schema: { type: 'object' as const, properties: {} } }]

function makeEngine(domain = custom, audience?: 'subagent') {
  return new PromptEngine({ model: 'test-model', maxTokens: 4096,
    staticCtx: { tools, audience }, volatileCtx: { cwd: '/consumer-project', activeDomain: domain } })
}

function boundary(messages: readonly OaiMessage[]): string {
  const wire = rendered(messages)
  const blocks = wire.match(/<domain-task-boundary>[\s\S]*?<\/domain-task-boundary>/g) ?? []
  assert.equal(blocks.length, 1, 'actual request must contain exactly one shared responsibility boundary')
  return blocks[0]!
}

function rendered(messages: readonly OaiMessage[]): string {
  return messages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n')
}

describe('domain methodology stays within the current task', () => {
  for (const [id, domain] of [...Object.entries(STAR_DOMAINS), ['custom', custom] as const]) {
    for (const audience of [undefined, 'subagent'] as const) {
      it(`${id}: ${audience ?? 'main'} actual request carries task and permission boundaries`, () => {
        const engine = makeEngine(domain, audience)
        const req = engine.buildOaiRequest([{ role: 'user', content: 'Implement the requested change.' }])
        const block = boundary(req.messages)
        assert.ok(block.length <= 800, 'shared task rules must stay bounded to avoid diluting domain attention')
        for (const section of ['task-source', 'review', 'implementation', 'verification', 'unclear', 'continuation', 'authority']) {
          assert.ok(block.includes(`id="${section}"`), `missing structured rule: ${section}`)
        }
        assert.match(block, /星域提供方法.*不替换任务/)
        assert.match(block, /不能用提名或建议代替实施交付/)
        assert.match(block, /不要求为验证而修改文件/)
        assert.match(block, /未知.*不推定修改许可/)
        assert.match(block, /审批.*所有权.*沙箱/)
        assert.equal(req.tools?.some(t => t.function.name === 'edit_file'), true, 'prompt policy must not silently alter tool authority')
        assert.ok(rendered(req.messages).includes(domain.volatileBlock), 'original methodology must still reach the request')
      })
    }
  }

  it('Qisha nomination-only completion is explicitly limited to subtraction review', () => {
    const req = makeEngine(STAR_DOMAINS.qisha).buildOaiRequest([{ role: 'user', content: 'Fix and verify the requested behavior.' }])
    const wire = rendered(req.messages)
    assert.ok(wire.includes('以下提名与报告的交付标准仅适用于减法审查'), 'Qisha review-only completion needs an explicit scope')
    assert.ok(wire.includes('明确要求实施、修复或验证时，按当前任务目标交付'))
  })

  it('task text, language, repository instructions and package layout do not select a different policy', () => {
    const tasks = ['Review the Rust crate; do not edit.', '修复 Python 数据清洗脚本并验证', 'Verify the SQL migration only.', '继续', 'Investigate the failing service.']
    const blocks = tasks.map(content => boundary(makeEngine().buildOaiRequest([{ role: 'user', content }]).messages))
    assert.ok(blocks.every(b => b === blocks[0]), 'conditional rules are not an inferred permission or a task classifier')
    assert.doesNotMatch(blocks[0]!, /AGENTS\.md|Tianshu-harness|pnpm|pytest|revit|DeepSeek|1017/)
  })

  it('review → implementation → verification and identical continuations preserve published history', () => {
    const engine = makeEngine(STAR_DOMAINS.qisha)
    const history: OaiMessage[] = [{ role: 'user', content: 'Only review; do not modify files.', origin: 'human' }]
    let previous = engine.buildOaiRequest(history).messages
    for (const text of ['Implement the reviewed fix now.', 'Verify only; do not edit.', '继续', '继续']) {
      history.push({ role: 'assistant', content: 'Acknowledged.' }, { role: 'user', content: text, origin: 'human' })
      const current = engine.buildOaiRequest(history).messages
      assert.deepEqual(current.slice(0, previous.length), previous, 'new task stages must not rewrite earlier rendered instructions')
      previous = current
    }
    const snapshot = parseFrozenSnapshotData(JSON.parse(JSON.stringify(engine.exportFrozenSnapshot())))
    assert.ok(snapshot)
    const restored = new PromptEngine({ model: 'test-model', maxTokens: 4096, staticCtx: { tools },
      volatileCtx: { cwd: '/another-consumer-project', activeDomain: custom }, inheritFrozenFrom: snapshot })
    const resumed = restored.buildOaiRequest([...history, { role: 'assistant', content: 'Ready.' }, { role: 'user', content: 'Continue verification.', origin: 'human' }])
    assert.deepEqual(resumed.messages.slice(0, previous.length), previous, 'snapshot restore must retain published bytes despite a new domain')
  })

  it('domain changes during a tool loop wait for a new input boundary', () => {
    const engine = makeEngine(STAR_DOMAINS.qisha)
    const history: OaiMessage[] = [{ role: 'user', content: 'Review the release.' }]
    const first = engine.buildOaiRequest(history).messages
    engine.setActiveDomain(custom)
    const next = engine.buildOaiRequest([...history, { role: 'assistant', content: 'Checking.' }]).messages
    assert.deepEqual(next.slice(0, first.length), first)
    const changed = engine.buildOaiRequest([...history, { role: 'assistant', content: 'Reviewed.' }, { role: 'user', content: 'Implement the change.' }]).messages
    assert.ok(JSON.stringify(changed).includes(custom.volatileBlock))
    boundary(first)
  })

  it('legacy frozen messages gain no retroactive policy; only the new input receives current rules', () => {
    const legacy = new PromptEngine({ model: 'test-model', maxTokens: 4096, staticCtx: { tools },
      volatileCtx: { cwd: '/old-consumer-project' } })
    const history: OaiMessage[] = [{ role: 'user', content: 'Review without changes.' }, { role: 'assistant', content: 'Reviewed.' }]
    const old = legacy.buildOaiRequest(history).messages
    assert.ok(!rendered(old).includes('<domain-task-boundary>'))
    const restored = new PromptEngine({ model: 'test-model', maxTokens: 4096, staticCtx: { tools },
      volatileCtx: { cwd: '/consumer-project', activeDomain: STAR_DOMAINS.qisha },
      inheritFrozenFrom: JSON.parse(JSON.stringify(legacy.exportFrozenSnapshot())) })
    const next = restored.buildOaiRequest([...history, { role: 'user', content: 'Implement the reviewed fix.' }]).messages
    assert.deepEqual(next.slice(0, old.length), old, 'current policy must not be inserted into old rendered messages')
    boundary(next)
  })
})
