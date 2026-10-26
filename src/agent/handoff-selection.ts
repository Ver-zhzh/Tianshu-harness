import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { sessionsDir } from '../config/paths.js'
import { assertValidSessionId } from '../validation.js'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { evidenceProject } from './evidence-facts.js'
import { readFactHandoff } from './fact-handoff.js'
import type { ToolCallParams, ToolResult } from '../tools/types.js'

interface Selection { project: string; sourceSessionId: string; snapshotId: string }
function selectionPath(cwd: string, target: string): string {
  assertValidSessionId(target)
  return join(sessionsDir(cwd), target, 'handoff-selection.json')
}
/** Only explicit user entrypoints call this; read_file never grants itself access. */
export function selectHandoff(cwd: string, target: string, source: string, snapshotId?: string) {
  const snapshot = readFactHandoff(cwd, source, snapshotId), path = selectionPath(cwd, target)
  mkdirSync(join(path, '..'), { recursive: true })
  const selection: Selection = { project: evidenceProject(cwd), sourceSessionId: source, snapshotId: snapshot.snapshotId }
  writeFileAtomicSync(path, JSON.stringify(selection) + '\n')
  return snapshot
}
const reads = new Map<string, number>()
export function readSelectedHandoff(params: ToolCallParams): ToolResult | undefined {
  const uri = params.input.file_path
  if (typeof uri !== 'string' || !uri.startsWith('handoff://')) return undefined
  try {
    if (!params.sessionId) throw Error('交接读取需要明确的目标会话')
    const match = /^handoff:\/\/([A-Za-z0-9_-]+)\/([a-f0-9]{64})\/([a-z]+)(?:\/([A-Za-z0-9_:-]+))?$/.exec(uri)
    if (!match) throw Error('无效交接引用')
    const [, source, id, section, record] = match
    const path = selectionPath(params.cwd, params.sessionId)
    const selection = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Selection : undefined
    if (!selection || selection.project !== evidenceProject(params.cwd) || selection.sourceSessionId !== source || selection.snapshotId !== id) throw Error('未显式选择该源会话及快照；请用 /handoff read <sessionId> 选源')
    const snapshot = readFactHandoff(params.cwd, source!, id)
    let text: string
    if (record) {
      const kind = section === 'verification' ? 'execution' : section === 'review' ? 'review' : section === 'commits' ? 'commit' : undefined
      const receipt = kind && snapshot.receipts[`${kind}:${record}`]
      if (!receipt) throw Error('该快照没有引用此记录')
      text = JSON.stringify(receipt, null, 2)
    } else if (section === 'brief') text = snapshot.brief
    else {
      if (!Object.hasOwn(snapshot.sections, section!)) throw Error('不存在该交接章节')
      text = snapshot.sections[section!]!.join('\n')
    }
    const offset = Number(params.input.offset ?? 1), limit = Number(params.input.limit ?? 100)
    if (!Number.isInteger(offset) || offset < 1 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw Error('交接读取 offset >= 1，limit 为 1–500')
    const lines = text.split('\n'), page = lines.slice(offset - 1, offset - 1 + limit).join('\n')
    const key = `${params.cwd}:${params.sessionId}:${uri}:${offset}:${limit}`
    const repeats = reads.get(key) ?? 0; reads.set(key, repeats + 1)
    if (reads.size > 500) reads.delete(reads.keys().next().value!)
    if (repeats === 1 && params.input.force !== true) return { content: `[read-ref] 已读取相同不可变快照及范围：${uri}（offset=${offset}, limit=${limit}）。若上下文已丢失，可再次读取取回原文。` }
    const prefix = `源会话 ${source}；快照 ${id}；历史事实，当前版本有效性未知。\n`
    return { content: prefix + page + (offset - 1 + limit < lines.length ? `\n另有 ${lines.length - offset + 1 - limit} 行；继续 offset=${offset + limit}` : '') }
  } catch (error) { return { content: `交接读取失败：${String(error)}`, isError: true, errorKind: 'format_error' } }
}
