import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sign as cryptoSign } from 'node:crypto'

import {
  DEFAULT_CLOCK_SKEW_MS,
  DEFAULT_OFFLINE_MS,
  verifyGrantSignature,
  verifyProGrant,
} from '../pro-grant.js'
import { LICENSE_PRODUCT } from '../license-keys.js'
import { buildGrantPayload, makeTestSigner, signGrant } from './grant-fixtures.js'

const DAY = 86_400_000

describe('verifyProGrant — paid tier admission', () => {
  it('preserves authenticated pre-iat tierless grants only until their original signed expiration', () => {
    const { privateKey, publicKeyB64 } = makeTestSigner()
    const now = Date.now()
    for (const iat of [undefined, 0]) {
      const token = signGrant(buildGrantPayload({ tier: undefined, iat, exp: now + DAY }), privateKey)
      assert.equal(verifyProGrant(token, { publicKeyB64, now, deviceId: 'dev-test-0001' }).ok, true)
      assert.equal(verifyProGrant(token, { publicKeyB64, now: now + DAY + 1 }).reason, 'expired')
      assert.equal(verifyProGrant(token, { publicKeyB64, now, deviceId: 'different-device' }).reason, 'device_mismatch')
    }
  })

  it('a tierless modern offline policy is not authenticated legacy evidence', () => {
    const { privateKey, publicKeyB64 } = makeTestSigner()
    const token = signGrant(buildGrantPayload({ tier: undefined, iat: 0, maxOfflineMs: 10 * DAY }), privateKey)
    assert.equal(verifyProGrant(token, { publicKeyB64 }).reason, 'tier_not_allowed')
  })

  for (const tier of ['pro', 'max', 'lifetime']) {
    it(`accepts signed ${tier} grants without changing legacy offline policy`, () => {
      const { privateKey, publicKeyB64 } = makeTestSigner()
      const now = Date.now()
      const token = signGrant(buildGrantPayload({ tier, iat: now - 2 * DAY, exp: now - DAY }), privateKey)
      assert.equal(verifyProGrant(token, { publicKeyB64, now }).reason, 'grace')
    })
  }

  for (const tier of ['basic', 'free', 'unknown', '', undefined, null, 1]) {
    it(`rejects signed unpaid or missing tier ${String(tier)}`, () => {
      const { privateKey, publicKeyB64 } = makeTestSigner()
      const token = signGrant(buildGrantPayload({ tier }), privateKey)
      const result = verifyProGrant(token, { publicKeyB64 })
      assert.equal(result.ok, false)
      assert.equal(result.reason, 'tier_not_allowed')
    })
  }
})

describe('verifyProGrant — 签名与格式', () => {
  it('接受自己签发的合法凭证', () => {
    const { privateKey, publicKeyB64 } = makeTestSigner()
    const token = signGrant(buildGrantPayload(), privateKey)
    const res = verifyProGrant(token, { publicKeyB64 })
    assert.equal(res.ok, true)
    assert.equal(res.reason, 'ok')
    assert.equal(res.claims?.product, LICENSE_PRODUCT)
    assert.equal(res.claims?.tier, 'pro')
  })

  it('拒绝另一个密钥签发的凭证（伪造不可行）', () => {
    const attacker = makeTestSigner()
    const victim = makeTestSigner()
    const token = signGrant(buildGrantPayload(), attacker.privateKey)
    const res = verifyProGrant(token, { publicKeyB64: victim.publicKeyB64 })
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'bad_signature')
  })

  it('拒绝被改过的 payload（签名只护第一段，改一个字节即失效）', () => {
    const { privateKey, publicKeyB64 } = makeTestSigner()
    const token = signGrant(buildGrantPayload(), privateKey)
    const dot = token.indexOf('.')
    const decoded = JSON.parse(Buffer.from(token.slice(0, dot), 'base64url').toString('utf8')) as Record<string, unknown>
    decoded.tier = 'enterprise'
    decoded.lic = Date.now() + 10 * 365 * DAY // 攻击者想把有效期改成 10 年
    const forgedPayload = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')
    const forged = `${forgedPayload}.${token.slice(dot + 1)}`
    const res = verifyProGrant(forged, { publicKeyB64 })
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'bad_signature')
  })

  it('拒绝格式错误的凭证', () => {
    const { publicKeyB64 } = makeTestSigner()
    for (const bad of ['', 'nodot', 'a.b', 'a.b.c', '.sig', 'payload.']) {
      const res = verifyProGrant(bad, { publicKeyB64 })
      assert.equal(res.ok, false, `应拒绝：${JSON.stringify(bad)}`)
      assert.ok(
        ['missing', 'malformed', 'bad_signature', 'bad_payload'].includes(res.reason),
        `原因=${res.reason}`
      )
    }
  })

  it('缺失凭证 → missing（fail closed）', () => {
    const { publicKeyB64 } = makeTestSigner()
    assert.equal(verifyProGrant(undefined, { publicKeyB64 }).reason, 'missing')
    assert.equal(verifyProGrant('', { publicKeyB64 }).reason, 'missing')
  })

  it('签名长度不对（base64 解出非 64 字节）→ bad_signature', () => {
    const { publicKeyB64 } = makeTestSigner()
    const token = `${Buffer.from('{}').toString('base64url')}.AAAA`
    assert.equal(verifyProGrant(token, { publicKeyB64 }).reason, 'bad_signature')
  })

  it('verifyGrantSignature 对损坏的公钥不抛异常，只返回失败', () => {
    const res = verifyGrantSignature('a.b', 'not-a-valid-key')
    assert.equal(res.ok, false)
  })
})

describe('verifyProGrant — 时间窗与声明校验', () => {
  const now = 1_730_000_000_000

  it('产品不匹配 → product_mismatch', () => {
    const { privateKey, publicKeyB64 } = makeTestSigner()
    const token = signGrant(buildGrantPayload({ product: 'tianshu-cli', iat: now, exp: now + DAY }), privateKey)
    const res = verifyProGrant(token, { publicKeyB64, now })
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'product_mismatch')
  })

  it('设备指纹不匹配 → device_mismatch（纵深防御）', () => {
    const { privateKey, publicKeyB64 } = makeTestSigner()
    const token = signGrant(buildGrantPayload({ deviceId: 'dev-aaa', iat: now, exp: now + DAY }), privateKey)
    assert.equal(verifyProGrant(token, { publicKeyB64, now, deviceId: 'dev-bbb' }).reason, 'device_mismatch')
    assert.equal(verifyProGrant(token, { publicKeyB64, now, deviceId: 'dev-aaa' }).ok, true)
  })

  it('iat 在未来超过允许偏移 → not_yet_valid（时钟回拨/伪造时间戳）', () => {
    const { privateKey, publicKeyB64 } = makeTestSigner()
    const token = signGrant(buildGrantPayload({ iat: now + 60 * 60 * 1000, exp: now + DAY }), privateKey)
    assert.equal(verifyProGrant(token, { publicKeyB64, now }).reason, 'not_yet_valid')
  })

  it('许可硬过期（lic 已过）→ license_expired，即便 token 自身未过期', () => {
    const { privateKey, publicKeyB64 } = makeTestSigner()
    const token = signGrant(buildGrantPayload({ iat: now - DAY, exp: now + DAY, lic: now - 1 }), privateKey)
    assert.equal(verifyProGrant(token, { publicKeyB64, now }).reason, 'license_expired')
  })

  it('token 过期但在 iat + 宽限内 → ok，reason=grace 且给出 graceUntil', () => {
    const { privateKey, publicKeyB64 } = makeTestSigner()
    const iat = now - 2 * DAY
    const token = signGrant(buildGrantPayload({ iat, exp: now - DAY, lic: null }), privateKey)
    const res = verifyProGrant(token, { publicKeyB64, now })
    assert.equal(res.ok, true)
    assert.equal(res.reason, 'grace')
    assert.equal(res.graceUntil, iat + DEFAULT_OFFLINE_MS)
  })

  it('超出宽限窗口 → expired（窗口上界由签名保护的 iat 封死，不能靠改本地时间放大）', () => {
    const { privateKey, publicKeyB64 } = makeTestSigner()
    const iat = now - 30 * DAY
    const token = signGrant(buildGrantPayload({ iat, exp: now - 20 * DAY, lic: null }), privateKey)
    assert.equal(verifyProGrant(token, { publicKeyB64, now }).reason, 'expired')
    // 攻击者把系统时间往回调也没用：窗口锚在上界 iat + grace，iat 是签名的。
    assert.equal(verifyProGrant(token, { publicKeyB64, now: iat + DEFAULT_OFFLINE_MS + 1 }).reason, 'expired')
  })

  it('exp 不是数字 → bad_payload（不给「无过期时间」留口子）', () => {
    const { privateKey, publicKeyB64 } = makeTestSigner()
    const token = signGrant({ product: LICENSE_PRODUCT, iat: now }, privateKey)
    assert.equal(verifyProGrant(token, { publicKeyB64, now }).reason, 'bad_payload')
  })

  it('payload 是合法签名但不是 JSON 对象 → bad_payload', () => {
    const { privateKey, publicKeyB64 } = makeTestSigner()
    for (const raw of ['[]', '"str"', 'null', '123', '{bad json']) {
      // 用真密钥签**原始字符串**，绕过 signGrant 的 JSON.stringify —— 验签会过，
      // 必须由 payload 形状检查兜住。
      const payloadB64 = Buffer.from(raw, 'utf8').toString('base64url')
      const sig = cryptoSign(null, Buffer.from(payloadB64, 'ascii'), privateKey).toString('base64url')
      const res = verifyProGrant(`${payloadB64}.${sig}`, { publicKeyB64, now })
      assert.equal(res.ok, false, `应拒绝 payload=${raw}`)
      assert.equal(res.reason, 'bad_payload', `payload=${raw} 原因=${res.reason}`)
    }
  })
})

// ── 离线预算规则表（与 Rust 侧 activation.rs::offline_budget_rules_match_js_table 同表）──
//
// 这张表是「客户端判定跨语言一致」的唯一保证：Rust（决定注入哪个凭证、UI 显示
// 什么状态）与 JS（真正的功能 gate）各跑一遍同一组输入，期望值写死在同一份规则上。
describe('verifyProGrant — 离线预算规则表（JS ⇄ Rust 同表）', () => {
  const D = 86_400_000
  const SKEW = DEFAULT_CLOCK_SKEW_MS

  const cases: Array<{
    name: string
    iat: number
    exp: number
    maxOfflineMs?: number
    now: number
    ok: boolean
    reason: string
  }> = [
    { name: '老 token：未过期', iat: 1000, exp: 2000, now: 1500, ok: true, reason: 'ok' },
    { name: '老 token：过期但在 iat+10 天内 → 宽限', iat: 1000, exp: 2000, now: 1000 + 5 * D, ok: true, reason: 'grace' },
    { name: '老 token：超过 iat+10 天 → 锁', iat: 0, exp: 2000, now: 10 * D + 1, ok: false, reason: 'expired' },
    { name: '预算 10 天 < TTL 30 天：第 9 天仍可用', iat: 1000, exp: 1000 + 30 * D, maxOfflineMs: 10 * D, now: 1000 + 9 * D, ok: true, reason: 'ok' },
    { name: '预算 10 天 < TTL 30 天：超出预算即锁（旧实现要等 30 天）', iat: 1000, exp: 1000 + 30 * D, maxOfflineMs: 10 * D, now: 1000 + 10 * D + SKEW + 1, ok: false, reason: 'offline_budget_exhausted' },
    { name: '预算 10 天 > TTL 1 天：第 5 天宽限放行', iat: 1000, exp: 1000 + D, maxOfflineMs: 10 * D, now: 1000 + 5 * D, ok: true, reason: 'grace' },
    { name: '预算 10 天 > TTL 1 天：超出预算锁', iat: 1000, exp: 1000 + D, maxOfflineMs: 10 * D, now: 1000 + 10 * D + SKEW + 1, ok: false, reason: 'offline_budget_exhausted' },
    { name: '预算 0（必须在线）：时钟容差内可用', iat: 1000, exp: 1000 + 30 * D, maxOfflineMs: 0, now: 1000 + SKEW, ok: true, reason: 'ok' },
    { name: '预算 0（必须在线）：超出容差即锁', iat: 1000, exp: 1000 + 30 * D, maxOfflineMs: 0, now: 1000 + SKEW + 1, ok: false, reason: 'offline_budget_exhausted' },
  ]

  for (const c of cases) {
    it(c.name, () => {
      const { privateKey, publicKeyB64 } = makeTestSigner()
      const token = signGrant(
        buildGrantPayload({
          iat: c.iat,
          exp: c.exp,
          lic: null,
          ...(c.maxOfflineMs === undefined ? {} : { maxOfflineMs: c.maxOfflineMs }),
        }),
        privateKey
      )
      const res = verifyProGrant(token, { publicKeyB64, now: c.now })
      assert.equal(res.ok, c.ok, `activated（reason=${res.reason}）`)
      assert.equal(res.reason, c.reason)
      // grace 必须与「是否已过 exp」一致；放行时必须带回 claims（锁定时不带）
      if (res.ok) {
        assert.ok(res.claims, '通过时应带回 claims')
        assert.equal(res.reason === 'grace', c.now > c.exp)
      }
    })
  }

  it('服务端下发预算可以顶掉长 TTL —— 这就是「按许可证取消离线授权」的可下发版本', () => {
    const { privateKey, publicKeyB64 } = makeTestSigner()
    const iat = 1_000_000
    const token = signGrant(
      buildGrantPayload({ iat, exp: iat + 30 * D, lic: null, maxOfflineMs: D }),
      privateKey
    )
    assert.equal(verifyProGrant(token, { publicKeyB64, now: iat + D + SKEW }).ok, true, '第 1 天 + 容差内还能用')
    assert.equal(
      verifyProGrant(token, { publicKeyB64, now: iat + 2 * D }).reason,
      'offline_budget_exhausted',
      '第 2 天就该锁 —— 尽管 token 自己还有 28 天有效期'
    )
  })

  it('脏预算值（负数/字符串/NaN/null）按「老 token」处理，不把付费用户锁死', () => {
    const { privateKey, publicKeyB64 } = makeTestSigner()
    const iat = 1_000_000
    for (const bad of [-1, '0', Number.NaN, null]) {
      const token = signGrant(
        buildGrantPayload({ iat, exp: iat + 30 * D, lic: null, maxOfflineMs: bad }),
        privateKey
      )
      assert.equal(
        verifyProGrant(token, { publicKeyB64, now: iat + 5 * D }).ok,
        true,
        `bad=${JSON.stringify(bad)} 不应被脏值锁死`
      )
    }
  })

  it('伪造放大不了窗口：改时间无效，改字段导致验签失败', () => {
    const { privateKey, publicKeyB64 } = makeTestSigner()
    const iat = 1_000_000
    const token = signGrant(
      buildGrantPayload({ iat, exp: iat + 30 * D, lic: null, maxOfflineMs: 0 }),
      privateKey
    )
    assert.equal(verifyProGrant(token, { publicKeyB64, now: iat + SKEW + 1 }).ok, false, 'deadline 是绝对时刻，改本地时间不放大')

    const dot = token.indexOf('.')
    const claims = JSON.parse(Buffer.from(token.slice(0, dot), 'base64url').toString('utf8')) as Record<string, unknown>
    claims.maxOfflineMs = 365 * D // 攻击者想把「必须在线」改成一年
    const forged = `${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}${token.slice(dot)}`
    assert.equal(verifyProGrant(forged, { publicKeyB64, now: iat + SKEW + 1 }).reason, 'bad_signature')
  })
})
