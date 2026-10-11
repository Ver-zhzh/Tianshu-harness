/**
 * TokenLedgerService — 台账编排层：折叠新行 → 维护本地快照 → 按配置推送论坛。
 *
 * 三个消费面：
 *  - server 路由（summary/status/sync，见 src/server/token-ledger-routes.ts）
 *  - bootstrap 自动同步（autoSync=true 且配了 endpoint 时，会话内按间隔推）
 *  - shutdown 冲刷（有界超时，best-effort，绝不阻塞退出）
 *
 * 配置来源：config.tokenLedger（schema 见 src/config/schema.ts），env
 * RIVET_FORUM_API / RIVET_FORUM_TOKEN 覆盖 endpoint/apiKey（联调与多环境用）。
 */
import { hostname } from 'node:os'
import { tokenLedgerStatePath, sessionsDir } from '../config/paths.js'
import type { Config } from '../config/schema.js'
import { findUsagePricing } from '../utils/deepseek-pricing.js'
import type { PricingResolver } from '../cache/usage-aggregator.js'
import { pushTokenUsageSnapshot, type FetchLike, type ForumPushResult } from './forum-sync.js'
import { TokenLedgerStore, type LedgerRefreshResult } from './store.js'
import type { TokenDayModelRecord, TokenLedgerTotals } from './types.js'

const DEFAULT_SYNC_INTERVAL_MINUTES = 30

export interface TokenLedgerServiceDeps {
  statePath?: string
  sessionsRoot?: string
  fetchImpl?: FetchLike
  now?: () => number
}

export interface TokenLedgerSyncOutcome {
  ok: boolean
  /** 未发起推送的原因 */
  skipped?: 'disabled' | 'no_endpoint' | 'unchanged'
  push?: ForumPushResult
  newRows?: number
  digest?: string
}

export interface TokenLedgerStatus {
  enabled: boolean
  endpointConfigured: boolean
  autoSync: boolean
  deviceId: string
  deviceName: string
  totals: TokenLedgerTotals
  dayCount: number
  /** 有本地变更未被论坛确认 */
  pending: boolean
  lastPushAt?: string
  lastPushResult?: { ok: boolean; status?: number; code?: string; error?: string; at?: string }
  statePath: string
}

export class TokenLedgerService {
  private readonly config: Config
  private readonly store: TokenLedgerStore
  private readonly fetchImpl?: FetchLike
  private readonly now: () => number
  private timer: ReturnType<typeof setInterval> | undefined
  private syncing: Promise<TokenLedgerSyncOutcome> | undefined

  constructor(config: Config, deps: TokenLedgerServiceDeps = {}) {
    this.config = config
    this.fetchImpl = deps.fetchImpl
    this.now = deps.now ?? (() => Date.now())
    const providers = config.provider.providers
    const defaultProvider = config.provider.default
    const resolvePricing: PricingResolver = (model, provider, timestamp) =>
      findUsagePricing(providers, provider ?? defaultProvider, model, timestamp ?? this.now())
    this.store = new TokenLedgerStore({
      statePath: deps.statePath ?? tokenLedgerStatePath(),
      sessionsRoot: deps.sessionsRoot ?? sessionsDir(),
      resolvePricing,
      now: this.now,
    })
  }

  get enabled(): boolean {
    return this.config.tokenLedger.enabled !== false
  }

  get endpoint(): string | undefined {
    return process.env.RIVET_FORUM_API || this.config.tokenLedger.forum?.endpoint
  }

  private get apiKey(): string | undefined {
    return process.env.RIVET_FORUM_TOKEN || this.config.tokenLedger.forum?.apiKey
  }

  private get deviceName(): string {
    return this.config.tokenLedger.deviceName || hostname()
  }

  /** 折叠 cache-log 新增计费行（幂等增量，游标推进后落盘）。 */
  refresh(): Promise<LedgerRefreshResult> {
    if (!this.enabled) return Promise.resolve({ newRows: 0, scannedFiles: 0 })
    return this.store.refresh()
  }

  /** 台账 day×model 明细（date 升序），sinceDate（YYYY-MM-DD）起。 */
  records(sinceDate?: string): TokenDayModelRecord[] {
    return this.store.records(sinceDate)
  }

  status(): TokenLedgerStatus {
    const totals = this.store.totals()
    return {
      enabled: this.enabled,
      endpointConfigured: Boolean(this.endpoint),
      autoSync: this.timer !== undefined,
      deviceId: this.store.deviceId,
      deviceName: this.deviceName,
      totals,
      dayCount: this.store.records().length,
      // 空台账不算 pending——还没有任何值得论坛确认的内容。
      pending: this.enabled && totals.requests > 0 && this.store.digest() !== this.store.lastPushedDigest,
      lastPushAt: this.store.lastPushAt,
      lastPushResult: this.store.lastPushResult,
      statePath: this.store.filePath,
    }
  }

  /** 手动/定时同步：refresh → 摘要未变跳过 → 推送 → 落回执。进程内串行。 */
  syncNow(): Promise<TokenLedgerSyncOutcome> {
    if (this.syncing) return this.syncing
    this.syncing = this.syncImpl().finally(() => { this.syncing = undefined })
    return this.syncing
  }

  /**
   * 启动会话内自动同步。返回是否真正启动（未开 autoSync 或未配 endpoint 时
   * 是 no-op）。定时器 unref——绝不因为它的存在拖住进程退出。
   */
  startAutoSync(): boolean {
    if (this.timer || !this.enabled) return false
    if (this.config.tokenLedger.forum?.autoSync !== true || !this.endpoint) return false
    const minutes = this.config.tokenLedger.forum.intervalMinutes ?? DEFAULT_SYNC_INTERVAL_MINUTES
    this.timer = setInterval(() => {
      void this.syncNow().catch(() => { /* fire-and-forget：失败回执已落在状态里 */ })
    }, minutes * 60_000)
    this.timer.unref?.()
    return true
  }

  stopAutoSync(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** shutdown 冲刷：仅 autoSync 全开时推最后一趟，有界等待不拖退出。 */
  async shutdownFlush(timeoutMs = 3_000): Promise<void> {
    if (!this.timer) return
    this.stopAutoSync()
    try {
      await Promise.race([
        this.syncNow(),
        new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
      ])
    } catch { /* best-effort */ }
  }

  private async syncImpl(): Promise<TokenLedgerSyncOutcome> {
    if (!this.enabled) return { ok: false, skipped: 'disabled' }
    const { newRows } = await this.refresh()
    const endpoint = this.endpoint
    if (!endpoint) return { ok: false, skipped: 'no_endpoint', newRows }

    const digest = this.store.digest()
    // 台账没有 2xx 确认之外的变更时不重复推送（论坛端是累计 upsert，重推无信息量）。
    if (digest === this.store.lastPushedDigest && newRows === 0) {
      return { ok: true, skipped: 'unchanged', newRows, digest }
    }

    const push = await pushTokenUsageSnapshot(this.store.snapshot(this.deviceName), {
      endpoint,
      apiKey: this.apiKey,
      fetchImpl: this.fetchImpl,
    })
    this.store.markPushed(push.ok ? { ok: true, status: push.status } : {
      ok: false,
      status: 'status' in push ? push.status : undefined,
      code: 'code' in push ? push.code : undefined,
      error: 'error' in push ? push.error : undefined,
    })
    return { ok: push.ok, push, newRows, digest }
  }
}
