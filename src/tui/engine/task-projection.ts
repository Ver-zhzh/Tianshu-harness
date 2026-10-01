import type { TasksData, TasksGroup, TasksWorkerRow, TasksWorkerStatus } from '../format/overlay.js'

export interface UnifiedTaskFacts {
  main?: { active: boolean; title: string; status: 'running' | 'awaiting-input' | 'awaiting-approval' | 'stopping' | 'stopped' | 'completed' | 'failed'; elapsedMs: number }
  jobs?: Array<{ id: string; command: string; status: string; startedAt: number; endedAt?: number; exitCode?: number }>
  now?: number
}

const TERMINAL = new Set<TasksWorkerStatus>(['completed', 'failed', 'stopped', 'blocked', 'escalated', 'exited'])
const NEEDS_ME = new Set<TasksWorkerStatus>(['awaiting-input', 'awaiting-approval', 'blocked', 'escalated'])
const SUPPLIED_STATES = new Set<TasksWorkerStatus>(['queued', 'running', 'awaiting-input', 'awaiting-approval', 'completed', 'failed', 'stopping', 'stopped', 'blocked', 'escalated'])

function isTerminal(row: TasksWorkerRow): boolean { return row.terminal ?? TERMINAL.has(row.status) }

function group(parentToolId: string, workers: TasksWorkerRow[], title?: string): TasksGroup {
  return { parentToolId, title, workers, total: workers.length, done: workers.filter(row => row.status === 'completed').length, failed: workers.filter(row => row.status === 'failed').length, running: workers.filter(row => row.status === 'running').length }
}

/** Union supplied foreground, worker and job facts before applying the UI filter. */
export function projectUnifiedTasks(base: TasksData, facts: UnifiedTaskFacts): TasksData {
  const groups: TasksGroup[] = []
  const main = facts.main
  if (main && (main.active || main.status !== 'running')) {
    groups.push(group('main', [{ workerId: 'main', owner: 'main', shortLabel: main.title, profile: '', status: main.status, objective: main.title, elapsedMs: main.elapsedMs, terminal: TERMINAL.has(main.status) }], '主任务'))
  }
  for (const source of base.groups) {
    const workers = source.workers.map(row => ({ ...row, owner: row.owner ?? 'worker' as const }))
    if (workers.length) groups.push(group(source.parentToolId, workers, source.title))
  }
  const now = facts.now ?? Date.now()
  const jobs = (facts.jobs ?? []).map(job => {
    const status: TasksWorkerStatus = job.status === 'killed' ? 'stopped'
      : job.status === 'exited' ? job.exitCode === undefined ? 'exited' : job.exitCode === 0 ? 'completed' : 'failed'
        : SUPPLIED_STATES.has(job.status as TasksWorkerStatus) ? job.status as TasksWorkerStatus : 'unknown'
    const terminal = TERMINAL.has(status) || job.endedAt !== undefined
    const end = terminal ? job.endedAt : now
    return { workerId: `job:${job.id}`, owner: 'job' as const, shortLabel: job.id, profile: '', status, rawStatus: job.status, activity: job.command, elapsedMs: end === undefined ? 0 : Math.max(0, end - job.startedAt), elapsedKnown: end !== undefined, terminal, exitCode: job.exitCode }
  })
  if (jobs.length) groups.push(group('jobs', jobs, '后台任务'))
  const completedCount = groups.reduce((count, current) => count + current.workers.filter(isTerminal).length, 0)
  const visible = groups.flatMap(current => {
    const workers = current.workers.filter(row => base.filter === 'all' || (base.filter === 'running' ? row.status === 'running' : base.filter === 'needs-me' ? NEEDS_ME.has(row.status) : isTerminal(row)))
    return workers.length ? [group(current.parentToolId, workers, current.title)] : []
  })
  return { groups: visible, filter: base.filter, completedCount }
}
