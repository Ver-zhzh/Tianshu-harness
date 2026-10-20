import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ARMS, SCENARIOS, balancedOrder, recoveryEntry, SCOPE_CANDIDATE } from '../experiments/domain-recovery-policy.js'

const home = mkdtempSync(join(tmpdir(), 'rivet-recovery-test-'))
const saved = { RIVET_HOME: process.env.RIVET_HOME, RIVET_SESSION_DIR: process.env.RIVET_SESSION_DIR, RIVET_RTK: process.env.RIVET_RTK }
process.env.RIVET_HOME = home; process.env.RIVET_SESSION_DIR = join(home, 'sessions'); process.env.RIVET_RTK = '0'
writeFileSync(join(home, 'config.json'), '{}')
const { RecoveryWorld } = await import('../experiments/domain-recovery-world.js')
const { PromptEngine } = await import('../../src/prompt/engine.js')
const { STAR_DOMAINS } = await import('../../src/agent/star-domain-data.js')
const { AdvisoryBus } = await import('../../src/agent/advisory-bus.js')
after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }; rmSync(home, { recursive: true, force: true }) })

test('factorial order is reproducible and includes each pair once', () => {
  const order = balancedOrder(1, 101719)
  assert.deepEqual(order, balancedOrder(1, 101719))
  assert.equal(new Set(order.map(t => t.arm.id + ':' + t.scenario)).size, ARMS.length * SCENARIOS.length)
})

test('positive arm adds acknowledgement without changing evidence, action or delivery priority', () => {
  for (const scenario of SCENARIOS) {
    const neutral = recoveryEntry(scenario, false, 'bound-request'), positive = recoveryEntry(scenario, true, 'bound-request')
    assert.ok(positive.content.endsWith(neutral.content))
    assert.equal(positive.channel, neutral.channel)
    assert.equal(positive.priority, neutral.priority)
    assert.doesNotMatch(positive.content, /四步无遗漏|已经修复|全部通过|试了很多/)
  }
})

test('candidate reaches actual main request through real bus and volatile domain; continuation stays unchanged', () => {
  for (const arm of ARMS) {
    const bus = new AdvisoryBus(), entry = recoveryEntry('python-repair', arm.positive, 'request')
    bus.submit(entry); bus.render('七杀', 0)
    const reminders = bus.drainSystemReminders()
    assert.equal(reminders.length, 1)
    const history: any[] = [{ role: 'user', origin: 'human', content: '修复并验证' }]
    for (const reminder of reminders) { history.push({ role: 'user', origin: 'hook', content: `<system-reminder>${reminder.content}</system-reminder>` }); bus.confirmSrDelivered(reminder.key) }
    assert.equal(bus.drainDelivered().length, 1)
    const d = STAR_DOMAINS.qisha
    const engine = new PromptEngine({ model: 'deepseek-flash', maxTokens: 4096, staticCtx: { tools: [] }, volatileCtx: { cwd: home, activeDomain: { name: d.name, motto: d.motto, volatileBlock: d.volatileBlock + (arm.scoped ? SCOPE_CANDIDATE : '') } } })
    const first = engine.buildOaiRequest(history).messages
    assert.equal(JSON.stringify(first).includes('职责边界：'), arm.scoped)
    assert.ok(JSON.stringify(first).includes(entry.content))
    assert.deepEqual(engine.buildOaiRequest([...history, { role: 'assistant', content: '继续核对' }]).messages.slice(0, first.length), first)
  }
})

const python = '/usr/bin/python3'
for (const scenario of SCENARIOS) test(`real ${scenario} fixture has a failing seed and attainable honest objective`, { skip: process.platform === 'win32' || !existsSync(python) }, async () => {
  const world = new RecoveryWorld(scenario, 'test-' + scenario, python)
  try {
    await world.initialize()
    const seed = await world.seed()
    if (scenario === 'background-result') {
      assert.match(seed[1]!.result.content, /仍在运行/)
      assert.equal(world.outcome().taskObjectiveObserved, false)
      const id = seed[0]!.result.backgroundJobId
      const ended = await world.execute('job', { action: 'await', id })
      assert.match(ended.content, /exit 1/)
    } else assert.notEqual(seed[0]!.result.exitCode, 0)
    if (scenario.startsWith('python')) await world.execute('bash', { command: 'node scripts/probe.cjs' })
    if (scenario !== 'python-review') {
      await world.execute('read_file', { file_path: world.editable })
      const edit = await world.execute('edit_file', { file_path: world.editable, old_string: world.oldText, new_string: world.replacements[0] })
      assert.notEqual(edit.isError, true)
      const result = await world.execute('bash', { command: 'node scripts/check.cjs' })
      if (scenario === 'background-result') await world.execute('job', { action: 'await', id: result.backgroundJobId })
    }
    const outcome = world.outcome()
    assert.equal(outcome.taskObjectiveObserved, true, JSON.stringify(outcome))
    assert.equal(outcome.protectedUnchanged, true)
    assert.equal(outcome.adapterBlocked, 0)
    if (scenario === 'python-review') assert.deepEqual(outcome.changed, [])
    const blocked = await world.execute('bash', { command: 'outside-declared-capabilities' })
    assert.match(blocked.content, /EXPERIMENT_CAPABILITY_LIMIT/)
  } finally { await world.close() }
})

test('declared PATH fence is effective: removing the local alias removes python3 resolution', { skip: process.platform === 'win32' || !existsSync(python) }, async () => {
  const world = new RecoveryWorld('python-review', 'path-counterprobe', python)
  try {
    await world.initialize()
    const before = await world.execute('bash', { command: 'node scripts/probe.cjs' })
    assert.match(before.content, /Python 3/)
    unlinkSync(join(world.root, 'bin/python3'))
    const after = await world.execute('bash', { command: 'node scripts/probe.cjs' })
    assert.doesNotMatch(after.content, /Python 3/)
    assert.match(after.content, /python3.*ENOENT/)
    assert.ok(existsSync(python), 'host interpreter still exists')
  } finally { await world.close() }
})

test('old successful check cannot prove an edited-back artifact even when a pass fact remains', { skip: process.platform === 'win32' || !existsSync(python) }, async () => {
  const world = new RecoveryWorld('credential-boundary', 'stale-counterprobe', python)
  try {
    await world.initialize(); await world.seed()
    await world.execute('read_file', { file_path: world.editable })
    await world.execute('edit_file', { file_path: world.editable, old_string: world.oldText, new_string: world.replacements[0] })
    await world.execute('bash', { command: 'node scripts/check.cjs' })
    assert.equal(world.outcome().taskObjectiveObserved, true)
    writeFileSync(join(world.root, world.editable), 'module.exports=text=>text.toLowerCase();\n')
    const stale = world.outcome()
    assert.ok(stale.facts.includes('check-passed-observed'))
    assert.equal(stale.currentProof, false)
    assert.equal(stale.taskObjectiveObserved, false)
  } finally { await world.close() }
})
