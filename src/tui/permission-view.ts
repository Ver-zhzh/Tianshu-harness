import type { PermissionConfig, PermissionOverlay } from '../agent/permissions.js'
import type { PathGrant } from '../tools/path-grants.js'
import { formatPermissionLabel } from '../agent/approval-vocabulary.js'

export interface PermissionRuleView {
  id: string
  kind: 'allow' | 'deny' | 'bashAllow' | 'bashDeny'
  source: 'config' | 'session'
  pattern: string
  index: number
}
export interface PermissionView {
  cwd: string; trusted: boolean; mode: string; modeLabel: string
  rules: PermissionRuleView[]; grants: PathGrant[]
}
export function buildPermissionView(input: { cwd: string; trusted: boolean; mode: string; config?: PermissionConfig; overlay?: PermissionOverlay; grants: PathGrant[] }): PermissionView {
  const rules: PermissionRuleView[] = []
  const append = (kind: PermissionRuleView['kind'], source: PermissionRuleView['source'], values: unknown[]) => {
    const occurrences = new Map<string, number>()
    values.forEach((value, index) => {
      const pattern = typeof value === 'string' ? value : JSON.stringify(value)
      const occurrence = occurrences.get(pattern) ?? 0
      occurrences.set(pattern, occurrence + 1)
      rules.push({ id: JSON.stringify([source, kind, pattern, occurrence]), kind, source, pattern, index })
    })
  }
  for (const source of ['config', 'session'] as const) {
    const data = source === 'config' ? input.config : input.overlay
    append('allow', source, data?.allow ?? [])
    append('deny', source, data?.deny ?? [])
    append('bashAllow', source, source === 'config' ? input.config?.bash?.allowlist ?? [] : input.overlay?.bashAllow ?? [])
    append('bashDeny', source, source === 'config' ? input.config?.bash?.denylist ?? [] : input.overlay?.bashDeny ?? [])
  }
  return { cwd: input.cwd, trusted: input.trusted, mode: input.mode, modeLabel: formatPermissionLabel(input.mode), rules, grants: input.grants.map(grant => ({ ...grant })) }
}
/** Resolve against fresh data, never a stale displayed index. */
export function permissionRemovalCommand(selected: PermissionRuleView, current: PermissionView): string | undefined {
  const rule = current.rules.find(row => row.id === selected.id && row.source === 'session')
  return rule ? `/permission remove ${rule.kind} ${rule.index}` : undefined
}
