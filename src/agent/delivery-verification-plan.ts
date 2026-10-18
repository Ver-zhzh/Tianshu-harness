import { deliveryScopeProgress } from './delivery-scope-progress.js'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildTestExecutionPlan, type DeliveryVerificationPlan } from '../tools/test-execution-plan.js'
import { renderTestCommand } from '../tools/test-command-render.js'
import { getShellCommand } from '../platform.js'
import { readCompletionCoverage } from '../tools/test-completion.js'
import type { TaskLedgerEvent } from './task-ledger.js'

export type { DeliveryVerificationPlan } from '../tools/test-execution-plan.js'

export function buildDeliveryVerificationPlan(cwd: string, required: readonly string[], uncovered: readonly string[], advisoryCount: number, evidence: readonly TaskLedgerEvent[] = [], currentSnapshotRef?: string): DeliveryVerificationPlan {
  const active = [...new Set(required.filter(file => existsSync(resolve(cwd, file))))].sort()
  const pending = [...new Set(uncovered)].sort()
  const scopes = deliveryScopeProgress(active, evidence, currentSnapshotRef)
  const plan = pending.length ? buildTestExecutionPlan(cwd, { files: pending, shard: false }) : undefined
  if (plan && scopes.requiredScopes.length) plan.groups = plan.groups.flatMap(group => {
    const missing = scopes.pendingScopes.filter(s => group.files.includes(s.path))
    const labels = [...new Set(missing.map(s => s.label ?? ''))]
    const unique = labels.every(label => label && new Set(scopes.requiredScopes.filter(s => group.files.includes(s.path) && s.label === label).map(s => s.project)).size === 1)
    return buildTestExecutionPlan(cwd, { files: group.files, projects: unique ? labels : [], shard: false }).groups
  })
  const pendingReasons: DeliveryVerificationPlan['pendingReasons'] = pending.map(path => {
    const blocked = plan?.blocked.find(block => block.files.includes(path))
    if (blocked) return { path, state: 'unsupported', reason: blocked.reason }
    const missing = scopes.pendingScopes.filter(s => s.path === path)
    if (missing.length) {
      const failed = evidence.some(e => !e.meta?.stale && readCompletionCoverage(e.meta?.coverage)?.files.some(f => f.path === path && f.outcome === 'failed' && missing.some(s => s.project === f.project)))
      return { path, state: failed ? 'failed' : 'not_run', reason: '待验证配置项目：' + missing.map(s => s.label || s.project.slice(0, 12)).join(', ') }
    }
    for (const event of [...evidence].reverse()) {
      const coverage = readCompletionCoverage(event.meta?.coverage)
      const file = coverage?.files.find(file => file.path === path)
      const targets = event.meta?.targetFiles
      if (!file && !(Array.isArray(targets) && targets.includes(path))) continue
      if (event.meta?.stale || coverage?.workspaceChanged || currentSnapshotRef && event.meta?.snapshotRef && event.meta.snapshotRef !== currentSnapshotRef) return { path, state: 'stale', reason: '运行后工作区或快照变化，需针对当前代码重新验证。' }
      if (file?.outcome === 'failed' || event.status === 'failed') return { path, state: 'failed', reason: '测试失败；先处理失败归因，再执行该批。' }
      return { path, state: 'incomplete', reason: coverage?.filtered ? '存在用例筛选，未证明完整文件。' : '证明缺失、不完整或没有通过用例。' }
    }
    return { path, state: 'not_run', reason: '尚无该文件的完整执行证明。' }
  })
  return { version: 1, ...scopes, required: active, covered: active.filter(file => !pending.includes(file)), pending, advisoryCount,
    batches: plan?.groups ?? [], blocked: plan?.blocked ?? [], pendingReasons }
}

/** Presentation is derived from the same plan consumed by the tool, never a second runner detector. */
export function renderDeliveryVerificationPlan(plan: DeliveryVerificationPlan, cwd: string): string[] {
  const lines = [`验证进度：required ${plan.required.length}，已覆盖 ${plan.covered.length}，剩余 ${plan.pending.length}；advisory ${plan.advisoryCount} 不阻断提交。`,
    '按剩余文件分批执行 run_tests；也可用下面的独立命令在对应 cwd 后台执行。完成后再调用 deliver_task；force 不豁免验证义务。']
  for (const item of plan.pendingReasons) lines.push(`  ${item.path}: ${item.state} — ${item.reason}`)
  for (const batch of plan.batches) {
    lines.push(`  run_tests(files=${JSON.stringify(batch.files)}${batch.projects ? ', projects=' + JSON.stringify(batch.projects) : ''}${batch.shard === false ? ', shard=false' : ''})`)
    if (batch.requiresAdapter) { lines.push('  此批需要运行时适配项目／分片覆盖；请执行上面的 run_tests 调用。'); continue }
    const command = renderTestCommand([batch.command, ...batch.args], getShellCommand().kind)
    lines.push(`  cwd: ${batch.cwd}`)
    if (command) {
      const shell = getShellCommand().kind
      const change = renderTestCommand(['cd', ...(shell === 'cmd' ? ['/d'] : shell === 'powershell' ? [] : ['--']), batch.cwd], shell)
      lines.push(`  ${batch.cwd === resolve(cwd) ? '' : shell === 'powershell' ? `Set-Location -LiteralPath '${batch.cwd.replaceAll("'", "''")}'; ` : `${change} && `}${command}`)
    } else lines.push('  当前 shell 无法安全表达该路径；请使用上面的 run_tests(files)。')
  }
  for (const block of plan.blocked) lines.push(`  未生成可采证批命令（${block.code}）：${block.reason}；义务保留：${block.files.join(', ')}`)
  return lines
}
export function formatDeliveryVerificationPlan(cwd: string, required: readonly string[], uncovered: readonly string[], advisoryCount: number): string[] {
  return renderDeliveryVerificationPlan(buildDeliveryVerificationPlan(cwd, required, uncovered, advisoryCount), cwd)
}
