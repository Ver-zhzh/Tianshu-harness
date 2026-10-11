/**
 * TokenLedgerStore — 本地 token 消耗台账引擎。
 *
 * 增量消费各会话 cache-log.jsonl（append-only）的计费行，折叠成
 * day × model(×provider) 累计记录，整体原子落盘。消费游标是字节偏移：
 * 上次读到 EOF，本次从 EOF 接着读，行边界天然对齐。
 *
 * 失效方向（修复纪律）：
 *  - 文件被截断（size < offset）→ 游标直接钉到当前 size、跳过未知区间，
 *    宁可少算绝不重算（重算会让已折叠的行再计一次）；
 *  - 折叠与游标同一份状态原子落盘——崩溃至多丢失「已折叠未落盘」的一段，
 *    下次从旧游标重扫重做，结果一致；
 *  - 行解析完全复用 usage-aggregator 的 parseUsageRows / 计费行判据，
 *    不自写过滤，口径不漂移。
 */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, readFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { writeFileAtomicSync } from '../fs-atomic.js'
import {
  dayKey,
  parseUsageRows,
  type CacheUsageRow,
  type PricingResolver,
} from '../cache/usage-aggregator.js'
import { computeUsageCost } from '../utils/pricing.js'
import type {
  TokenDayModelRecord,
  TokenLedgerState,
  TokenLedgerTotals,
  TokenUsageSnapshot,
} from './types.js'

const CACHE_LOG_NAME = 'cache-log.jsonl'

/** 与 usage-aggregator 的 rollup 键同构：provider 存在时参与复合键。 */
export function ledgerBucketKey(model: string, provider?: string): string {
  return provider ? `${provider}\0${model}` : model
}

/** 排序键的稳定序列化——digest 只依赖台账内容，与 Map/对象插入序无关。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
  return `{${entries.join(',')}}`
}

export function ledgerDigest(days: TokenLedgerState['days']): string {
  return createHash('sha256').update(stableStringify(days)).digest('hex')
}

function emptyTotals(): TokenLedgerTotals {
  return { requests: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, cost: 0 }
}

function round6(v: number): number {
  return Math.round(v * 1_000_000) / 1_000_000
}

export interface TokenLedgerStoreOptions {
  /** 状态文件路径（默认 tokenLedgerStatePath()） */
  statePath: string
  /** 会话根目录（默认 sessionsDir()，即全项目） */
  sessionsRoot: string
  resolvePricing?: PricingResolver
  /** 时钟注入（测试） */
  now?: () => number
}

export interface LedgerRefreshResult {
  newRows: number
  scannedFiles: number
}

export class TokenLedgerStore {
  private readonly statePath: string
  private readonly sessionsRoot: string
  private readonly resolvePricing?: PricingResolver
  private readonly now: () => number
  private state: TokenLedgerState | undefined
  private refreshing: Promise<LedgerRefreshResult> | undefined

  constructor(options: TokenLedgerStoreOptions) {
    this.statePath = options.statePath
    this.sessionsRoot = options.sessionsRoot
    this.resolvePricing = options.resolvePricing
    this.now = options.now ?? (() => Date.now())
  }

  get deviceId(): string {
    return this.load().deviceId
  }

  get filePath(): string {
    return this.statePath
  }

  get lastPushAt(): string | undefined {
    return this.load().lastPushAt
  }

  get lastPushResult(): TokenLedgerState['lastPushResult'] {
    return this.load().lastPushResult
  }

  get lastPushedDigest(): string | undefined {
    return this.load().lastPushedDigest
  }

  /** 当前台账内容摘要；与 lastPushedDigest 不同即存在未推送变更。 */
  digest(): string {
    return ledgerDigest(this.load().days)
  }

  totals(): TokenLedgerTotals {
    const totals = emptyTotals()
    for (const buckets of Object.values(this.load().days)) {
      for (const record of Object.values(buckets)) {
        totals.requests += record.requests
        totals.input += record.input
        totals.output += record.output
        totals.cacheRead += record.cacheRead
        totals.cacheCreate += record.cacheCreate
        totals.cost += record.cost
      }
    }
    totals.cost = round6(totals.cost)
    return totals
  }

  /** 累计 day×model 明细（date 升序、同日 cost 降序），可经 since 过滤近 N 天。 */
  records(sinceDate?: string): TokenDayModelRecord[] {
    const out: TokenDayModelRecord[] = []
    for (const [date, buckets] of Object.entries(this.load().days)) {
      if (sinceDate && date < sinceDate) continue
      for (const record of Object.values(buckets)) out.push({ ...record })
    }
    out.sort((a, b) => a.date.localeCompare(b.date) || b.cost - a.cost || b.input - a.input)
    return out
  }

  /** 构造推送论坛的累计快照。 */
  snapshot(deviceName: string): TokenUsageSnapshot {
    const records = this.records()
    return {
      version: 1,
      deviceId: this.deviceId,
      deviceName,
      sentAt: new Date(this.now()).toISOString(),
      totals: this.totals(),
      days: records,
    }
  }

  /**
   * 扫描 sessionsRoot 下所有 cache-log，把上次游标之后的新行折叠进台账，
   * 然后「游标 + days」同一份状态原子落盘。进程内并发 refresh 共享同一趟。
   */
  refresh(): Promise<LedgerRefreshResult> {
    if (this.refreshing) return this.refreshing
    this.refreshing = this.refreshImpl()
      .finally(() => { this.refreshing = undefined })
    return this.refreshing
  }

  /** 推送回执：2xx 才钉 lastPushedDigest；失败只留 lastPushResult，不动游标。 */
  markPushed(result: { ok: boolean; status?: number; code?: string; error?: string }): void {
    const state = this.load()
    const at = new Date(this.now()).toISOString()
    if (result.ok) {
      state.lastPushAt = at
      state.lastPushedDigest = ledgerDigest(state.days)
    }
    state.lastPushResult = { ...result, at }
    this.persist()
  }

  private load(): TokenLedgerState {
    if (this.state) return this.state
    let loaded: TokenLedgerState | undefined
    try {
      const parsed = JSON.parse(
        // 状态文件小（day×model 粒度），同步读即可；坏了就重建——台账是 cache-log
        // 的派生物，重置 offsets/days 后全量重扫可恢复。
        readFileSync(this.statePath, 'utf8'),
      ) as TokenLedgerState
      if (parsed && parsed.version === 1 && typeof parsed.deviceId === 'string'
        && parsed.offsets && typeof parsed.offsets === 'object'
        && parsed.days && typeof parsed.days === 'object') {
        loaded = parsed
      }
    } catch { /* 缺失或损坏：从空台账重建 */ }
    this.state = loaded ?? { version: 1, deviceId: randomUUID(), offsets: {}, days: {} }
    return this.state
  }

  private persist(): void {
    if (!this.state) return
    try {
      writeFileAtomicSync(this.statePath, JSON.stringify(this.state))
    } catch { /* best-effort：内存态仍在，下次 refresh 再试 */ }
  }

  private async refreshImpl(): Promise<LedgerRefreshResult> {
    const state = this.load()
    const files = await findCacheLogFiles(this.sessionsRoot)
    let newRows = 0
    let dirty = false

    for (const file of files) {
      const rel = relative(this.sessionsRoot, file).split(sep).join('/')
      const prevOffset = state.offsets[rel] ?? 0
      let size: number
      try {
        size = (await stat(file)).size
      } catch {
        continue
      }
      if (size < prevOffset) {
        // 截断：未知区间已不可信，跳过重算（往少算侧失效，见模块 docstring）。
        state.offsets[rel] = size
        dirty = true
        continue
      }
      if (size === prevOffset) continue

      const content = await readFromOffset(file, prevOffset)
      const rows = parseUsageRows(content)
      for (const row of rows) this.fold(state, row)
      newRows += rows.length
      state.offsets[rel] = size
      dirty = true
    }

    if (dirty) this.persist()
    return { newRows, scannedFiles: files.length }
  }

  private fold(state: TokenLedgerState, row: CacheUsageRow): void {
    const date = dayKey(row.t)
    const key = ledgerBucketKey(row.model, row.provider)
    let buckets = state.days[date]
    if (!buckets) state.days[date] = buckets = {}
    let record = buckets[key]
    if (!record) {
      record = {
        date, model: row.model, ...(row.provider ? { provider: row.provider } : {}),
        requests: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, cost: 0,
      }
      buckets[key] = record
    }
    record.requests += 1
    record.input += row.input
    record.output += row.output
    record.cacheRead += row.cacheRead
    record.cacheCreate += row.cacheCreate
    const pricing = this.resolvePricing?.(row.model, row.provider, row.t)
    if (pricing) {
      record.cost += computeUsageCost({
        input_tokens: row.input,
        output_tokens: row.output,
        cache_read_input_tokens: row.cacheRead,
        cache_creation_input_tokens: row.cacheCreate,
      }, pricing).total
    }
  }
}

/** 与 usage-aggregator findCacheLogs 同布局：`<root>/<sid>/` 或 `<root>/<slug>/<sid>/`。 */
async function findCacheLogFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const visit = async (dir: string, depth: number): Promise<void> => {
    try {
      await stat(join(dir, CACHE_LOG_NAME))
      files.push(join(dir, CACHE_LOG_NAME))
    } catch { /* 本层无日志 */ }
    if (depth >= 2) return
    let children: string[] = []
    try {
      children = (await readdir(dir, { withFileTypes: true }))
        .filter(e => e.isDirectory()).map(e => e.name)
    } catch { /* 目录不可读 */ }
    await Promise.all(children.map(name => visit(join(dir, name), depth + 1)))
  }
  await visit(root, 0)
  return files
}

async function readFromOffset(file: string, offset: number): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of createReadStream(file, { start: offset })) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}
