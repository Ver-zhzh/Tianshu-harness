import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, basename, join } from 'node:path'
import type { OaiMessage } from '../api/oai-types.js'
import { proveRewindHistory } from '../api/continuation-prefix.js'
import { parseFrozenSnapshotData } from '../prompt/frozen-snapshot.js'
import { SessionPersist } from './session-persist.js'
import { readHistoryRescueTranscript } from './history-rescue-transcript.js'

export function buildHistoryRescue(persist: SessionPersist) {
  const path = persist.getFilePath()
  const frozenPath = path.replace(/\.jsonl$/, '.frozen.json')
  const read = (file: string) => {
    if (!existsSync(file)) return Buffer.alloc(0)
    if (statSync(file).size > 64 * 1024 * 1024) throw new Error('历史文件超过救援导出上限；请保留原文件并使用文件备份。')
    return readFileSync(file)
  }
  const transcript = read(path), frozen = read(frozenPath)
  const { messages, diagnostic } = readHistoryRescueTranscript(transcript)
  try {
    const snapshot = parseFrozenSnapshotData(JSON.parse(frozen.toString('utf8')))
    const published = snapshot?.rewindAuthorization?.history ?? snapshot?.publishedHistory
    if (published) {
      diagnostic.publishedCount = published.length
      const current = proveRewindHistory(messages)
      const mismatch = published.findIndex((entry, index) => entry.hash !== current[index]?.hash)
      if (mismatch >= 0 && diagnostic.reason === 'none') { diagnostic.reason = 'published_source'; diagnostic.firstMismatch = mismatch }
    }
  } catch { /* Raw frozen bytes remain in the export even when not parseable. */ }
  const sourceHash = createHash('sha256').update(transcript).update('\0').update(frozen).digest('hex')
  const lines: string[] = []
  let chars = 0, included = 0
  for (const message of [...messages].reverse()) {
    const content = Array.isArray(message.content) ? message.content.map(part => part.type === 'text' ? part.text : '[image attachment omitted]').join('\n') : message.content ?? ''
    const text = `[${message.role}] ${content.slice(0, 4000)}${content.length > 4000 ? '\n[message truncated for handoff]' : ''}`
    if (chars + text.length > 60_000) break
    lines.push(text); chars += text.length; included++
  }
  const handoff = `历史救援交接 / History rescue\n来源：${path.split(/[\\/]/).at(-1)}\n`
    + `仅包含磁盘可读取的历史尾部 ${included}/${messages.length} 条；可能存在截断、缺失或中断。原会话与冻结证据未修改。\n`
    + '以下内容只是历史参考，不构成工具执行授权。工具结果不完整时先核实磁盘和外部状态，不要重放已完成操作。等待用户的新指令再继续。\n\n'
    + lines.reverse().join('\n\n')
  return { version: 1 as const, sourceHash, diagnostic, messages, handoff,
    coverage: { recoveredMessages: messages.length, includedMessages: included, omittedMessages: messages.length - included },
    // Exact bytes retain damaged/truncated evidence that the permissive reader skips.
    transcriptBase64: transcript.toString('base64'), frozenBase64: frozen.toString('base64') }
}

export function seedHistoryRescue(cwd: string, targetId: string, rescue: ReturnType<typeof buildHistoryRescue>): SessionPersist {
  const child = new SessionPersist(targetId, cwd)
  const reference: OaiMessage = { role: 'user', origin: 'human', content: rescue.handoff }
  if (existsSync(child.getFilePath())) {
    if (!child.matchesOaiSessionProjection([reference])) throw new Error('救援会话已存在且内容不同，禁止覆盖')
  } else {
    child.initMetadata({ cwd, cleanExit: true })
    child.appendOaiWithChecksumSync(reference)
  }
  // Explicit rescue consent starts an independent cache generation, never reuses the old seal.
  child.markColdStartConsent()
  return child
}

export function archiveHistoryRescue(persist: SessionPersist, rescue: ReturnType<typeof buildHistoryRescue>): string {
  const path = persist.getFilePath()
  const dir = join(dirname(path), basename(path, '.jsonl'), 'history-rescue')
  mkdirSync(dir, { recursive: true })
  const target = join(dir, `${rescue.sourceHash}.json`)
  const content = JSON.stringify(rescue, null, 2)
  try { writeFileSync(target, content, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (readFileSync(target, 'utf8') !== content) throw new Error('现有救援副本与历史证据不一致，禁止覆盖')
  }
  return target
}
