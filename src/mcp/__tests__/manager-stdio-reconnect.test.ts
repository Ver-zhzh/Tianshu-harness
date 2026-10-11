import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { McpManager } from '../manager.js'

// 测 stdio 重连语义，不测审批门（#443 起无 UI 缺省 fail-closed，见 manager.test.ts 头注释）。
process.env.RIVET_MCP_APPROVAL = 'open'

/**
 * issue #148：stdio 传输的 MCP server 子进程退出后不重连、也不更新状态。
 *
 * 作者的对照实验证明了两件事：重连机制本身是好的（remote 走通了
 * degraded → 重连成功），但 stdio 被一条短路条件排除在外
 * （`transportType !== 'stdio'`），于是 `_onTransportClosed` 永不被调用。现场表现
 * 是「杀掉子进程后 10+ 分钟无反应，UI 仍显示 Not connected」。
 *
 * 他自己注明未验证的一环是「真实中断时 SDK 会不会自动调 onclose」——他的对照
 * 实验是**手工调用** onclose 触发的。补测下来答案是会：SDK 在管道 close 时执行
 * `this.onclose?.()`（MCP SDK 的 stdio.js，`_process.on('close')` 分支，实测
 * SIGKILL 后 122ms 触发）。所以修法是挂上钩子，而不是另找信号源。
 *
 * 用自带的 min-stdio-server 夹具而非生态包：`npx -y <pkg>` 首次拉包十几秒且要
 * 联网，会让这条回归既慢又脆。夹具只实现 initialize / tools/list，30 行看完。
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/min-stdio-server.mjs', import.meta.url))

/**
 * 这条测试曾因「进程跑完不退出」而只能门控，根因值得记下来（排查花了几轮）：
 *
 * 不是 Socket 残留——tsx 环境本身就有两个基线 Socket（空文件跑完也是它们），
 * 而基线进程两秒就退了。真凶是 `McpManager.shutdown()`：它 close transport 会
 * 触发 onclose 钩子，钩子又把子进程重新拉起来——shutdown 反倒制造出一个新进程，
 * 把测试进程吊在 `ChildProcess exitCode=null` 上。已在 shutdown() 里补上抑制
 * 标记（对 remote 同样必要，它的 onclose 一直是我们挂的），故本条可以常驻跑。
 */

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.fail(`等待超时：${what}`)
}

test('stdio server 子进程被杀后：进 degraded → 自动重连 → 工具面恢复并推回宿主（issue #148）', async () => {
  let pushedToolCount: number | null = null
  const mgr = new McpManager(
    { enabled: true, timeoutMs: 30_000, servers: { min: { command: process.execPath, args: [FIXTURE] } } },
    { onToolsChanged: (tools) => { pushedToolCount = tools.length } },
  )
  try {
    await mgr.initialize()
    const statusOf = () => mgr.getStates().find((s) => s.serverId === 'min')?.status
    assert.equal(statusOf(), 'connected', '夹具应先正常连上')
    assert.equal(mgr.getAllTools().length, 1, '夹具暴露 1 个工具')

    const pid = mgr.getConnection('min')?.transport.pid
    assert.equal(typeof pid, 'number', '需要 pid 才能模拟崩溃')
    process.kill(pid as number, 'SIGKILL')

    // 修复前：状态永远停在 connected（钩子没挂上，_onTransportClosed 从不执行），
    // 这一等必然超时 → 测试红。这正是 issue 描述的现象。
    await waitFor(
      () => statusOf() === 'degraded',
      8_000,
      '子进程退出后应进入 degraded（证明 onclose 钩子确实挂上了）',
    )

    // backoff 2s + 重新 spawn + 握手，应回到 connected。
    await waitFor(() => statusOf() === 'connected', 25_000, '应自动重连并恢复 connected')
    assert.equal(mgr.getAllTools().length, 1, '重连后工具面应恢复')
    // 宿主侧是主动推送语义（injectMcpTools 只覆盖已有 live agent 的会话）——
    // 不推的话，用户看到的是「状态绿了但 mcp__* 工具还是不在」，重连等于白连。
    assert.equal(pushedToolCount, 1, '重连成功后应把工具面推回宿主')
  } finally {
    await mgr.shutdown()
  }
})

test('重连恢复后的状态不得把 transport 写成 streamableHttp（stdio 就是 stdio）', async () => {
  const mgr = new McpManager({
    enabled: true,
    timeoutMs: 30_000,
    servers: { min: { command: process.execPath, args: [FIXTURE] } },
  })
  try {
    await mgr.initialize()
    const pid = mgr.getConnection('min')?.transport.pid
    assert.equal(typeof pid, 'number')
    process.kill(pid as number, 'SIGKILL')

    const stateOf = () => mgr.getStates().find((s) => s.serverId === 'min')
    await waitFor(() => stateOf()?.status === 'degraded', 8_000, '应先进入 degraded')
    // _onTransportClosed 里 transport 字段原本是硬编码 'streamableHttp'——
    // stdio server 走这条路时会被写成 HTTP，设置页的传输列会显示错。
    assert.equal(stateOf()?.transport, 'stdio', 'degraded 状态里的 transport 必须还是 stdio')

    await waitFor(() => stateOf()?.status === 'connected', 25_000, '应重连成功')
  } finally {
    await mgr.shutdown()
  }
})
