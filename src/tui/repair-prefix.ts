import type { TuiApp } from './engine/app.js'
import type { BootstrapContext } from '../bootstrap.js'
import { previewContinuityRecovery, applyContinuityRecovery } from '../agent/continuity-recovery.js'
import { handleHistoryRescue } from './history-rescue.js'

export function registerRepairPrefixCommand(app: TuiApp, ctx: BootstrapContext): void {
  app.registerSlashCommand({ name: '/repair-prefix', description: '检查前缀证据并显式修复冻结投影', immediate: true,
    async handler(command) {
      const args = command.trimmed.split(/\s+/).slice(1)
      if (app.busy) { app.commitStatic('请等待任务结束后修复前缀。'); return true }
      try {
        const rescued = await handleHistoryRescue(ctx, args)
        if (rescued) { app.commitStatic(rescued); return true }
        const plan = args[0] === '--confirm' && args[1]
          ? await applyContinuityRecovery(ctx.agent, args[1]) : await previewContinuityRecovery(ctx.agent)
        app.commitStatic(plan.status === 'ready'
          ? `${plan.reason} 缓存将重建一次。确认：/repair-prefix --confirm ${plan.recoveryId}`
          : plan.status === 'applied' ? '前缀恢复授权已提交；下一条输入将继续原会话。' : `前缀恢复受阻：${plan.reason}`)
      } catch (error) { app.commitStatic(`前缀恢复失败：${(error as Error).message}`, { isError: true }) }
      return true
    },
  })
}
