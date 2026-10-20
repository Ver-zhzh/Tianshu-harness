/** Skill runtime HTTP adapters. Authorization and immutable plans are shared with CLI/tools. */
import { randomUUID } from 'node:crypto'
import { realpathSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, openSync, readSync, closeSync, statSync, createReadStream } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ServerResponse } from 'node:http'
import { loadConfig } from '../config/manager.js'
import { rivetHome } from '../config/paths.js'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { SkillManagement } from '../skills/skill-management.js'
import { readPackage, skillPackagePath } from '../skills/skill-package.js'
import type { SkillDefinition, SkillRegistry } from '../skills/skill-loader.js'
import { diagnoseSkillRuntime } from '../skills/runtime/diagnostics.js'
import { prepareSkillRuntime, resolveRuntimeSkill, runSkillEntry, defaultEnvManager } from '../skills/runtime/executor.js'
import { buildRuntimeExecutionPlan, type RuntimeRequest } from '../skills/runtime/operation.js'
import { assertRuntimeAccess, RuntimeAccessError, runtimeSkillScope, type RuntimePolicyContext, type RuntimeAction } from '../skills/runtime/policy.js'
import { isPidAlive } from './cron-lock.js'
import { withAuth } from './route-auth.js'
import type { RouteHandler, RouteResponse } from './index.js'
import type { RuntimeSessionManager } from './session-manager.js'

interface OpRecord {
  id: string
  action: 'prepare' | 'run'
  skillName: string
  skillId: string
  packageRef: string
  status: 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled'
  createdAt: string
  finishedAt?: string
  ownerPid?: number
  result?: Record<string, unknown>
}
const opsDir = () => join(rivetHome(), 'skill-runtime-ops')
const opPath = (id: string) => join(opsDir(), `${id}.json`)
const logPath = (id: string) => join(opsDir(), `${id}.log`)
const active = (op: OpRecord) => op.status === 'running' || op.status === 'cancelling'
function loadOp(id: string): OpRecord | undefined {
  if (!/^[a-f0-9-]{36}$/.test(id)) return undefined
  try { return JSON.parse(readFileSync(opPath(id), 'utf8')) } catch { return undefined }
}
function persistOp(op: OpRecord) { mkdirSync(opsDir(), { recursive: true }); writeFileAtomicSync(opPath(op.id), JSON.stringify(op, null, 2)) }
export function sweepRuntimeOperations(now = Date.now()): void {
  try {
    for (const name of readdirSync(opsDir())) {
      const match = name.match(/^([a-f0-9-]{36})\.json$/)
      if (!match) continue
      const op = loadOp(match[1]!)
      const finished = Date.parse(op?.finishedAt ?? '')
      if (op && !active(op) && op.result?.errorCode !== 'process_cleanup_failed' && Number.isFinite(finished) && now - finished > 86_400_000) {
        rmSync(logPath(op.id), { force: true }); rmSync(opPath(op.id), { force: true })
      }
    }
  } catch { /* Unknown ownership/age keeps data. */ }
}
function canonicalCwd(cwd: string): string { try { return realpathSync(cwd) } catch { return resolve(cwd) } }
function registry(skill: SkillDefinition): SkillRegistry { return { get: (name: string) => name === skill.name ? skill : undefined, list: () => [skill] } as SkillRegistry }
function requestOf(data: Record<string, unknown>, action: RuntimeRequest['action']): RuntimeRequest {
  if (data.args !== undefined && (!Array.isArray(data.args) || !data.args.every(a => typeof a === 'string'))) throw new RuntimeAccessError('invalid_args', 'args 必须为字符串数组', 400)
  if (data.timeoutSeconds !== undefined && (typeof data.timeoutSeconds !== 'number' || !Number.isFinite(data.timeoutSeconds) || data.timeoutSeconds <= 0)) throw new RuntimeAccessError('invalid_timeout', 'timeoutSeconds 必须为正数', 400)
  return { action, ...(data.buildPolicy === 'source' || data.buildPolicy === 'wheel' ? { buildPolicy: data.buildPolicy } : {}), rebuild: data.rebuild === true, entry: typeof data.entry === 'string' ? data.entry : undefined, args: data.args as string[] | undefined, stdin: typeof data.stdin === 'string' ? data.stdin : undefined, timeoutSeconds: data.timeoutSeconds as number | undefined }
}

export function buildSkillRuntimeRoutes(manager: RuntimeSessionManager, apiToken?: string, deps: { management?: SkillManagement } = {}): Record<string, RouteHandler> {
  const management = deps.management ?? new SkillManagement()
  const inflight = new Map<string, AbortController>()
  const wrap = (handler: (data: Record<string, unknown>, params: Record<string, string>, res?: ServerResponse) => RouteResponse | Promise<RouteResponse>): RouteHandler => withAuth(async (body, params, _headers, res) => {
    try { return await handler(body && typeof body === 'object' ? body as Record<string, unknown> : {}, params ?? {}, res) }
    catch (error) { return { status: error instanceof RuntimeAccessError ? error.status : 400, body: { code: error instanceof RuntimeAccessError ? error.code : 'invalid_request', error: error instanceof Error ? error.message : String(error) } } }
  }, apiToken)

  const targetOf = (data: Record<string, unknown>, action: RuntimeAction) => {
    let cwd = typeof data.cwd === 'string' ? data.cwd : process.cwd()
    let skill: SkillDefinition
    let context: RuntimePolicyContext = { cwd, origin: 'user' }
    if (typeof data.sessionId === 'string') {
      const record = manager.getSession(data.sessionId), agent = manager.getAgentForSession(data.sessionId)
      if (!record || !agent?.getSkillSnapshot || !agent.getRuntimePolicyContext) throw new RuntimeAccessError('session_missing', '会话不存在或缺少有效权限上下文，fail-closed 拒绝', 409)
      if (typeof data.cwd === 'string' && canonicalCwd(data.cwd) !== canonicalCwd(record.cwd)) throw new RuntimeAccessError('cwd_mismatch', 'cwd 与会话工作区不一致', 400)
      cwd = record.cwd
      const livePolicy = agent.getRuntimePolicyContext()
      context = { ...livePolicy, cwd, origin: 'user', sessionId: data.sessionId, planMode: record.planMode === 'planning' || livePolicy.planMode === 'planning' ? 'planning' : 'off' }
      assertRuntimeAccess(context, action, undefined, data)
      const found = agent.getSkillSnapshot().find(s => s.name.toLowerCase() === String(data.skillName).toLowerCase())
      if (!found) throw new RuntimeAccessError('skill_missing', '会话内未找到技能', 404)
      skill = found
    } else if (typeof data.skillId === 'string') {
      assertRuntimeAccess(context, action, undefined, data)
      const detail = management.inspect(data.skillId, cwd)
      if (!detail.path) throw new RuntimeAccessError('skill_missing', '技能没有可运行的目录包', 400)
      const packageDir = skillPackagePath(detail.path)
      if (packageDir === detail.path) throw new RuntimeAccessError('undeclared', '扁平 Markdown 技能无 Python 运行时', 422)
      // Trust/mode checks precede reading the executable package.
      const stub = { name: detail.name, source: detail.source, mode: detail.mode, metadata: detail.metadata } as SkillDefinition
      assertRuntimeAccess(context, action, stub, data)
      skill = { ...readPackage(packageDir).definition, skillId: detail.skillId, source: detail.source, bodyPath: detail.path, skillDir: packageDir, mode: detail.mode }
    } else throw new RuntimeAccessError('target_missing', '需要 sessionId+skillName 或 skillId', 400)
    assertRuntimeAccess(context, action, skill, data)
    const resolved = resolveRuntimeSkill(registry(skill), skill.name, { userExplicit: true, intent: action === 'doctor' ? 'diagnose' : 'execute', sessionId: context.sessionId })
    if (!resolved.ok) throw new RuntimeAccessError(resolved.result.errorCode ?? 'invalid', resolved.result.message, 422)
    return { cwd, skill, context, resolved: resolved.resolved }
  }

  const checkedPlan = async (data: Record<string, unknown>, action: RuntimeRequest['action']) => {
    const target = targetOf(data, action)
    if (data.confirm !== true) throw new RuntimeAccessError('confirmation_required', '操作需要先预览并确认 confirm:true', 400)
    if (typeof data.packageRef !== 'string' || !/^[a-f0-9]{64}$/.test(data.packageRef) || typeof data.previewDigest !== 'string' || !/^[a-f0-9]{64}$/.test(data.previewDigest)) throw new RuntimeAccessError('preview_required', 'packageRef 和 previewDigest 必填，请重新预览', 400)
    if (data.packageRef !== target.resolved.packageRef) throw new RuntimeAccessError('version_mismatch', 'packageRef 已变化，请重新 preview', 409)
    const request = requestOf(data, action)
    if (action === 'prepare' && request.buildPolicy === 'source' && data.allowSourceBuild !== true) throw new RuntimeAccessError('source_build_confirmation_required', '源码构建需显式 allowSourceBuild:true', 400)
    const plan = await buildRuntimeExecutionPlan(target.resolved, request, target.context)
    if (data.previewDigest !== plan.digest) throw new RuntimeAccessError('preview_mismatch', '操作输入或解释器/包源已变化，请重新预览', 409)
    return { ...target, plan }
  }

  return {
    'POST /skill-runtime/preview': wrap(async data => {
      const target = targetOf(data, 'doctor')
      const diagnosis = await diagnoseSkillRuntime({ name: target.skill.name, skillId: target.skill.skillId ?? target.skill.name, scope: runtimeSkillScope(target.skill), metadata: target.skill.metadata, packageRef: target.resolved.packageRef }, { cwd: target.cwd, explicitPythonPath: loadConfig({ cwd: target.cwd }).env.pythonPath })
      const action = data.action === 'run' || data.action === 'remove-env' ? data.action : 'prepare'
      let plan
      if (diagnosis.interpreter?.found && diagnosis.requiresMatch?.ok !== false) plan = await buildRuntimeExecutionPlan(target.resolved, requestOf(data, action), target.context, { readOnly: true })
      const entry = typeof data.entry === 'string' ? target.resolved.declaration.python.entries[data.entry] : undefined
      return { status: 200, body: { skill: { name: target.skill.name, skillId: target.skill.skillId }, packageRef: target.resolved.packageRef, diagnosis, ...(plan ? { previewDigest: plan.digest, installPreview: plan.preview, envKey: plan.envKey, request: plan.request } : {}), ...(entry ? { command: { shape: `<venv-python> ${entry.script} <args...>`, entry: data.entry, timeoutSeconds: entry.timeoutSeconds ?? null } } : {}) } }
    }),
    'POST /skill-runtime/operations': wrap(async data => {
      sweepRuntimeOperations()
      if (data.action !== 'prepare' && data.action !== 'run') throw new RuntimeAccessError('invalid_action', 'action 必须是 prepare|run', 400)
      const { plan, context, skill } = await checkedPlan(data, data.action)
      const id = randomUUID(), controller = new AbortController()
      inflight.set(id, controller)
      const record: OpRecord = { id, action: data.action, skillName: skill.name, skillId: skill.skillId ?? skill.name, packageRef: plan.resolved.packageRef, status: 'running', createdAt: new Date().toISOString(), ownerPid: process.pid }
      persistOp(record)
      writeFileSync(logPath(id), '')
      const onOutput = (text: string) => writeFileSync(logPath(id), text, { flag: 'a' })
      void (async () => {
        try {
          assertRuntimeAccess(context, plan.request.action, skill, data)
          const outcome = plan.request.action === 'prepare'
            ? await prepareSkillRuntime(plan.resolved, { plan, cwd: plan.cwd, mirrors: plan.mirrors, buildPolicy: plan.request.buildPolicy, rebuild: plan.request.rebuild, abortSignal: controller.signal, onOutput })
            : await runSkillEntry(plan.resolved, { plan, cwd: plan.cwd, entry: plan.request.entry!, abortSignal: controller.signal, onOutput, operationId: id })
          const success = outcome.status === 'ready' && !outcome.result.errorCode && (record.action === 'prepare' || outcome.result.exitCode === 0)
          persistOp({ ...record, status: outcome.result.errorCode === 'cancelled' ? 'cancelled' : success ? 'completed' : 'failed', finishedAt: new Date().toISOString(), result: { ...outcome.result } })
        } catch (error) {
          persistOp({ ...record, status: 'failed', finishedAt: new Date().toISOString(), result: { errorCode: error instanceof RuntimeAccessError ? error.code : 'operation_failed', message: String(error) } })
        } finally { inflight.delete(id) }
      })()
      return { status: 200, body: { operationId: id, status: 'running' } }
    }),
    'GET /skill-runtime/operations/:id': wrap((_data, params) => {
      let op = loadOp(params.id!)
      if (!op) return { status: 404, body: { code: 'operation_missing', error: '无效操作标识' } }
      if (active(op) && op.ownerPid && !isPidAlive(op.ownerPid)) {
        op = { ...op, status: 'failed', finishedAt: new Date().toISOString(), result: { errorCode: 'process_cleanup_failed', message: '执行进程已退出；环境租约仍负责保护未确认停止的子进程' } }
        persistOp(op)
      }
      return { status: 200, body: { ...op, ...(existsSync(logPath(op.id)) ? { logRef: logPath(op.id) } : {}) } }
    }),
    'GET /skill-runtime/operations/:id/log': wrap((_data, params, res) => {
      const op = loadOp(params.id!)
      if (!op) return { status: 404, body: { code: 'operation_missing' } }
      if (!existsSync(logPath(op.id))) return { status: 200, body: { text: '', nextCursor: 0, done: !active(op) } }
      if (params.download === '1' && res) {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="skill-runtime-${op.id}.log"` })
        createReadStream(logPath(op.id)).on('error', () => res.destroy()).pipe(res)
        return { status: 200, handled: true }
      }
      const cursor = Number(params.cursor ?? 0)
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw new RuntimeAccessError('invalid_cursor', '无效日志游标', 400)
      const fd = openSync(logPath(op.id), 'r')
      try {
        const size = statSync(logPath(op.id)).size
        const bytes = Buffer.alloc(Math.min(65536, Math.max(0, size - cursor)))
        const count = readSync(fd, bytes, 0, bytes.length, cursor)
        if (count && cursor > 0 && (bytes[0]! & 0xc0) === 0x80) throw new RuntimeAccessError('invalid_cursor', '游标不在 UTF-8 字符边界', 400)
        let end = count
        // Keep a partial UTF-8 suffix for the next read, even during active appends.
        if (end) {
          let start = end - 1
          while (start > 0 && (bytes[start]! & 0xc0) === 0x80) start--
          const lead = bytes[start]!, length = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4
          if (end - start < length) end = start
        }
        return { status: 200, body: { text: bytes.subarray(0, end).toString('utf8'), nextCursor: cursor + end, done: !active(op) && cursor + end >= size } }
      } finally { closeSync(fd) }
    }),
    'POST /skill-runtime/operations/:id/cancel': wrap((_data, params) => {
      const op = loadOp(params.id!), controller = inflight.get(params.id!)
      if (!op) return { status: 404, body: { code: 'operation_missing' } }
      if (!controller) return { status: 409, body: { code: 'not_running', error: '操作不属当前进程或已结束' } }
      persistOp({ ...op, status: 'cancelling' })
      controller.abort()
      return { status: 200, body: { status: 'cancelling' } }
    }),
    'POST /skill-runtime/remove-env': wrap(async data => {
      const { plan } = await checkedPlan(data, 'remove-env')
      if (data.envKey !== plan.envKey) throw new RuntimeAccessError('preview_mismatch', '环境键与预览不一致', 409)
      const result = defaultEnvManager().remove({ workspace: plan.cwd, skill: plan.preview.skill, packageRef: plan.resolved.packageRef, interpreter: plan.interpreter, buildPolicy: plan.request.buildPolicy })
      return { status: result.removed ? 200 : 409, body: result }
    }),
  }
}
