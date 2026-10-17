import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveProLicense,
  isProEnabled,
  isProFeatureEnabled,
  describeProLicense,
  __resetProWarningState,
  __setProGrantPublicKeyForTests,
} from '../pro-license.js'
import { DEFAULT_CONFIG } from '../default.js'
import type { Config } from '../schema.js'
import { buildGrantPayload, makeTestSigner, makeValidGrant, signGrant } from './grant-fixtures.js'

const ALL_FEATURES_ON = { computerUse: true, chatGateway: true, teamMax: true, councilMultiRound: true, unattendedAutomation: true, spark: true }

function baseConfig(): Config {
  // Start from the real default and only mutate `pro` for the test.
  const cfg = structuredClone(DEFAULT_CONFIG) as Config
  cfg.pro = { enabled: false, features: { ...ALL_FEATURES_ON } }
  return cfg
}

/** 保存/恢复所有与 Pro 判定相关的环境变量。 */
const PRO_ENV_KEYS = ['RIVET_PRO', 'RIVET_DESKTOP', 'RIVET_PRO_GRANT', 'RIVET_PRO_DEVICE_ID', 'RIVET_HOME'] as const
function withEnvSnapshot() {
  const saved = new Map<string, string | undefined>()
  for (const k of PRO_ENV_KEYS) saved.set(k, process.env[k])
  return () => {
    for (const k of PRO_ENV_KEYS) {
      const v = saved.get(k)
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}
function clearProEnv(): void {
  for (const k of PRO_ENV_KEYS) delete process.env[k]
}

/**
 * CLI 侧与桌面端**同一份凭证**：`<rivet_home>/license.json` 里服务端签名的 token。
 * 桌面端激活过的付费用户，CLI 直接复用（零操作）；没买的人拿不到 token，
 * 因此**不能**靠 env / config 标志 / 任意文件内容在 CLI 开 Pro。
 */
function writeLicenseGrant(
  home: string,
  overrides: Record<string, unknown> = {}
): { token: string; publicKeyB64: string } {
  const { token, publicKeyB64 } = makeValidGrant(overrides)
  writeFileSync(join(home, 'license.json'), JSON.stringify({ token, lastVerifiedAt: Date.now() }))
  __setProGrantPublicKeyForTests(publicKeyB64)
  return { token, publicKeyB64 }
}

describe('resolveProLicense — CLI 硬 gate（无 RIVET_DESKTOP）', () => {
  let restore: () => void
  let home: string
  let tmpLicense: string

  beforeEach(() => {
    restore = withEnvSnapshot()
    clearProEnv()
    __resetProWarningState()
    home = mkdtempSync(join(tmpdir(), 'pro-license-'))
    tmpLicense = join(home, 'license.json')
  })

  afterEach(() => {
    restore()
    __setProGrantPublicKeyForTests(null)
    try { unlinkSync(tmpLicense) } catch { /* ignore */ }
  })

  it('有效签名的 license.json 放行（桌面端付费用户在 CLI 复用同一份凭证）', () => {
    writeLicenseGrant(home)
    const info = resolveProLicense(baseConfig(), tmpLicense)
    assert.equal(info.enabled, true)
    assert.equal(info.source, 'grant')
    assert.equal(info.reason, 'grant_ok')
    assert.equal(info.tier, 'pro')
  })

  it('【回归】裸 RIVET_PRO=1 不再放行（CLI 也不能凭环境变量开 Pro）', () => {
    process.env.RIVET_PRO = '1'
    const info = resolveProLicense(baseConfig(), tmpLicense)
    assert.equal(info.enabled, false, 'CLI 侧同样只认签名凭证')
    assert.equal(info.reason, 'no_grant')
  })

  it('【回归】config.pro.enabled=true 不再放行', () => {
    const config = baseConfig()
    config.pro = { enabled: true, licenseKey: 'key-from-config', features: { ...ALL_FEATURES_ON } }
    const info = resolveProLicense(config, tmpLicense)
    assert.equal(info.enabled, false, '改 config 解锁不了')
    assert.equal(info.reason, 'no_grant')
  })

  it('【回归】pro.license 文件不再放行（旧 CLI 软 gate 路径）', () => {
    const legacy = join(home, 'pro.license')
    writeFileSync(legacy, 'whatever-key-material\n')
    const info = resolveProLicense(baseConfig(), legacy)
    assert.equal(info.enabled, false, '任意文件内容不再是凭据')
  })

  it('签名无效的 license.json 拒绝', () => {
    const other = makeValidGrant() // 另一对密钥签的 token → 与本机公钥不匹配
    writeFileSync(join(home, 'license.json'), JSON.stringify({ token: other.token, lastVerifiedAt: Date.now() }))
    const info = resolveProLicense(baseConfig(), tmpLicense)
    assert.equal(info.enabled, false)
    assert.equal(info.reason, 'grant_bad_signature')
  })

  it('license.json 过期 → 拒绝', () => {
    const past = Date.now() - 86_400_000 * 30
    writeLicenseGrant(home, { iat: past - 86_400_000 * 60, exp: past, maxOfflineMs: 0 })
    const info = resolveProLicense(baseConfig(), tmpLicense)
    assert.equal(info.enabled, false)
    assert.equal(info.reason, 'grant_offline_budget_exhausted')
  })

  it('license.json 损坏或缺 token 字段 → 拒绝（fail closed）', () => {
    writeFileSync(tmpLicense, '{ not json')
    assert.equal(resolveProLicense(baseConfig(), tmpLicense).enabled, false)

    writeFileSync(tmpLicense, JSON.stringify({ lastVerifiedAt: Date.now() }))
    assert.equal(resolveProLicense(baseConfig(), tmpLicense).enabled, false)
  })

  it('returns enabled=false when no Pro source is present', () => {
    const info = resolveProLicense(baseConfig(), tmpLicense)
    assert.equal(info.enabled, false)
    assert.equal(info.source, 'none')
    assert.equal(info.reason, 'no_grant')
  })
})

describe('resolveProLicense — 桌面端硬 gate（RIVET_DESKTOP=1）', () => {
  let restore: () => void
  let tmpLicense: string
  let signer: ReturnType<typeof makeTestSigner>

  beforeEach(() => {
    restore = withEnvSnapshot()
    clearProEnv()
    __resetProWarningState()
    process.env.RIVET_DESKTOP = '1'
    signer = makeTestSigner()
    __setProGrantPublicKeyForTests(signer.publicKeyB64)
    const home = mkdtempSync(join(tmpdir(), 'pro-desktop-'))
    process.env.RIVET_HOME = home
    tmpLicense = join(home, 'license.json')
  })

  afterEach(() => {
    __setProGrantPublicKeyForTests(null)
    restore()
    try { unlinkSync(tmpLicense) } catch { /* ignore */ }
  })

  /** 注入一份签名有效、时间窗正常的桌面凭证。 */
  function grantEnv(overrides: Record<string, unknown> = {}): void {
    process.env.RIVET_PRO_GRANT = signGrant(buildGrantPayload(overrides), signer.privateKey)
    writeFileSync(tmpLicense, JSON.stringify({ token: process.env.RIVET_PRO_GRANT, lastVerifiedAt: Date.now() }))
  }

  it('验签通过的凭证 → enabled，source=grant，带上 tier', () => {
    grantEnv({ tier: 'pro' })
    const info = resolveProLicense(baseConfig(), tmpLicense)
    assert.equal(info.enabled, true)
    assert.equal(info.source, 'grant')
    assert.equal(info.tier, 'pro')
    assert.equal(info.reason, 'grant_ok')
  })

  // ── 以下 4 条是本次加固的核心回归门禁：旧实现全部是「放行」 ──

  it('【回归】裸 RIVET_PRO=1 不再放行（环境变量不再是凭据）', () => {
    process.env.RIVET_PRO = '1'
    const info = resolveProLicense(baseConfig(), tmpLicense)
    assert.equal(info.enabled, false, '裸 env 必须是 Basic —— 这正是 v3.21.1 的向量 ①⑤')
    assert.equal(info.source, 'none')
    assert.equal(info.reason, 'no_grant')
  })

  it('【回归】config.pro.enabled=true 后门封死', () => {
    const config = baseConfig()
    config.pro = { enabled: true, licenseKey: 'stolen', features: { ...ALL_FEATURES_ON } }
    const info = resolveProLicense(config, tmpLicense)
    assert.equal(info.enabled, false, 'config.pro.enabled 后门在桌面端必须失效')
    assert.equal(info.source, 'none')
  })

  it('【回归】pro.license 文件后门封死', () => {
    writeFileSync(tmpLicense, 'fake-license-key')
    const info = resolveProLicense(baseConfig(), tmpLicense)
    assert.equal(info.enabled, false, 'pro.license 文件后门在桌面端必须失效')
  })

  it('【回归】config + file + 裸 env 同时存在 → 仍然 Basic', () => {
    process.env.RIVET_PRO = '1'
    writeFileSync(tmpLicense, 'fake')
    const config = baseConfig()
    config.pro = { enabled: true, licenseKey: 'stolen', features: { ...ALL_FEATURES_ON } }
    const info = resolveProLicense(config, tmpLicense)
    assert.equal(info.enabled, false, '三路径全开也不能解锁桌面端')
  })

  // ── 凭证本身被篡改/失效时的 fail-closed 行为 ──

  it('凭证被别人签的名 → Basic（bad_signature）', () => {
    const attacker = makeTestSigner()
    process.env.RIVET_PRO_GRANT = signGrant(buildGrantPayload(), attacker.privateKey)
    const info = resolveProLicense(baseConfig(), tmpLicense)
    assert.equal(info.enabled, false)
    assert.equal(info.reason, 'grant_bad_signature')
  })

  it('凭证过期且超出宽限 → Basic（grant_expired）', () => {
    const long = 40 * 86_400_000
    grantEnv({ iat: Date.now() - long, exp: Date.now() - long + 86_400_000 })
    const info = resolveProLicense(baseConfig(), tmpLicense)
    assert.equal(info.enabled, false)
    assert.equal(info.reason, 'grant_expired')
  })

  it('凭证在离线宽限期内 → enabled，reason=grant_grace', () => {
    const now = Date.now()
    grantEnv({ iat: now - 2 * 86_400_000, exp: now - 86_400_000, lic: null })
    const info = resolveProLicense(baseConfig(), tmpLicense)
    assert.equal(info.enabled, true)
    assert.equal(info.reason, 'grant_grace', '离线宽限是付费用户断网时唯一的救命路径，不能回归成 Basic')
  })

  it('许可硬过期（lic）→ Basic，即便 token 自身还在有效期内', () => {
    grantEnv({ lic: Date.now() - 1000 })
    const info = resolveProLicense(baseConfig(), tmpLicense)
    assert.equal(info.enabled, false)
    assert.equal(info.reason, 'grant_license_expired')
  })

  it('产品不匹配（拿 CLI 的 token 来开桌面端）→ Basic', () => {
    process.env.RIVET_PRO_GRANT = signGrant(buildGrantPayload({ product: 'tianshu-cli' }), signer.privateKey)
    assert.equal(resolveProLicense(baseConfig(), tmpLicense).reason, 'grant_product_mismatch')
  })

  it('shell 注入的设备指纹与凭证不一致 → Basic', () => {
    grantEnv({ deviceId: 'dev-other-machine' })
    process.env.RIVET_PRO_DEVICE_ID = 'dev-this-machine'
    assert.equal(resolveProLicense(baseConfig(), tmpLicense).reason, 'grant_device_mismatch')
  })

  it('空/垃圾凭证 → Basic，不抛异常', () => {
    for (const bad of ['', 'garbage', 'a.b', 'x'.repeat(200)]) {
      process.env.RIVET_PRO_GRANT = bad
      const info = resolveProLicense(baseConfig(), tmpLicense)
      assert.equal(info.enabled, false, `bad=${JSON.stringify(bad)}`)
      assert.ok(info.reason?.startsWith('grant_') || info.reason === 'no_grant')
    }
  })

  it('describeProLicense 输出可诊断 reason（供日志/遥测识别绕过尝试）', () => {
    process.env.RIVET_PRO = '1'
    const d = describeProLicense(baseConfig())
    assert.equal(d.enabled, false)
    assert.equal(d.reason, 'no_grant')
    assert.equal(d.product, 'tianshu-desktop')
  })

  it('日志纪律：正常 Basic 不留告警，出现绕过信号才留痕（否则真信号会被刷屏淹没）', () => {
    const calls: string[] = []
    const original = console.warn
    console.warn = (msg?: unknown) => {
      calls.push(String(msg))
    }
    try {
      __resetProWarningState()
      resolveProLicense(baseConfig(), tmpLicense)
      // 用 length 断言而不是 deepEqual(calls, [])：后者会让 TS 把 calls 收窄成
      // never[]，下面那行 .includes 就编不过了。
      assert.equal(calls.length, 0, `未激活的正常用户不应产生告警：${JSON.stringify(calls)}`)

      __resetProWarningState()
      process.env.RIVET_PRO = '1'
      resolveProLicense(baseConfig(), tmpLicense)
      assert.ok(
        calls.some((c) => c.includes('绕过信号')),
        `裸 RIVET_PRO=1 应留痕（本地唯一的检测手段）：${JSON.stringify(calls)}`
      )
    } finally {
      console.warn = original
    }
  })
})

describe('isProFeatureEnabled', () => {
  let restore: () => void

  beforeEach(() => {
    restore = withEnvSnapshot()
    clearProEnv() // 无 RIVET_DESKTOP → 走 CLI 入口（读 <RIVET_HOME>/license.json）
    // 隔离默认路径读取面：开发机真实 ~/.rivet/license.json 可能是有效凭证，泄漏
    // 进「无凭证」用例会让断言假红（2026-10-01 实踩）。rivetHome() 认这个变量。
    process.env.RIVET_HOME = mkdtempSync(join(tmpdir(), 'pro-feat-none-'))
    __resetProWarningState()
    __setProGrantPublicKeyForTests(null)
  })

  afterEach(() => {
    restore()
    __setProGrantPublicKeyForTests(null)
  })

  /**
   * 开 Pro 的唯一正当方式：在 RIVET_HOME 下放一份**签名有效**的 license.json。
   * `rivetHome()` 认这个环境变量，所以无需给 isProFeatureEnabled 加注入参数。
   */
  function installValidLicense(overrides: Record<string, unknown> = {}): void {
    const home = mkdtempSync(join(tmpdir(), 'pro-feat-'))
    process.env.RIVET_HOME = home
    const { token, publicKeyB64 } = makeValidGrant(overrides)
    writeFileSync(join(home, 'license.json'), JSON.stringify({ token, lastVerifiedAt: Date.now() }))
    __setProGrantPublicKeyForTests(publicKeyB64)
  }

  it('returns false when Pro is disabled', () => {
    const config = baseConfig()
    config.pro = { enabled: false, features: { ...ALL_FEATURES_ON } }
    assert.equal(isProFeatureEnabled(config, 'computerUse'), false)
  })

  it('returns true when Pro is enabled and feature defaults to true', () => {
    installValidLicense()
    const config = baseConfig()
    config.pro = { enabled: false, features: { ...ALL_FEATURES_ON } }
    assert.equal(isProFeatureEnabled(config, 'computerUse'), true)
    assert.equal(isProFeatureEnabled(config, 'chatGateway'), true)
  })

  it('returns false when Pro is enabled but feature is explicitly disabled', () => {
    installValidLicense()
    const config = baseConfig()
    config.pro = { enabled: false, features: { ...ALL_FEATURES_ON, computerUse: false, chatGateway: false } }
    assert.equal(isProFeatureEnabled(config, 'computerUse'), false)
    assert.equal(isProFeatureEnabled(config, 'chatGateway'), false)
  })

  it('【回归】裸 RIVET_PRO=1 不再开 Pro（CLI 侧同样只认签名凭证）', () => {
    process.env.RIVET_PRO = '1'
    assert.equal(isProEnabled(baseConfig()), false)
  })

  it('【回归】config.pro.enabled=true 不再开 Pro', () => {
    const config = baseConfig()
    config.pro = { enabled: true, features: { ...ALL_FEATURES_ON } }
    assert.equal(isProEnabled(config), false)
  })

  // ── 双层模式新增 Pro 功能位 ──

  it('teamMax / councilMultiRound default to enabled under an active Pro license', () => {
    installValidLicense()
    const config = baseConfig()
    config.pro = { enabled: false, features: { ...ALL_FEATURES_ON } }
    assert.equal(isProFeatureEnabled(config, 'teamMax'), true)
    assert.equal(isProFeatureEnabled(config, 'councilMultiRound'), true)
  })

  it('teamMax / councilMultiRound are off without Pro', () => {
    const config = baseConfig()
    assert.equal(isProFeatureEnabled(config, 'teamMax'), false)
    assert.equal(isProFeatureEnabled(config, 'councilMultiRound'), false)
  })

  it('全部 Pro 功能位在桌面端无凭证时一律关闭（feature 显式为 true 也不行）', () => {
    process.env.RIVET_DESKTOP = '1'
    process.env.RIVET_PRO = '1' // 旧攻击面
    const config = baseConfig()
    config.pro = { enabled: true, features: { ...ALL_FEATURES_ON } }
    for (const f of ['computerUse', 'chatGateway', 'teamMax', 'councilMultiRound', 'unattendedAutomation', 'spark'] as const) {
      assert.equal(isProFeatureEnabled(config, f), false, `${f} 不应在无凭证时开启`)
    }
  })
})
