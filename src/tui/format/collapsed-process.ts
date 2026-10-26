import type { RivetTheme } from '../theme.js'
import { useAsciiGlyphs } from '../term-caps.js'
import { formatCollapsedToolDetailLine } from './tool-card.js'
import { formatCollapsedGroup, type CollapsedReadSearchGroup } from './collapsed-read-search.js'
import { formatCollapsedBashGroup, type CollapsedBashGroup } from './collapsed-bash.js'
import { EXPAND_HINT } from '../truncation-marker.js'

export type CollapsedProcessSegment =
  | { kind: 'read-search'; group: CollapsedReadSearchGroup }
  | { kind: 'bash'; group: CollapsedBashGroup }

export interface CollapsedProcessGroup {
  readGroups: CollapsedReadSearchGroup[]
  bashGroups: CollapsedBashGroup[]
  orderedGroups?: CollapsedProcessSegment[]
  startMs: number
}

export interface FormatCollapsedProcessInput {
  process: CollapsedProcessGroup
  theme: RivetTheme
  columns?: number
  expandHint?: string
}

export function collapsedProcessToolCount(process: CollapsedProcessGroup): number {
  return [...process.readGroups.flatMap(group => group.entries), ...process.bashGroups.flatMap(group => group.entries)]
    .filter(entry => entry.completed).length
}

export function formatCollapsedProcess(input: FormatCollapsedProcessInput): string[] {
  const { process, theme } = input
  if (process.readGroups.length + process.bashGroups.length === 1) {
    if (process.readGroups.length === 1) {
      return formatCollapsedGroup({ group: process.readGroups[0]!, theme, columns: input.columns, expandHint: input.expandHint })
    }
    return formatCollapsedBashGroup({ group: process.bashGroups[0]!, theme, columns: input.columns, expandHint: input.expandHint })
  }

  let reads = 0, searches = 0, lists = 0, commands = 0
  for (const group of process.readGroups) {
    for (const entry of group.entries) {
      if (!entry.completed) continue
      if (entry.kind === 'read') reads++
      else if (entry.kind === 'search') searches++
      else lists++
    }
  }
  for (const group of process.bashGroups) commands += group.entries.filter(entry => entry.completed).length
  const tools = reads + searches + lists + commands
  if (!tools) return []
  const parts = [`执行过程 · ${tools} 工具`]
  if (searches) parts.push(`搜索 ${searches}`)
  if (reads) parts.push(`阅读 ${reads}`)
  if (lists) parts.push(`列表 ${lists}`)
  if (commands) parts.push(`命令 ${commands}`)
  const elapsed = Math.max(0, Date.now() - process.startMs)
  parts.push(elapsed >= 1000 ? `${(elapsed / 1000).toFixed(1)}s` : `${elapsed}ms`)
  const glyph = useAsciiGlyphs() ? '+' : '✓'
  const summary = `${glyph} ${parts.join(' · ')}`
  return [formatCollapsedToolDetailLine(summary, input.expandHint ?? EXPAND_HINT, theme, input.columns)]
}

export function formatCollapsedProcessDetails(input: FormatCollapsedProcessInput): string[] {
  const lines: string[] = []
  const groups = input.process.orderedGroups ?? [
    ...input.process.readGroups.map(group => ({ kind: 'read-search' as const, group })),
    ...input.process.bashGroups.map(group => ({ kind: 'bash' as const, group })),
  ].sort((a, b) => a.group.startMs - b.group.startMs)
  for (const segment of groups) {
    lines.push(...(segment.kind === 'read-search'
      ? formatCollapsedGroup({ group: segment.group, expanded: true, theme: input.theme, columns: input.columns })
      : formatCollapsedBashGroup({ group: segment.group, expanded: true, theme: input.theme, columns: input.columns })))
  }
  return lines
}
