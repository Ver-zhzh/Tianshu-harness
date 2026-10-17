/**
 * Wave G — sidecar per-cwd 共享资源（Meridian / LSP）。
 *
 * 覆盖：同 cwd 共享单实例、不同 cwd 隔离、close() 后 map 清空 + dispose 调用、
 * LSP mock 注册（ready 后工具进 registry + updateTools 被调；ready=false 不注册；
 * 晚订阅（switchModel 重建 agent）照样收到 updateTools）。
 * 晚到注册闸门（2026-10-16，issue #500 配套修复）：begin/end 配对、超时兜底释放、
 * 按能力过滤（supportsDefinition / supportsReferences 在注册期完成）。
 */
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getOrCreateMeridianIndexer,
  disposeSharedCwdResources,
  type SharedRuntime,
} from '../serve-agent.js'
import { attachLspTools } from '../serve-lsp.js'
import { ProviderHealthTracker } from '../../agent/provider-health.js'
import type { LspManager } from '../../lsp/manager.js'
import type { Tool } from '../../tools/types.js'

function makeShared(): SharedRuntime {
  return {
    providerHealth: new ProviderHealthTracker(),
    domainStores: new Map(),
    meridianIndexers: new Map(),
    lspManagers: new Map(),
    sameCwdRunningCount: null,
    mcpManager: null,
    sessions: null,
  }
}

function makeMockLspManager(overrides: Partial<LspManager> = {}): LspManager & { disposed: boolean } {
  const mock = {
    disposed: false,
    initialize: async () => {},
    isReady: () => true,
    supportsDefinition: () => true,
    supportsReferences: () => true,
    gotoDefinition: async () => [],
    findReferences: async () => [],
    changeFile: () => {},
    getFileDiagnostics: async () => [],
    dispose() { mock.disposed = true },
    ...overrides,
  }
  return mock as LspManager & { disposed: boolean }
}

/** 闸门可观测注册表：register 收集工具名，begin/end 计数（晚到注册闸门用例用）。 */
function makeGateRegistry() {
  const registered: string[] = []
  const counts = { begins: 0, ends: 0 }
  const registry = {
    register: (tool: Tool) => { registered.push(tool.definition.name) },
    beginExtraRegistration: () => { counts.begins += 1 },
    endExtraRegistration: () => { counts.ends += 1 },
  }
  return { registered, counts, registry }
}

test('same cwd returns the same MeridianIndexer instance; different cwd is isolated', () => {
  const shared = makeShared()
  const cwdA = mkdtempSync(join(tmpdir(), 'waveg-a-'))
  const cwdB = mkdtempSync(join(tmpdir(), 'waveg-b-'))
  try {
    const first = getOrCreateMeridianIndexer(shared, cwdA)
    const second = getOrCreateMeridianIndexer(shared, cwdA)
    const other = getOrCreateMeridianIndexer(shared, cwdB)
    assert.equal(first, second, 'same cwd must share one instance')
    assert.notEqual(first, other, 'different cwd must get its own instance')
    assert.equal(shared.meridianIndexers.size, 2)
  } finally {
    disposeSharedCwdResources(shared)
    rmSync(cwdA, { recursive: true, force: true })
    rmSync(cwdB, { recursive: true, force: true })
  }
})

test('disposeSharedCwdResources closes indexers, disposes LSP managers, clears maps', () => {
  const shared = makeShared()
  const cwd = mkdtempSync(join(tmpdir(), 'waveg-close-'))
  try {
    getOrCreateMeridianIndexer(shared, cwd)
    const manager = makeMockLspManager()
    shared.lspManagers.set(cwd, { manager, ready: Promise.resolve(true) })

    disposeSharedCwdResources(shared)
    assert.equal(shared.meridianIndexers.size, 0)
    assert.equal(shared.lspManagers.size, 0)
    assert.equal(manager.disposed, true)

    // Idempotent: a second dispose over empty maps must not throw.
    disposeSharedCwdResources(shared)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('dispose survives a throwing manager (try-catch per resource)', () => {
  const shared = makeShared()
  const bad = makeMockLspManager({ dispose: () => { throw new Error('boom') } })
  const good = makeMockLspManager()
  shared.lspManagers.set('/bad', { manager: bad, ready: Promise.resolve(true) })
  shared.lspManagers.set('/good', { manager: good, ready: Promise.resolve(true) })

  disposeSharedCwdResources(shared)
  assert.equal(shared.lspManagers.size, 0)
  assert.equal(good.disposed, true, 'later resources still disposed after one throws')
})

test('attachLspTools registers goto/find tools and refreshes the agent when ready', async () => {
  const manager = makeMockLspManager()
  const gate = makeGateRegistry()
  const refs: { lspManager: LspManager | null } = { lspManager: null }
  let updates = 0

  await attachLspTools(
    { manager, ready: Promise.resolve(true) },
    gate.registry,
    refs,
    () => { updates++ },
  )

  assert.deepEqual(gate.registered.sort(), ['lsp_find_references', 'lsp_goto_definition'])
  assert.equal(refs.lspManager, manager)
  assert.equal(updates, 1)
  // 晚到注册闸门：begin/end 严格配对
  assert.equal(gate.counts.begins, 1)
  assert.equal(gate.counts.ends, 1)
})

test('attachLspTools does nothing when no language server is available (ready=false)', async () => {
  const manager = makeMockLspManager()
  const gate = makeGateRegistry()
  const refs: { lspManager: LspManager | null } = { lspManager: null }
  let updates = 0

  await attachLspTools(
    { manager, ready: Promise.resolve(false) },
    gate.registry,
    refs,
    () => { updates++ },
  )

  assert.deepEqual(gate.registered, [])
  assert.equal(refs.lspManager, null)
  assert.equal(updates, 0)
  // 未就绪也走闸门并释放：等的是「初始化完成」，不是「等成功」
  assert.equal(gate.counts.begins, 1)
  assert.equal(gate.counts.ends, 1, '释放必须发生，否则 pending 计数永久占住闸门')
})

test('late subscription (switchModel rebuild) still receives updateTools on a resolved entry', async () => {
  const manager = makeMockLspManager()
  const entry = { manager, ready: Promise.resolve(true) }
  const gate = makeGateRegistry()

  // First agent subscribes and completes.
  const refsA: { lspManager: LspManager | null } = { lspManager: null }
  let updatesA = 0
  await attachLspTools(entry, gate.registry, refsA, () => { updatesA++ })
  assert.equal(updatesA, 1)

  // switchModel builds a new agent afterwards — the promise is long resolved,
  // yet the per-assemble subscription still fires for the new agent.
  const refsB: { lspManager: LspManager | null } = { lspManager: null }
  let updatesB = 0
  await attachLspTools(entry, gate.registry, refsB, () => { updatesB++ })
  assert.equal(updatesB, 1)
  assert.equal(refsB.lspManager, manager)
  // 每次订阅独立配对（重挂不漏不双）
  assert.equal(gate.counts.begins, 2)
  assert.equal(gate.counts.ends, 2)
})

test('晚到注册闸门：初始化期登记 begin、settle 后释放 end', async () => {
  const manager = makeMockLspManager()
  const gate = makeGateRegistry()
  const refs: { lspManager: LspManager | null } = { lspManager: null }
  let resolveReady!: (ok: boolean) => void
  const ready = new Promise<boolean>((r) => { resolveReady = r })

  const attached = attachLspTools({ manager, ready }, gate.registry, refs, () => {})
  assert.equal(gate.counts.begins, 1, '初始化期即登记——run() 入口的 awaitExtraRegistrations 可见')
  assert.equal(gate.counts.ends, 0)

  resolveReady(true)
  await attached
  assert.equal(gate.counts.ends, 1, '就绪后释放')
})

test('闸门兜底：initialize 挂死时由超时释放（防后续消息白等 8s）', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const manager = makeMockLspManager()
    const gate = makeGateRegistry()
    const never = new Promise<boolean>(() => {})
    const attached = attachLspTools({ manager, ready: never }, gate.registry, { lspManager: null }, () => {})
    void attached
    assert.equal(gate.counts.begins, 1)
    assert.equal(gate.counts.ends, 0)

    mock.timers.tick(10_001)
    assert.equal(gate.counts.ends, 1, '挂死的 ready 由兜底超时释放')
  } finally {
    mock.timers.reset()
  }
})

test('按能力注册：不支持 definition 的服务器不注册 goto 工具', async () => {
  const manager = makeMockLspManager({ supportsDefinition: () => false })
  const gate = makeGateRegistry()
  const refs: { lspManager: LspManager | null } = { lspManager: null }
  let updates = 0

  await attachLspTools({ manager, ready: Promise.resolve(true) }, gate.registry, refs, () => { updates++ })

  assert.deepEqual(gate.registered, ['lsp_find_references'])
  assert.equal(updates, 1, '注册集合由 registerLspTools 决定，updateTools 仍触发')
  assert.equal(refs.lspManager, manager)
})
