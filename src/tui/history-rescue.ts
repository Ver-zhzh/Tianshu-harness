import { randomUUID } from 'node:crypto'
import type { BootstrapContext } from '../bootstrap.js'
import { archiveHistoryRescue, buildHistoryRescue, seedHistoryRescue } from '../agent/history-rescue.js'

const previews = new WeakMap<BootstrapContext['agent'], { hash: string; target?: string }>()

export async function handleHistoryRescue(ctx: BootstrapContext, args: string[]): Promise<string | undefined> {
  if (!['--rescue', '--rescue-confirm'].includes(args[0] ?? '')) return undefined
  if (ctx.agent.isRunning() || ctx.agent.config.coordinatorRef?.()?.hasRunningWork()) throw new Error('请等待会话和 worker 结束后救援历史')
  const persist = ctx.agent.persist
  if (!persist) throw new Error('当前会话没有可导出的持久化历史')
  const rescue = buildHistoryRescue(persist)
  if (args[0] === '--rescue') {
    const path = archiveHistoryRescue(persist, rescue)
    previews.set(ctx.agent, { hash: rescue.sourceHash })
    return `救援副本：${path}\n${rescue.handoff}\n\n原会话保留；新会话只携带上述可读交接，可能有缺失，不自动执行工具。确认：/repair-prefix --rescue-confirm ${rescue.sourceHash}`
  }
  const preview = previews.get(ctx.agent)
  if (!preview || args[1] !== preview.hash || rescue.sourceHash !== preview.hash) throw new Error('救援预览不存在或历史已变化，请重新 /repair-prefix --rescue')
  if (!preview.target) {
    const target = randomUUID()
    seedHistoryRescue(ctx.cwd, target, rescue)
    preview.target = target
  }
  return `救援会话已建立，原会话未修改。请用 /resume ${preview.target} 打开后核实交接，再发送新指令；不会自动重放工具。`
}
