/**
 * server-approval.ts — MCP **连接级**审批存储（issue #215）。
 *
 * 与工具调用级的 `createMcpConnectorConsent`（wrapper.ts:26）是两层不同的门：
 * 那道门在工具**首次 execute** 时自动授予（wrapper.ts:27 `grantConsent`），门的是
 * 「用不用这个连接器的工具」，拦不住「把 server 拉起来」这件事本身。一个 stdio
 * MCP server 在连接瞬间就会执行它配置的 `command`（npx/uvx/任意可执行文件）并把
 * `env` 注入子进程——等同于「在本机跑一段写在配置里的代码」。SECURITY.md 的信任
 * 边界要求在用户显式授权前不执行仓库内容；连接级审批是这个边界在 MCP 上的对应物。
 *
 * 因此本 store 门的是 **spawn 之前**（manager 的 `_connectAndDiscover` 入口，
 * `initialize` / `reconcileFromConfig` / REST 热加三个入口共用同一道门）。
 *
 * 键用**指纹**（`mcpServerFingerprint`）而不是 serverId：审批语义是「我批准这条
 * **命令**」，不是「我批准这个 serverId」。若按 id 记，改掉 command/args/cwd/env
 * 键名/url 之后旧审批仍然生效——等于给未来任意命令留了一个永久后门。
 *
 * 决策持久化在 `<rivetHome>/mcp-approvals.json`（按指纹键控，永不写进仓库目录，
 * 0o600）。`rivetHome()` 尊重 RIVET_HOME，测试据此注入临时 home。
 *
 * 无交互 UI 时 **fail-closed**（#443，2026-10-10）——见 `mcpApprovalInteractive()`。
 * 历史上（#215 至 #443 之间）是 fail-open；#443 改判依据：PR #354 给 headless
 * 装配 MCP 后，无 UI 放行变成真实可达的 tool poisoning 攻击面。显式
 * `RIVET_MCP_APPROVAL=open` 保持放行（CI / 脚本 / desktop sidecar——有人值守
 * 宿主，审批 UI 落地前由壳显式注入）。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { rivetHome } from '../config/paths.js'
import { writeFileAtomicSync } from '../fs-atomic.js'
import type { McpServerConfig } from './config.js'

/** 连接级审批的三态判定。 */
export type McpApprovalDecision = 'approved' | 'awaiting' | 'denied'

/**
 * 待批准连接的 server 摘要——供 UI（`GET /mcp/status.pendingApproval`）消费。
 *
 * **只含 env 的键名**：值一律遮蔽。MCP env 里多是 API key / token，把它们
 * 回传到面板等于把凭据搬到另一个出口；审批只需要让用户看清「会跑什么命令、
 * 会注入哪些变量」，不需要看见值。
 */
export interface McpPendingApproval {
  serverId: string
  /** command+args+cwd+env 键名+url 的 sha256（审批键）。 */
  fingerprint: string
  /** stdio（有 command）或 remote（有 url）。 */
  source: 'stdio' | 'remote'
  command?: string
  args?: string[]
  cwd?: string
  /** env 变量**键名**（已排序）。 */
  envKeys: string[]
  url?: string
  /** 待批原因：缺省 = 连接级审批（#215）；'inventory-change' = 工具清单快照门
   *  （rug pull 防线 ①：已连接后重拉发现清单变更，已断开并拦截待重新审批）。 */
  reason?: 'inventory-change'
  /** 被拦清单的整体 hash——approve 时 arm，重拉精确匹配才消费放行（防 TOCTOU）。 */
  inventoryHash?: string
  /** 清单变更摘要（工具名级）。 */
  inventoryDiff?: { added: string[]; removed: string[]; changed: string[] }
  /** 检测到变更的时间（ISO）。 */
  changedAt?: string
}

interface ApprovalEntry {
  serverId: string
  /** 批准/拒绝时间（ISO 字符串）。 */
  at: string
}

interface ApprovalStore {
  /** fingerprint → 批准记录。 */
  approved: Record<string, ApprovalEntry>
  /** fingerprint → 拒绝记录。 */
  denied: Record<string, ApprovalEntry>
}

function approvalStorePath(): string {
  return join(rivetHome(), 'mcp-approvals.json')
}

function readApprovalStore(): ApprovalStore {
  try {
    const raw = JSON.parse(readFileSync(approvalStorePath(), 'utf-8')) as Partial<ApprovalStore>
    if (raw && typeof raw === 'object') {
      return {
        approved: raw.approved && typeof raw.approved === 'object' ? raw.approved : {},
        denied: raw.denied && typeof raw.denied === 'object' ? raw.denied : {},
      }
    }
  } catch {
    // 缺失/坏文件按「未审批」处理——fail-closed（无记录 = 待批准）。
  }
  return { approved: {}, denied: {} }
}

function writeApprovalStore(store: ApprovalStore): void {
  const dir = rivetHome()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileAtomicSync(approvalStorePath(), JSON.stringify(store, null, 2) + '\n')
}

/**
 * 一个 server 配置的连接审批指纹。
 *
 * 覆盖「拉起这个 server 会实际执行/连到的一切」：command、args、cwd、env 的
 * **键名**（值不参与——改一个 secret 的值不该逼用户重新审批）、url。任一项变化
 * ⇒ 指纹变化 ⇒ 视为新 server，需重新审批。
 */
export function mcpServerFingerprint(cfg: McpServerConfig): string {
  const payload = JSON.stringify({
    command: cfg.command ?? null,
    args: cfg.args ?? null,
    cwd: cfg.cwd ?? null,
    envKeys: cfg.env ? Object.keys(cfg.env).sort() : [],
    url: cfg.url ?? null,
  })
  return createHash('sha256').update(payload).digest('hex')
}

/** 查询某配置是否已获批 / 被拒 / 待批（**不含** fail-open 判定）。 */
export function checkMcpServerApproval(cfg: McpServerConfig): McpApprovalDecision {
  const fp = mcpServerFingerprint(cfg)
  const store = readApprovalStore()
  if (Object.prototype.hasOwnProperty.call(store.approved, fp)) return 'approved'
  if (Object.prototype.hasOwnProperty.call(store.denied, fp)) return 'denied'
  return 'awaiting'
}

/**
 * 是否存在「可批准 MCP 连接的交互界面」。
 *
 * #443（2026-10-10）把无 UI 的缺省从 fail-open 改为 fail-closed：
 *   1. `RIVET_MCP_APPROVAL=gate` → 门生效（审批 UI 宿主显式设置；尚未有宿主
 *      接入——desktop/WSL attach/vscode 三处 spawn 均显式设 open，审批 UI
 *      三件套落地时改 gate）。
 *   2. `RIVET_MCP_APPROVAL=open` → 强制 fail-open（用户显式选择；CI / 一次性
 *      脚本 / 测试，以及有人值守宿主的 spawn 点——desktop lib.rs、WSL
 *      attach wsl_attach.rs、vscode 扩展 launcher.ts 三处注入）。
 *   3. 未显式指定 → 看 stdout 是否 TTY：真终端可弹提示 → gate；headless / `-p` /
 *      管道重定向 → **fail-closed（awaiting，spawn 前拦截）**。headless 没有人
 *      能看见、也没有人能回应审批提示，而 MCP spawn 等同「在本机跑配置里写的
 *      代码」（stdio server 连接瞬间执行 command 并注入 env）——把这条攻击面
 *      留给 tool poisoning（描述被篡改、清单变更）静默放行，代价大于让无人值守
 *      脚本显式设 open。
 *
 * 为什么不再沿袭 #215 的 fail-open：#215 拍板时无头路径**不装配 MCP**
 * （main.ts headless 分支根本不调 initializeMcp），fail-open 是一纸空文、
 * 无实际暴露面；PR #354（2026-10-04）给 headless 补齐 MCP 装配后，这条
 * fail-open 变成了真实可达的静默放行路径（#443 实测 stderr 告警即证）。
 * 兼容性：desktop / WSL attach / vscode 三处有人值守 spawn 均显式设 open，
 * 行为不变；CI / 脚本设 open 即恢复原行为；TTY 交互路径不变。首次无批准记录
 * 的 headless 用户会看到明确的 awaiting-approval 拦截与可执行指引（TTY 重跑
 * 审批 / 显式 open），不再是零信号的静默放行。
 */
export function mcpApprovalInteractive(): boolean {
  const mode = process.env.RIVET_MCP_APPROVAL
  if (mode === 'gate') return true
  if (mode === 'open') return false
  return Boolean(process.stdout.isTTY)
}

/**
 * awaiting 状态的用户可读指引（manager 落进 connection state 的 error 字段）。
 * 按宿主分流：交互宿主有 REST 审批出口；headless（#443 fail-closed 拦截）对
 * CLI 无头用户指向可执行动作——TTY 里跑一次完成审批 / 显式 open——而不是
 * 指向不可达的 POST /mcp/servers/:id/approve 死端点。
 */
export function awaitingApprovalHint(serverId: string): string {
  return mcpApprovalInteractive()
    ? `MCP server "${serverId}" is awaiting approval — not started. Approve via POST /mcp/servers/${serverId}/approve`
    : `MCP server "${serverId}" is blocked — headless has no approval UI (#443 fail-closed). Run once in an interactive terminal to approve, or set RIVET_MCP_APPROVAL=open if you trust this config.`
}

let failClosedNoticed = false
function notifyFailClosedOnce(): void {
  if (failClosedNoticed) return
  failClosedNoticed = true
  console.error(
    '[rivet] 检测到无交互 UI（headless / 非 TTY / 未设 RIVET_MCP_APPROVAL），' +
    'MCP 连接级审批门 fail-closed——服务器不启动。' +
    '一次性脚本 / CI 明确信任该配置时设 RIVET_MCP_APPROVAL=open 放行；' +
    '或先在交互终端（TTY）里运行一次以完成审批。',
  )
}

/**
 * 解析一个 server 配置是否允许连接——**生产入口**（manager 的
 * `_mcpApprovalDecision` 委托到这里）。
 */
export function resolveMcpApproval(cfg: McpServerConfig): McpApprovalDecision {
  // 显式 open：无条件放行（CI / 一次性脚本明知故犯的出口，保持 #215 语义）。
  if (process.env.RIVET_MCP_APPROVAL === 'open') return 'approved'
  if (!mcpApprovalInteractive()) {
    // headless 无 UI：查持久化记录（此前在 TTY 里已批准的指纹依然有效）；
    // 未知指纹按 store 结果原样返回——无记录 = awaiting（manager 拦在 spawn
    // 前并登记 pending，用户可在 TTY 宿主 approve），denied 记录则拒绝。
    // #443 的 fail-closed 语义由「拦截 spawn」承载，不是改写返回值。
    // CI 恢复原行为设 RIVET_MCP_APPROVAL=open。
    const decision = checkMcpServerApproval(cfg)
    if (decision !== 'approved') notifyFailClosedOnce()
    return decision
  }
  return checkMcpServerApproval(cfg)
}

/** 批准某配置的连接（幂等；会清掉同指纹的拒绝记录）。 */
export function approveMcpServer(cfg: McpServerConfig): void {
  const fp = mcpServerFingerprint(cfg)
  const store = readApprovalStore()
  delete store.denied[fp]
  store.approved[fp] = { serverId: cfg.command ?? cfg.url ?? fp, at: new Date().toISOString() }
  writeApprovalStore(store)
}

/** 拒绝某配置的连接（幂等；会清掉同指纹的批准记录）。 */
export function denyMcpServer(cfg: McpServerConfig): void {
  const fp = mcpServerFingerprint(cfg)
  const store = readApprovalStore()
  delete store.approved[fp]
  store.denied[fp] = { serverId: cfg.command ?? cfg.url ?? fp, at: new Date().toISOString() }
  writeApprovalStore(store)
}

/** 清掉某配置的审批记录（approve/deny 都清，回到待批准）。用于「撤销」。 */
export function forgetMcpServerApproval(cfg: McpServerConfig): void {
  const fp = mcpServerFingerprint(cfg)
  const store = readApprovalStore()
  const hadApproved = Object.prototype.hasOwnProperty.call(store.approved, fp)
  const hadDenied = Object.prototype.hasOwnProperty.call(store.denied, fp)
  if (!hadApproved && !hadDenied) return
  delete store.approved[fp]
  delete store.denied[fp]
  writeApprovalStore(store)
}
