import { listFactHandoffs, readFactHandoff } from './fact-handoff.js'
import { selectHandoff } from './handoff-selection.js'
export type HandoffCommand = { action: 'generate'; narrative: boolean; note?: string }
  | { action: 'list' } | { action: 'read'; source: string; snapshot?: string; section?: string }
export function parseHandoffCommand(raw: string): HandoffCommand | undefined {
  const parts = raw.trim().split(/\s+/)
  if (parts.shift() !== '/handoff') return undefined
  if (parts[0] === 'list') { if (parts.length !== 1) throw Error('用法：/handoff list'); return { action: 'list' } }
  if (parts[0] === 'read') {
    parts.shift(); const source = parts.shift()
    if (!source || source.startsWith('--')) throw Error('用法：/handoff read <sessionId> [--snapshot <id>] [--section <section>]')
    const options: Record<string, string> = {}
    while (parts.length) {
      const option = parts.shift()!, value = parts.shift()
      if (!['--snapshot', '--section'].includes(option) || !value || value.startsWith('--') || options[option]) throw Error('无效或重复的交接读取选项')
      options[option] = value
    }
    return { action: 'read', source, snapshot: options['--snapshot'], section: options['--section'] }
  }
  const narrative = parts[0] === '--narrative'
  if (narrative) parts.shift()
  if (parts.some(part => part.startsWith('--'))) throw Error('未知交接选项')
  return { action: 'generate', narrative, note: parts.join(' ') || undefined }
}
export function queryHandoffCommand(cwd: string, target: string, command: Exclude<HandoffCommand, { action: 'generate' }>): string {
  if (command.action === 'list') return JSON.stringify(listFactHandoffs(cwd), null, 2)
  const snapshot = readFactHandoff(cwd, command.source, command.snapshot)
  if (command.section && command.section !== 'brief' && !Object.hasOwn(snapshot.sections, command.section)) throw Error('不存在该交接章节')
  selectHandoff(cwd, target, command.source, snapshot.snapshotId)
  if (!command.section || command.section === 'brief') return snapshot.brief
  const lines = snapshot.sections[command.section]!
  return `源会话 ${snapshot.sessionId}；快照 ${snapshot.snapshotId}；当前有效性未知。\n` + lines.slice(0, 20).join('\n')
    + (lines.length > 20 ? `\n遗漏 ${lines.length - 20} 个条目；用 read_file 读取 handoff://${snapshot.sessionId}/${snapshot.snapshotId}/${command.section}` : '')
}
