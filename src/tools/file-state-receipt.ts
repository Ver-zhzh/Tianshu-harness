import type { MutationFact } from '../agent/mutation-facts.js'
import type { ToolResult } from './types.js'
import { resolve } from 'node:path'
import { observationForVersion } from './read-file-state.js'

export interface FileStateReceipt {
  intent?: MutationFact['intent']
  path: string
  version: string | null
  observation: 'full' | 'partial' | 'unknown'
  outcome: 'observed' | 'changed' | 'unchanged' | 'restored' | 'conflict' | 'unknown'
  restoration: MutationFact['restoration']
  parse?: MutationFact['after']['parse']
  html?: MutationFact['after']['html']
  addedSymbols?: string[]
  omittedSymbols?: number
}

/** Only existing execution facts; survives artifact/budget transforms without reading disk again. */
export function renderFileStateTail(states: FileStateReceipt[]): string {
  const lines: string[] = []
  for (const state of states) {
    const line = `${state.path}: version=${state.version ?? 'unknown'}; outcome=${state.outcome}; observation=${state.observation}; parse=${state.parse ?? 'unknown'}`
    if ([...lines.join('\n') + line].length > 1000) break
    lines.push(line)
  }
  if (states.length > lines.length) lines.push(`另 ${states.length - lines.length} 个文件需按目标读取对应回执。`)
  return lines.length ? `[file-state]\n${lines.join('\n')}` : ''
}

export function attachMutationReceipts(result: ToolResult, facts: MutationFact[], cwd?: string): void {
  const states = new Map<string, FileStateReceipt>()
  for (const fact of facts) states.set(fact.file, {
    path: fact.file, version: fact.after.version,
    observation: cwd && fact.after.version !== null ? observationForVersion(resolve(cwd, fact.file), fact.sessionId, fact.after.version) : 'unknown',
    parse: fact.after.parse, html: fact.after.html, intent: fact.intent,
    addedSymbols: ['valid', 'missing'].includes(fact.before.parse) ? fact.after.symbols?.filter(s => !fact.before.symbols?.includes(s)).slice(0, 12) : undefined,
    omittedSymbols: ['valid', 'missing'].includes(fact.before.parse) ? Math.max(0, (fact.after.symbols?.filter(s => !fact.before.symbols?.includes(s)).length ?? 0) - 12) : 0,
    restoration: fact.restoration,
    outcome: fact.restoration === 'conflict' ? 'conflict'
      : fact.before.version === null && fact.before.parse !== 'missing' || fact.after.version === null && fact.after.parse !== 'missing' ? 'unknown'
      : fact.restoration === 'restored' ? 'restored'
      : fact.before.version === fact.after.version ? 'unchanged' : 'changed',
  })
  result.fileStates = [...states.values()]
  const lines: string[] = []
  for (const s of result.fileStates) {
    const range = result.changedRanges?.map(r => `L${r.start}-L${r.end}`).join(', ') || '区间未记录'
    const symbols = s.addedSymbols?.length ? `; 新增符号=${s.addedSymbols.join(', ')}${s.omittedSymbols ? `（另 ${s.omittedSymbols} 个）` : ''}` : ''
    const coverage = s.html ? `; 内联脚本=${s.html.checkedScripts}/${s.html.scripts}，排除=${s.html.excluded.length}` : ''
    const line = `${s.path}: version=${s.version ?? 'unknown'}; ${s.outcome}; parse=${s.parse}${coverage}${symbols}; ${range}; 按需 read_file(${JSON.stringify(s.path)})`
    if ([...lines.join('\n') + line].length > 1100) break
    lines.push(line)
  }
  if (states.size > lines.length) lines.push(`另 ${states.size - lines.length} 个文件见结构化 fileStates 回执`)
  if (lines.length) result.content += `\n文件回执：\n${lines.join('\n')}`
}
