import type { OverlayNavState } from './overlay-controller.js'
import type { TasksData, TasksFilter, TasksWorkerRow } from '../format/overlay.js'

export function selectedTask(data: TasksData, nav: OverlayNavState): TasksWorkerRow | undefined {
  const rows = data.groups.flatMap(group => group.workers)
  const remembered = rows.findIndex(row => row.workerId === nav.tasksSelectedId)
  nav.tasksIndex = remembered >= 0 ? remembered : Math.max(0, Math.min(nav.tasksIndex, rows.length - 1))
  const row = rows[nav.tasksIndex]
  nav.tasksSelectedId = row?.workerId
  return row
}

export function handleTasksKey(key: { name: string; char: string; shift?: boolean }, data: TasksData, nav: OverlayNavState, host: {
  render: () => void; open: (row: TasksWorkerRow) => void; foreground: (id: string) => void; stop: (row: TasksWorkerRow) => void
}): boolean {
  const row = selectedTask(data, nav)
  const c = key.char.toLowerCase()
  if (key.name === 'left' || key.name === 'right' || key.name === 'tab') {
    const filters: TasksFilter[] = ['all', 'running', 'needs-me', 'completed']
    const direction = key.name === 'left' || key.shift ? -1 : 1
    nav.tasksFilter = filters[(filters.indexOf(nav.tasksFilter) + direction + filters.length) % filters.length]!
    nav.tasksIndex = 0
    nav.tasksSelectedId = undefined
    host.render()
    return true
  }
  const rows = data.groups.flatMap(group => group.workers)
  if (key.name === 'down' || key.name === 'up' || c === 'j' || c === 'k') {
    if (rows.length) {
      nav.tasksIndex = (nav.tasksIndex + (key.name === 'down' || c === 'j' ? 1 : -1) + rows.length) % rows.length
      nav.tasksSelectedId = rows[nav.tasksIndex]?.workerId
      host.render()
    }
    return true
  }
  if (key.name === 'return') { if (row) host.open(row); return true }
  if (c === 'f') { if (row?.owner === 'worker') host.foreground(row.workerId); return true }
  if (c === 'x') { if (row && !row.terminal && ['running', 'queued', 'awaiting-input', 'awaiting-approval'].includes(row.status)) host.stop(row); return true }
  return false
}
