import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sessionsDir } from '../config/paths.js'
import { assertValidSessionId } from '../validation.js'
import { contentVersion } from '../agent/file-version.js'
import type { ToolCallParams } from './types.js'

interface MatchRef { ref: string; sessionId: string; root: string; file: string; version: string; start: number; end: number; textHash: string }
function path(params: ToolCallParams): string {
  if (!params.sessionId) throw new Error('结构引用需要会话归属')
  assertValidSessionId(params.sessionId)
  return join(sessionsDir(params.cwd), params.sessionId, 'ast-matches.jsonl')
}
export function issueMatchRef(params: ToolCallParams, file: string, version: string, start: number, end: number, text: string): string {
  const record: MatchRef = { ref: `ast:${randomUUID()}`, sessionId: params.sessionId!, root: resolve(params.cwd), file: resolve(file), version, start, end, textHash: contentVersion(text) }
  const target = path(params)
  mkdirSync(dirname(target), { recursive: true })
  appendFileSync(target, JSON.stringify(record) + '\n')
  return record.ref
}
export function createMatchResolver(params: ToolCallParams) {
  const target = path(params)
  if (!existsSync(target)) throw new Error('结构引用不存在，请重新读取该文件的结构匹配')
  const records = new Map<string, MatchRef>(readFileSync(target, 'utf8').trim().split('\n').filter(Boolean).map(line => { const record: MatchRef = JSON.parse(line); return [record.ref, record] }))
  return (ref: string, file: string, version: string, source: string): { start: number; end: number } => {
    const match = records.get(ref)
    if (!match || match.sessionId !== params.sessionId || match.root !== resolve(params.cwd) || match.file !== resolve(file)) throw new Error('结构引用归属或目标不符')
    if (match.version !== version || contentVersion(source.slice(match.start, match.end)) !== match.textHash) throw new Error('结构引用已过期，请重新读取当前版本')
    return { start: match.start, end: match.end }
  }
}
export function resolveMatchRef(params: ToolCallParams, ref: string, file: string, version: string, source: string): { start: number; end: number } {
  return createMatchResolver(params)(ref, file, version, source)
}
