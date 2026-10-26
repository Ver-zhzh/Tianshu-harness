import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolvePromptBlocks, invalidatePromptBlocks, standardPromptBlocks } from '../block-policy.js'
import { FROZEN_BLOCK_CAPS } from '../volatile.js'

const ENV_KEYS = ['RIVET_PROMPT_PROFILE', 'RIVET_PROMPT_TOOL_DESC', 'RIVET_HOME', 'RIVET_LATENCY_PROMPT_EXPERIMENT'] as const

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k]
}

describe('resolvePromptBlocks precedence', () => {
  let dir: string
  let home: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'block-policy-'))
    home = mkdtempSync(join(tmpdir(), 'block-policy-home-'))
    clearEnv()
    // 隔离用户层配置，否则测试会读开发机真实 ~/.rivet/config.json
    process.env.RIVET_HOME = home
    invalidatePromptBlocks()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    clearEnv()
    invalidatePromptBlocks()
  })

  it('defaults to standard with no env and no config', () => {
    assert.equal(resolvePromptBlocks(dir).profile, 'standard')
  })

  it('latency experiment changes reference budgets only and cannot leak into a resumed assembly', () => {
    process.env.RIVET_LATENCY_PROMPT_EXPERIMENT = '1'
    const candidate = resolvePromptBlocks(dir)
    assert.equal(candidate.toolDescriptions, 'full')
    assert.equal(candidate.caps.projectInstructions, FROZEN_BLOCK_CAPS.projectInstructions)
    assert.ok(candidate.caps.projectMemory < FROZEN_BLOCK_CAPS.projectMemory)
    const restored = resolvePromptBlocks(dir, false)
    assert.deepEqual(restored.caps, FROZEN_BLOCK_CAPS)
    assert.equal(restored.toolDescriptions, 'full')
    assert.notEqual(restored, candidate, 'memoization must include experiment eligibility')
  })

  it('project .rivet-config.json prompt.profile wins over default', () => {
    writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({ prompt: { profile: 'lean' } }))
    invalidatePromptBlocks()
    assert.equal(resolvePromptBlocks(dir).profile, 'lean')
  })

  it('nested cwd walks up to the project config', () => {
    writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({ prompt: { profile: 'full' } }))
    mkdirSync(join(dir, 'src', 'x'), { recursive: true })
    invalidatePromptBlocks()
    assert.equal(resolvePromptBlocks(join(dir, 'src', 'x')).profile, 'full')
  })

  it('project config wins over user config', () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ prompt: { profile: 'full' } }))
    writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({ prompt: { profile: 'lean' } }))
    invalidatePromptBlocks()
    assert.equal(resolvePromptBlocks(dir).profile, 'lean')
  })

  it('user config applies when the project has none', () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ prompt: { profile: 'lean' } }))
    invalidatePromptBlocks()
    assert.equal(resolvePromptBlocks(dir).profile, 'lean')
  })

  it('RIVET_PROMPT_PROFILE env wins over project config', () => {
    writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({ prompt: { profile: 'full' } }))
    process.env.RIVET_PROMPT_PROFILE = 'lean'
    invalidatePromptBlocks()
    assert.equal(resolvePromptBlocks(dir).profile, 'lean')
  })

  it('invalid values fall back to standard', () => {
    writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({ prompt: { profile: 'tiny' } }))
    invalidatePromptBlocks()
    assert.equal(resolvePromptBlocks(dir).profile, 'standard')
  })

  it('malformed config json falls back to standard instead of throwing', () => {
    writeFileSync(join(dir, '.rivet-config.json'), '{ not json')
    invalidatePromptBlocks()
    assert.equal(resolvePromptBlocks(dir).profile, 'standard')
  })

  it('memoizes per cwd until invalidated', () => {
    assert.equal(resolvePromptBlocks(dir).profile, 'standard')
    writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({ prompt: { profile: 'lean' } }))
    assert.equal(resolvePromptBlocks(dir).profile, 'standard', 'memo should survive config write')
    invalidatePromptBlocks()
    assert.equal(resolvePromptBlocks(dir).profile, 'lean')
  })
})

describe('standard profile is byte-identical to the rendering defaults', () => {
  let dir: string
  let home: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'block-policy-std-'))
    home = mkdtempSync(join(tmpdir(), 'block-policy-std-home-'))
    clearEnv()
    process.env.RIVET_HOME = home
    invalidatePromptBlocks()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    clearEnv()
    invalidatePromptBlocks()
  })

  // 这条是本模块存在的理由：无配置时必须等于历史行为，否则默认会话的
  // 前缀字节会变，全体用户缓存一次性 miss。见 block-policy.ts 顶部注释。
  it('caps match FROZEN_BLOCK_CAPS exactly', () => {
    const policy = resolvePromptBlocks(dir)
    assert.deepEqual(policy.caps, { ...FROZEN_BLOCK_CAPS })
  })

  it('all reference blocks are on and nothing is truncated', () => {
    const policy = resolvePromptBlocks(dir)
    assert.deepEqual(policy.blocks, {
      seedCapsule: true,
      knowledgeManifest: true,
      codebaseIndex: true,
      projectMemory: true,
      historicalLessons: true,
    })
    assert.equal(policy.capsuleIndexLimit, undefined)
    assert.equal(policy.toolDescriptions, 'full')
  })

  it('standardPromptBlocks() matches the config-resolved standard policy', () => {
    assert.deepEqual(standardPromptBlocks(), resolvePromptBlocks(dir))
  })

  it('returns an independent caps object per call (no shared mutation)', () => {
    const a = standardPromptBlocks()
    a.caps.projectMemory = 1
    assert.equal(standardPromptBlocks().caps.projectMemory, FROZEN_BLOCK_CAPS.projectMemory)
  })
})

describe('lean profile', () => {
  let dir: string
  let home: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'block-policy-lean-'))
    home = mkdtempSync(join(tmpdir(), 'block-policy-lean-home-'))
    clearEnv()
    process.env.RIVET_HOME = home
    process.env.RIVET_PROMPT_PROFILE = 'lean'
    invalidatePromptBlocks()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    clearEnv()
    invalidatePromptBlocks()
  })

  it('shrinks reference caps below standard', () => {
    const policy = resolvePromptBlocks(dir)
    assert.ok(policy.caps.projectMemory < FROZEN_BLOCK_CAPS.projectMemory)
    assert.ok(policy.caps.knowledgeManifest < FROZEN_BLOCK_CAPS.knowledgeManifest)
    assert.ok(policy.caps.codebaseIndex < FROZEN_BLOCK_CAPS.codebaseIndex)
  })

  it('drops historical-lessons and limits the capsule index', () => {
    const policy = resolvePromptBlocks(dir)
    assert.equal(policy.blocks.historicalLessons, false)
    assert.equal(policy.capsuleIndexLimit, 5)
  })

  it('keeps the capsule index itself on — only its length is capped', () => {
    // 索引是「哪位星域管什么」的地图，关掉等于让 recall_capsule 不可发现。
    assert.equal(resolvePromptBlocks(dir).blocks.seedCapsule, true)
  })

  it('defaults tool descriptions to compact', () => {
    assert.equal(resolvePromptBlocks(dir).toolDescriptions, 'compact')
  })

  it('explicit toolDescriptions overrides the profile default', () => {
    writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({ prompt: { toolDescriptions: 'full' } }))
    invalidatePromptBlocks()
    const policy = resolvePromptBlocks(dir)
    assert.equal(policy.profile, 'lean')
    assert.equal(policy.toolDescriptions, 'full')
  })
})

describe('per-block overrides', () => {
  let dir: string
  let home: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'block-policy-ovr-'))
    home = mkdtempSync(join(tmpdir(), 'block-policy-ovr-home-'))
    clearEnv()
    process.env.RIVET_HOME = home
    invalidatePromptBlocks()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    clearEnv()
    invalidatePromptBlocks()
  })

  it('an explicit block toggle beats the profile baseline', () => {
    writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({
      prompt: { profile: 'standard', blocks: { codebaseIndex: false } },
    }))
    invalidatePromptBlocks()
    const policy = resolvePromptBlocks(dir)
    assert.equal(policy.blocks.codebaseIndex, false)
    assert.equal(policy.blocks.projectMemory, true, 'untouched blocks keep the baseline')
  })

  it('can re-enable a block that lean turns off', () => {
    writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({
      prompt: { profile: 'lean', blocks: { historicalLessons: true } },
    }))
    invalidatePromptBlocks()
    assert.equal(resolvePromptBlocks(dir).blocks.historicalLessons, true)
  })

  it('ignores non-boolean and unknown block keys', () => {
    writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({
      prompt: { blocks: { projectMemory: 'yes', bogusBlock: false } },
    }))
    invalidatePromptBlocks()
    const policy = resolvePromptBlocks(dir)
    assert.equal(policy.blocks.projectMemory, true)
    assert.ok(!('bogusBlock' in policy.blocks))
  })

  it('exposes no toggle for behavioral guardrails', () => {
    // 护栏没有开关是有意的设计（V3.1: 0c776b9→17b496a）。这条断言防止
    // 有人「顺手」把 rules / delivery-contract / starDomain 加进来。
    const keys = Object.keys(resolvePromptBlocks(dir).blocks).sort()
    assert.deepEqual(keys, [
      'codebaseIndex', 'historicalLessons', 'knowledgeManifest', 'projectMemory', 'seedCapsule',
    ])
  })
})
