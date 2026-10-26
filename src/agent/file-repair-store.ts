import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { sessionsDir } from '../config/paths.js'
import { assertValidSessionId } from '../validation.js'
import { writeFileAtomicSync } from '../fs-atomic.js'
import type { MutationFact } from './mutation-facts.js'

export interface FileRepair { file: string; failures: number; state: 'observing' | 'active' | 'recovered' | 'blocked' | 'deferred'; version: string | null; reason?: string; eventId?: string; adviceSent?: boolean }
export function createFileRepairStore(cwd: string, sessionId: string) {
  assertValidSessionId(sessionId)
  const path = join(sessionsDir(cwd), sessionId, 'file-repairs.json')
  const read = (): { sessionId: string; files: FileRepair[]; seen: string[] } => {
    if (!existsSync(path)) return { sessionId, files: [], seen: [] }
    const data = JSON.parse(readFileSync(path, 'utf8'))
    if (data.sessionId !== sessionId || !Array.isArray(data.files) || !Array.isArray(data.seen)) throw new Error('恢复记录归属或格式不符')
    return data
  }
  const write = (data: ReturnType<typeof read>) => { mkdirSync(dirname(path), { recursive: true }); writeFileAtomicSync(path, JSON.stringify(data) + '\n') }
  return {
    list: () => read().files,
    record(facts: MutationFact[]): string[] {
      const data = read(), notices: string[] = []
      for (const fact of facts) {
        if (fact.sessionId !== sessionId || !fact.attempted) continue
        const key = JSON.stringify([fact.toolCallId, fact.file])
        if (data.seen.includes(key)) continue
        data.seen.push(key)
        let repair = data.files.find(f => f.file === fact.file)
        const structuralFailure = fact.attemptedParse === 'invalid' && (['valid', 'missing'].includes(fact.before.parse) || !!repair && ['observing', 'active'].includes(repair.state))
        if (fact.after.parse === 'valid' && fact.restoration !== 'conflict') {
          if (!repair && fact.attemptedParse === 'invalid' && ['valid', 'missing'].includes(fact.before.parse)) { repair = { file: fact.file, failures: 0, state: 'recovered', version: fact.after.version }; data.files.push(repair) }
          if (repair) { repair.state = 'recovered'; repair.failures = 0; repair.version = fact.after.version }
        } else if (structuralFailure && fact.intent !== 'draft-append') {
          if (!repair || repair.state === 'recovered') {
            repair = { file: fact.file, failures: 0, state: 'observing', version: fact.after.version, eventId: fact.toolCallId }
            data.files = data.files.filter(f => f.file !== fact.file); data.files.push(repair)
          }
          repair.failures++; repair.version = fact.after.version
          if (repair.failures >= 2 && repair.state !== 'active') {
            repair.state = 'active'
            if (!repair.adviceSent) {
              notices.push(`文件 ${fact.file} 已进入受控恢复态（事件 ${repair.eventId ?? fact.toolCallId}）：连续结构修改失败。下一次写入请基于当前版本使用 edit_file.operations、精确编辑或 bash.write_files；保留捕获，不使用 Git 清场。`)
              repair.adviceSent = true
            }
          }
        }
      }
      data.seen = data.seen.slice(-500)
      write(data)
      return notices
    },
    resolve(file: string, state: 'blocked' | 'deferred', reason: string) {
      if (!reason.trim()) throw new Error('恢复受阻或延后须说明原因')
      const data = read(), repair = data.files.find(f => f.file === file)
      if (!repair) throw new Error('没有对应恢复事件')
      repair.state = state; repair.reason = reason; write(data)
    },
  }
}
