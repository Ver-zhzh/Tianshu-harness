import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { sessionsDir } from '../config/paths.js'
import { assertValidSessionId } from '../validation.js'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { redactText, redactValue } from '../server/redact.js'
import { evidenceProject, readEvidenceFacts } from './evidence-facts.js'
import { readCompletionEvidence, criterionHasEvidence } from '../plan/completion-evidence.js'
import { readPlanClosures, existingPlanRevision } from '../plan/continuity-records.js'
import { createFileRepairStore } from './file-repair-store.js'
import { writeHandoffCoverage } from './handoff-coverage.js'

export interface HandoffLiveInput {
  goal?: string; scope?: string; turnCount?: number
  narrative?: string
  planRef?: string
  todos?: Array<{ id: string; content: string; status: string }>
}
export interface FactHandoff {
  version: 1; snapshotId: string; sessionId: string; project: string; createdAt: number
  turnCount: number | null; brief: string; sections: Record<string, string[]>
  receipts: Record<string, unknown>; sourceVersions: Record<string, string>
  legacy?: boolean
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function directory(cwd: string, sessionId: string): string {
  assertValidSessionId(sessionId)
  return join(sessionsDir(cwd), sessionId, 'handoff')
}
function safeJson(path: string): any { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined }
export function assembleFactHandoff(cwd: string, sessionId: string, live: HandoffLiveInput = {}, note?: string): Omit<FactHandoff, 'snapshotId' | 'brief'> {
  const facts = readEvidenceFacts(cwd, sessionId), errors = [...facts.errors]
  const params = { cwd, sessionId, toolUseId: 'handoff', input: {} }
  let completion: ReturnType<typeof readCompletionEvidence> = { sessionId, acceptance: [], findings: [] }
  try { completion = readCompletionEvidence(params) } catch { errors.push('验收记录无法确认；未补造事实') }
  let closures: ReturnType<typeof readPlanClosures> = []
  try { closures = readPlanClosures(params) } catch { errors.push('计划关闭记录无法确认') }
  let repairs: ReturnType<ReturnType<typeof createFileRepairStore>['list']> = []
  try { repairs = createFileRepairStore(cwd, sessionId).list() } catch { errors.push('恢复事件无法确认') }
  let meta: any, persistedTodos: HandoffLiveInput['todos']
  try { meta = safeJson(join(sessionsDir(cwd), `${sessionId}.meta.json`)); persistedTodos = safeJson(join(sessionsDir(cwd), `${sessionId}.todos.json`)) } catch { errors.push('会话元数据或旧待办无法读取') }
  const todos = live.todos ?? (Array.isArray(persistedTodos) ? persistedTodos : [])
  const latest = closures.filter(c => !!live.planRef && c.planRef === live.planRef && c.afterRevision === existingPlanRevision(cwd, live.planRef)).at(-1)
  const decisions = completion.decisions ?? [], open = completion.openItems ?? []
  const sections: Record<string, string[]> = {
    goal: [`目标：${live.goal || '未知（未提供当前任务目标）'}`, `范围：${live.scope || '未明确记录；不得自动扩大范围'}`],
    implementation: [`执行：${latest?.executionStatus ?? '未知（没有实施关闭记录）'}${latest ? `；计划 ${latest.planRef}` : ''}`,
      ...todos.map(t => `todo:${t.id} [${t.status}；任务声明] ${t.content}`),
      ...closures.map(c => `计划关闭历史：${c.planRef} ${c.executionStatus}；不等于当前任务或质量通过`)],
    commits: [`实际提交：${facts.commits.join(', ') || '未知（没有本会话提交回执）'}`],
    verification: facts.runs.length ? facts.runs.map(r => `execution:${r.executionId} ${r.executionState}/${r.outcome}；覆盖 ${r.coverageStatus}；范围 ${r.scope}；版本 ${r.stale ? '过期' : '有效性未知'}${r.omittedBytes ? `；日志遗漏 ${r.omittedBytes} 字节` : ''}`) : ['验证：未执行或未知（没有执行回执）'],
    review: facts.reviews.length ? facts.reviews.map(r => `review:${r.id} 已执行；结论 ${r.verdict ?? '未知'}；版本 ${r.stale ? '过期' : '有效性未知'}`) : ['审查：未执行或未知（没有独立记录）'],
    pending: [...todos.filter(t => t.status !== 'completed').map(t => `todo:${t.id} ${t.content}`),
      ...completion.acceptance.filter(a => a.status !== 'met' || !criterionHasEvidence(params, a, true)).map(a => `${a.id} [${a.kind ?? '未分类'}/${a.status === 'met' ? '当前证据待核实' : a.status}] ${a.criterion}；${a.reason ?? '待核实'}`),
      ...open.filter(o => o.status !== 'closed').map(o => `${o.id} [${o.status}] ${o.text}；关闭条件：${'closedBy' in o && o.closedBy || '未知'}；重开条件：${'reopenIf' in o && o.reopenIf || '未知'}；原因：${o.reason || '未知'}`),
      ...completion.findings.filter(f => f.disposition !== 'excluded').map(f => `发现 ${f.findingId} [${f.disposition}]；${f.reason || '处理结果仍待核实'}；实施证据：${f.resolutionEvidenceRefs?.join(', ') || '未登记'}；验证独立登记，时机由用户决定`),
      ...facts.findings.filter(f => !['fixed', 'rejected'].includes(f.state) && !completion.findings.some(d => d.findingId === f.id)).map(f => `审查发现 ${f.id} [${f.state}] ${f.claim}；尚未登记处理去向`),
      ...repairs.filter(r => r.state !== 'recovered').map(r => `恢复事件 ${r.file} [${r.state}] ${r.reason ?? '仍待核实'}`), ...errors],
    decisions: decisions.map(d => `${d.id} [${'kind' in d ? d.kind : '声明'}/${d.status}/${d.provenance}] ${d.text}；原因：${d.reason || '未知'}${d.sourceRef ? `；来源 ${d.sourceRef}` : ''}`),
    open: open.map(o => `${o.id} [${o.status}] ${o.text}；关闭条件：${'closedBy' in o && o.closedBy || '未知'}；重开条件：${'reopenIf' in o && o.reopenIf || '未知'}；原因：${o.reason || '未知'}`),
    next: [...open.filter(o => o.status !== 'closed' && 'nextAction' in o && o.nextAction).map(o => `${o.id}：${'nextAction' in o ? o.nextAction : ''}`),
      ...todos.filter(t => t.status !== 'completed').map(t => `${t.id}：${t.content}`)],
    findings: facts.findings.map(f => `${f.id} [${f.state}] ${f.claim}；验证 ${f.verification}；${completion.findings.find(d => d.findingId === f.id)?.disposition ?? '待核实处理去向'}`),
    notes: note ? [`用户附注（声明）：${note}`] : [],
    narrative: live.narrative ? [`模型叙述（未独立核验，不替代以上事实）：\n${live.narrative}`] : [],
    records: [JSON.stringify(redactValue({ completion, closures, repairs, todos }), null, 2)],
  }
  if (!sections.pending!.length) sections.pending!.push('未记录未完成事项；不等于全部已验收')
  if (!sections.next!.length) sections.next!.push('按用户下一条指令推进；不自动追加测试或审查')
  const receipts: Record<string, unknown> = Object.fromEntries([
    ...facts.runs.map(r => [`execution:${r.executionId}`, r] as const),
    ...facts.reviews.map(r => [`review:${r.id}`, { ...r, findings: facts.findings.filter(f => f.reviewId === r.id) }] as const),
    ...facts.commits.map(sha => [`commit:${sha}`, { commitSha: sha }] as const),
  ])
  const redacted = redactValue({ sections, receipts }) as { sections: Record<string, string[]>; receipts: Record<string, unknown> }
  return { version: 1, sessionId, project: facts.project, createdAt: Date.now(), turnCount: live.turnCount ?? meta?.turnCount ?? null,
    sections: redacted.sections, receipts: redacted.receipts,
    sourceVersions: { completion: hash(completion), closures: hash(closures), receipts: hash(redacted.receipts) } }
}
export function handoffBrief(snapshot: Pick<FactHandoff, 'sessionId' | 'snapshotId' | 'sections' | 'turnCount'>): string {
  const root = `handoff://${snapshot.sessionId}/${snapshot.snapshotId}`
  const header = `交接 ${snapshot.sessionId} / ${snapshot.snapshotId}\n覆盖轮次：${snapshot.turnCount ?? '未知'}；历史记录，当前代码有效性未知，不据此自动重跑。\n`
  const selected: string[] = [], omitted: string[] = []
  const essential = ['goal', 'implementation', 'commits', 'verification', 'review']
    .map(section => ({ section, text: ['verification', 'review'].includes(section) ? snapshot.sections[section]?.at(-1) : snapshot.sections[section]?.[0], essential: true })).filter(e => !!e.text)
  const entries = [...essential, ...['goal', 'implementation', 'commits', 'verification', 'review', 'pending', 'decisions', 'next', 'notes']
    .flatMap(section => (snapshot.sections[section] ?? []).filter(text => !essential.some(e => e.section === section && e.text === text)).map(text => ({ section, text, essential: false })))]
  const link = `明细 read_file(file_path="${root}/<section>")；章节：goal, implementation, commits, verification, review, pending, decisions, open, next, findings, notes, records。`
  const footerBudget = [...`\n遗漏 ${entries.length} 个完整条目；${link}`].length
  let length = [...header].length
  const fallbackFor = (section: string) => `[${section}] 完整条目见此章节（超出速览预算）`
  let reserve = essential.reduce((n, e) => n + [...fallbackFor(e.section)].length + 1, 0)
  for (const entry of entries) {
    const line = `[${entry.section}] ${entry.text}`
    if (entry.essential) reserve -= [...fallbackFor(entry.section)].length + 1
    if (length + [...line].length + 1 + reserve <= 2000 - footerBudget) { selected.push(line); length += [...line].length + 1 }
    else {
      omitted.push(entry.section)
      if (entry.essential) { const fallback = fallbackFor(entry.section); selected.push(fallback); length += [...fallback].length + 1 }
    }
  }
  const footer = `\n${omitted.length ? `遗漏 ${omitted.length} 个完整条目；` : ''}${link}`
  return header + selected.join('\n') + footer
}
export function publishFactHandoff(cwd: string, sessionId: string, live: HandoffLiveInput = {}, note?: string, preserveLegacy = false): FactHandoff {
  const payload = assembleFactHandoff(cwd, sessionId, live, note)
  const snapshotId = hash(payload), snapshot: FactHandoff = { ...payload, snapshotId, brief: '' }
  snapshot.brief = handoffBrief(snapshot)
  const dir = directory(cwd, sessionId); mkdirSync(dir, { recursive: true })
  const path = join(dir, `${snapshotId}.json`)
  try { writeFileSync(path, JSON.stringify(snapshot) + '\n', { flag: 'wx', mode: 0o600 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; readFactHandoff(cwd, sessionId, snapshotId) }
  // The immutable object exists before a reader can discover it through this pointer.
  writeFileAtomicSync(join(dir, 'current.json'), JSON.stringify({ sessionId, project: payload.project, snapshotId }) + '\n')
  const legacy = join(sessionsDir(cwd), `${sessionId}.handoff.md`)
  if (!preserveLegacy || !existsSync(legacy)) {
    const text = renderFactHandoff(snapshot)
    writeFileAtomicSync(legacy, text)
    if (payload.turnCount !== null) writeHandoffCoverage(legacy, sessionId, text, payload.turnCount)
  }
  return snapshot
}
export function renderFactHandoff(snapshot: FactHandoff): string {
  return snapshot.brief + '\n\n' + Object.entries(snapshot.sections).map(([name, lines]) => `## ${name}\n${lines.map(line => `- ${line}`).join('\n')}`).join('\n\n') + '\n'
}
export function readFactHandoff(cwd: string, sessionId: string, snapshotId?: string): FactHandoff {
  const dir = directory(cwd, sessionId)
  const legacyPath = join(sessionsDir(cwd), `${sessionId}.handoff.md`)
  if (!existsSync(join(dir, 'current.json')) && existsSync(legacyPath)) {
    const text = redactText(readFileSync(legacyPath, 'utf8'))
    const project = evidenceProject(cwd), id = hash({ text, project, sessionId })
    if (snapshotId && snapshotId !== id) throw Error('旧交接正文已变化，原引用不可确认')
    const snapshot: FactHandoff = { version: 1, legacy: true, sessionId, snapshotId: id, project, createdAt: statSync(legacyPath).mtimeMs,
      turnCount: null, brief: '', sections: { goal: ['目标：未知（旧文档未提供结构化记录）'], implementation: ['执行：未知'], commits: ['实际提交：未知'], verification: ['验证：未知'], review: ['审查：未知'], pending: ['旧文档覆盖未知；正文只作历史声明'], decisions: [], next: [], notes: [], narrative: [text] }, receipts: {}, sourceVersions: { legacy: hash(text) } }
    snapshot.brief = handoffBrief(snapshot); return snapshot
  }
  const pointer = snapshotId ? undefined : safeJson(join(dir, 'current.json'))
  const id = snapshotId ?? pointer?.snapshotId
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw Error('交接快照不存在或引用无效')
  const snapshot = safeJson(join(dir, `${id}.json`)) as FactHandoff | undefined
  if (!snapshot) throw Error('交接快照缺失')
  const { snapshotId: recorded, brief, ...payload } = snapshot
  if (snapshot.version !== 1 || recorded !== id || hash(payload) !== id || brief !== handoffBrief(snapshot)
    || snapshot.sessionId !== sessionId || snapshot.project !== evidenceProject(cwd)) throw Error('交接快照损坏、项目或会话归属不符')
  return snapshot
}
export function listFactHandoffs(cwd: string): Array<{ sessionId: string; snapshotId?: string; createdAt?: number; legacy?: boolean; unavailable?: boolean }> {
  if (!existsSync(sessionsDir(cwd))) return []
  const ids = new Set(readdirSync(sessionsDir(cwd)).filter(name => name.endsWith('.meta.json')).map(name => name.slice(0, -10)))
  for (const name of readdirSync(sessionsDir(cwd))) if (name.endsWith('.handoff.md')) ids.add(name.slice(0, -11))
  return [...ids].flatMap<{ sessionId: string; snapshotId?: string; createdAt?: number; legacy?: boolean }>(sessionId => {
    try { const s = readFactHandoff(cwd, sessionId); return [{ sessionId, snapshotId: s.snapshotId, createdAt: s.createdAt, legacy: s.legacy }] }
    catch { return existsSync(join(sessionsDir(cwd), `${sessionId}.handoff.md`)) ? [{ sessionId, legacy: true }] : [] }
  })
}
