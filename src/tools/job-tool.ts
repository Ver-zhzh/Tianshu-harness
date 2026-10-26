import type { Tool, ToolCallParams, ToolResult } from './types.js'
import type { JobSnapshot } from './job-store.js'
import { listVerificationRuns, renderVerificationRun } from '../agent/verification-runs.js'

function receipt(params: ToolCallParams, job: JobSnapshot): string {
  if (!params.sessionId || !job.executionId) return ''
  const run = listVerificationRuns(params.cwd, params.sessionId).find(r => r.executionId === job.executionId)
  return run ? `\n${renderVerificationRun(run)}` : ''
}

/** Cap for an await's blocking window so a runaway pattern never hangs the loop. */
const MAX_AWAIT_MS = 600_000
const DEFAULT_AWAIT_MS = 120_000

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  return r ? `${m}m${r}s` : `${m}m`
}

function fmtStatus(job: JobSnapshot): string {
  if (job.status === 'running') return 'running'
  if (job.status === 'killed') return `killed${job.exitCode != null ? ` (exit ${job.exitCode})` : ''}`
  return `exited (${job.exitCode ?? '?'})`
}

function fmtLine(job: JobSnapshot): string {
  const elapsed = fmtDuration((job.endedAt ?? Date.now()) - job.startedAt)
  const head = `[${job.id}] ${fmtStatus(job)} · ${elapsed} · ${job.command}`
  return job.lastLine ? `${head}\n    └ ${job.lastLine}` : head
}

export const JOB_TOOL: Tool = {
  definition: {
    name: 'job',
    description: `查看和控制由 bash(run_in_background) 启动的后台任务。

Actions:
- list: 列出本会话所有后台任务（状态、已运行时长、最后一行输出）。
- await: 阻塞直到任务退出、输出命中 \`pattern\`（正则）或 \`timeout\` 到时。服务就绪可以匹配实际日志；测试和安装须核对退出状态与结果，日志命中不代表完成或通过。
- logs: 返回任务捕获的输出。
- kill: 终止运行中的任务。`,
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'await', 'logs', 'kill'], description: '要执行的操作' },
        id: { type: 'string', description: '任务 id（await/logs/kill 必填）' },
        pattern: { type: 'string', description: '仅 await：服务就绪探测可按实际日志设置正则；命中会提前返回，不证明任务退出或测试通过。等待测试结束时省略。' },
        timeout: { type: 'integer', description: '仅 await：最长阻塞毫秒数（默认 120000，上限 600000）' },
        offset: { type: 'integer', description: 'logs：起始行，默认 0' },
        limit: { type: 'integer', description: 'logs：最多返回 500 行，默认 100' },
        tail: { type: 'boolean', description: 'logs：查看末尾' },
        search: { type: 'string', description: 'logs：按字面量搜索已有日志，不运行命令' },
      },
      required: ['action'],
    },
  },

  async execute(params: ToolCallParams): Promise<ToolResult> {
    const jobs = params.jobs
    if (!jobs) {
      return { content: '后台任务系统在当前上下文不可用（无会话）。请直接前台运行命令。', isError: false }
    }
    const action = String(params.input.action ?? '')
    const id = params.input.id != null ? String(params.input.id) : ''

    switch (action) {
      case 'list': {
        const list = jobs.list()
        if (list.length === 0) return { content: '当前没有后台任务。', uiContent: '后台任务: 0', isError: false }
        const body = list.map(fmtLine).join('\n')
        const running = list.filter((j) => j.status === 'running').length
        return { content: `后台任务 (${list.length}，运行中 ${running}):\n${body}`, uiContent: `后台任务: ${list.length} (运行 ${running})`, isError: false }
      }

      case 'await': {
        if (!id) return { content: 'await 需要 id 参数。', isError: true }
        const pattern = params.input.pattern != null ? String(params.input.pattern) : undefined
        const timeoutMs = Math.min(Number(params.input.timeout) || DEFAULT_AWAIT_MS, MAX_AWAIT_MS)
        const result = await jobs.await(id, { pattern, timeoutMs })
        if (!result) return { content: `未找到任务 ${id}。用 job(action="list") 查看。`, isError: true }
        const { job, matched, timedOut, tail } = result
        const verdict = job.status !== 'running'
          ? `● 任务已${job.status === 'killed' ? '被终止' : '退出'} (exit ${job.exitCode ?? '?'})`
          : (matched ? '● 输出命中 pattern' : timedOut ? `⏱ 等待超时（${fmtDuration(timeoutMs)}）` : '● 等待已返回') +
            '，任务仍在运行；不代表执行完成或测试通过'
        const header = `[${job.id}] ${verdict} · ${fmtStatus(job)}${receipt(params, job)}`
        return {
          content: tail ? `${header}\n── 输出尾部 ──\n${tail}` : header,
          uiContent: `await ${job.id}: ${job.status !== 'running' ? fmtStatus(job) : matched ? '命中（仍在运行）' : timedOut ? '等待超时（仍在运行）' : fmtStatus(job)}`,
          isError: false,
        }
      }

      case 'logs': {
        if (!id) return { content: 'logs 需要 id 参数。', isError: true }
        const logs = jobs.logs(id, { offset: Number(params.input.offset) || 0, limit: Number(params.input.limit) || 100, tail: params.input.tail === true, pattern: typeof params.input.search === 'string' ? params.input.search : undefined })
        if (logs == null) return { content: `未找到任务 ${id}。`, isError: true }
        const job = jobs.list().find(j => j.id === id)
        return { content: (logs || '(无输出)') + (job ? receipt(params, job) : ''), uiContent: `logs ${id}`, isError: false }
      }

      case 'kill': {
        if (!id) return { content: 'kill 需要 id 参数。', isError: true }
        const ok = jobs.kill(id)
        return { content: ok ? `已发送终止信号给任务 ${id}。` : `任务 ${id} 不存在或已结束。`, uiContent: `kill ${id}`, isError: !ok }
      }

      default:
        return { content: `未知 action: ${action}。可用: list / await / logs / kill。`, isError: true }
    }
  },

  requiresApproval(): boolean {
    return false
  },

  // await blocks intentionally; give the pipeline headroom beyond the await window.
  timeoutMs(params?: ToolCallParams): number {
    if (params?.input?.action === 'await') {
      const t = Math.min(Number(params.input.timeout) || DEFAULT_AWAIT_MS, MAX_AWAIT_MS)
      return t + 30_000
    }
    return 120_000
  },

  isConcurrencySafe: () => true,
  isEnabled: () => true,
}
