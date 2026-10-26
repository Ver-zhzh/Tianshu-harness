/**
 * 发布前冒烟：把推荐列表里的每个 MCP 预设真的拉起来一次。
 *
 * 为什么需要（issue #149 建议 4）：MCP_PRESETS 是硬编码的静态表，上游改包名、
 * 下架包、改协议都不会自动反映进来。单测能验证表的结构自洽，验证不了
 * 「npx -y <pkg> 是不是真的能连上」——而那正是用户点「启用」时期待的事。
 *
 * 与单测的分工：单测锁结构 + 包新鲜度（RIVET_MCP_LIVE=1 时联网问 npm）；
 * 本脚本干重活——真实启动子进程、握手、listTools，走的是生产同一条
 * createTransport 路径，不 mock 中间层。所以它慢（首次要拉包）且要联网，
 * 属于「发布前跑一次」而不是「每次提交跑」。
 *
 * 用法：
 *   npm exec -- tsx scripts/smoke-mcp-presets.ts
 *   npm exec -- tsx scripts/smoke-mcp-presets.ts --only context7
 *   npm exec -- tsx scripts/smoke-mcp-presets.ts --all           # 连需凭据的也跑
 *   npm exec -- tsx scripts/smoke-mcp-presets.ts --clean-path    # 系统默认 PATH
 *
 * 退出码：任一失败 → 1（可直接接进发版流程当门禁）。
 */
import { MCP_PRESETS, type McpPreset } from '../src/mcp/presets.js'
import { createTransport } from '../src/mcp/transport-factory.js'
import type { McpServerConfig } from '../src/mcp/config.js'

const argv = process.argv.slice(2)
const onlyIdx = argv.indexOf('--only')
const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : undefined
const includeCredentialed = argv.includes('--all')
const cleanPath = argv.includes('--clean-path')
const verbose = argv.includes('--verbose')

interface SmokeResult {
  id: string
  ok: boolean
  detail: string
  ms: number
  /** stdio 连上后的实际工具名（用于与 expectedTools 对账）。 */
  toolNames?: string[]
  /**
   * expectedTools 里声明了、实际却没有的工具名。
   *
   * 这是「预设描述失实」的探测器：卡片上列的工具名是用户判断「值不值得接」的
   * 依据，上游改名/拆分后不会有人去改这张静态表。**只报警不算失败**——MCP
   * server 的工具面会随凭据权限变化（只读 token 下写工具本就不注册），不能
   * 把「权限收窄」误判成「描述错了」。
   */
  missingTools?: string[]
}

/**
 * 收紧到系统默认 PATH。
 *
 * 验的是「推荐列表不依赖用户 PATH 里的额外目录」（nvm / brew / ~/.local/bin …）:
 * 封版应用拿到的 PATH 常常就是系统默认那几条，而 npx 与 node 由我们自己注入。
 * 这一步在 macOS 上尤其有意义——开发机的 PATH 总是比用户机富。
 */
function applyCleanPath(): void {
  if (!cleanPath) return
  const isWin = process.platform === 'win32'
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  process.env.PATH = isWin
    ? [`${root}\\System32`, root, `${root}\\System32\\Wbem`].join(';')
    : '/usr/bin:/bin:/usr/sbin:/sbin'
  console.log(`[clean-path] PATH=${process.env.PATH}\n`)
}

async function smokeStdio(preset: McpPreset): Promise<SmokeResult> {
  const cfg: McpServerConfig = {
    serverId: preset.id,
    command: preset.command!,
    args: preset.args ?? [],
  }
  const t0 = Date.now()
  const { client, transport } = await createTransport(cfg, { timeoutMs: 90_000 })
  try {
    const listed = await client.listTools()
    const names = listed.tools.map((t) => t.name)
    const declared = preset.expectedTools ?? []
    const missing = declared.filter((n) => !names.includes(n))
    return {
      id: preset.id,
      ok: true,
      detail: `${names.length} 个工具`,
      ms: Date.now() - t0,
      toolNames: names,
      ...(missing.length > 0 ? { missingTools: missing } : {}),
    }
  } finally {
    try { await transport.close() } catch { /* 已经没了 */ }
  }
}

/**
 * remote 预设只看端点是否活着：没有凭据时 401/403 恰恰证明端点在（只是拒了
 * 匿名请求），404/5xx 才是真问题。要验完整握手得走 OAuth，那是另一件事。
 */
async function smokeRemote(preset: McpPreset): Promise<SmokeResult> {
  const t0 = Date.now()
  const res = await fetch(preset.url!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } },
    }),
    signal: AbortSignal.timeout(30_000),
  })
  const alive = res.status < 500 && res.status !== 404
  const note = res.status === 401 || res.status === 403 ? '（端点存活，需凭据）' : ''
  return { id: preset.id, ok: alive, detail: `HTTP ${res.status}${note}`, ms: Date.now() - t0 }
}

async function main(): Promise<void> {
  applyCleanPath()

  const skipped: string[] = []
  const targets = MCP_PRESETS.filter((p) => {
    if (only && p.id !== only) return false
    // 需凭据的预设默认跳过：它们连不上是「没配 key」，不是「推荐列表有问题」，
    // 混在一起会淹掉真正的信号。要一起跑用 --all。
    if (
      !includeCredentialed
      && ((p.requiredEnv?.length ?? 0) > 0 || (p.requiredHeaders?.length ?? 0) > 0)
    ) {
      skipped.push(`${p.id}（需凭据）`)
      return false
    }
    return true
  })

  if (targets.length === 0) {
    console.log(only ? `没有 id 为 "${only}" 的预设` : '没有可跑的预设')
    process.exitCode = 1
    return
  }

  console.log(`冒烟 ${targets.length} 个预设${cleanPath ? '（clean-path）' : ''}：\n`)
  const results: SmokeResult[] = []
  for (const p of targets) {
    process.stdout.write(`  ${p.id.padEnd(14)} ${p.transport.padEnd(15)} … `)
    try {
      const r = p.transport === 'stdio' ? await smokeStdio(p) : await smokeRemote(p)
      results.push(r)
      const warn = r.missingTools?.length ? `   ⚠️ 声明了但未返回：${r.missingTools.join(', ')}` : ''
      console.log(`${r.ok ? '✅' : '❌'} ${r.detail} (${r.ms}ms)${warn}`)
      // 实际工具名默认不打（ms365 有 188 个，一屏刷不完）；核对描述漂移时才要。
      if (verbose && r.toolNames?.length) console.log(`     实际工具：${r.toolNames.join(', ')}`)
    } catch (err) {
      const detail = ((err as Error)?.message ?? String(err)).slice(0, 140)
      results.push({ id: p.id, ok: false, detail, ms: 0 })
      console.log(`❌ ${detail}`)
    }
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`)
  if (skipped.length > 0) console.log(`跳过 ${skipped.length}：${skipped.join('、')}`)
  // 描述漂移只报不拦（见 SmokeResult.missingTools 的注释）：工具面随凭据权限变化，
  // 把「权限收窄」判成失败会让这个脚本在 CI 里长期红着，然后被人忽略。
  const drifted = results.filter((r) => (r.missingTools?.length ?? 0) > 0)
  if (drifted.length > 0) {
    console.log(`\n预设描述待核对（不影响退出码）：`)
    for (const d of drifted) {
      console.log(`  - ${d.id}: expectedTools 声明了但未返回 ${d.missingTools!.join(', ')}`)
    }
  }
  if (failed.length > 0) {
    console.log(`\n失败项：`)
    for (const f of failed) console.log(`  - ${f.id}: ${f.detail}`)
    process.exitCode = 1
  }
}

await main()
