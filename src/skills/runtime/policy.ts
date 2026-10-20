import { loadConfig } from '../../config/manager.js'
import { projectSurfaceAllowed } from '../../config/project-trust.js'
import { isToolDenied, type PermissionAllowRule, type PermissionOverlay } from '../../agent/permissions.js'
import { getInvokedSkills } from '../../agent/skill-gate.js'
import type { SkillDefinition } from '../skill-loader.js'

export type RuntimeAction = 'doctor' | 'prepare' | 'run' | 'remove-env'
export interface RuntimePolicyContext {
  cwd: string
  origin: 'model' | 'user'
  sessionId?: string
  planMode?: string
  deny?: readonly PermissionAllowRule[]
  overlay?: PermissionOverlay
}
export function runtimeSkillScope(skill: Pick<SkillDefinition, 'source'>): 'project' | 'personal' {
  return skill.source === 'rivet' || skill.source === 'project-agents' || skill.source === 'project-claude' ? 'project' : 'personal'
}
export class RuntimeAccessError extends Error {
  constructor(readonly code: string, message: string, readonly status = 403) { super(message) }
}
export function assertRuntimeAccess(context: RuntimePolicyContext, action: RuntimeAction, skill?: SkillDefinition, input: Record<string, unknown> = {}): void {
  const config = loadConfig({ cwd: context.cwd })
  const canonical = { ...input, action, ...(skill ? { name: skill.name } : {}) }
  if (isToolDenied('skill_runtime', canonical, [...config.agent.permissions.deny, ...(context.deny ?? []), ...(context.overlay?.deny ?? [])])) {
    throw new RuntimeAccessError('permission_denied', 'skill_runtime 被有效权限规则拒绝')
  }
  if (action !== 'doctor' && context.planMode === 'planning') throw new RuntimeAccessError('plan_mode', 'Plan Mode 只允许诊断与只读预览')
  if (skill && runtimeSkillScope(skill) === 'project' && !projectSurfaceAllowed(context.cwd, 'skills')) {
    throw new RuntimeAccessError('permission_denied', '项目尚未授信，不能读取或执行项目技能')
  }
  if (skill && (action === 'prepare' || action === 'run')) {
    const mode = skill.mode ?? skill.metadata?.defaultMode ?? 'auto'
    if (mode === 'off') throw new RuntimeAccessError('permission_denied', `Skill「${skill.name}」已停用`)
    if (mode === 'manual' && context.origin === 'model' && !getInvokedSkills(context.sessionId).has(skill.name.toLowerCase())) {
      throw new RuntimeAccessError('permission_denied', `Skill「${skill.name}」须先在本会话显式加载`)
    }
  }
}
