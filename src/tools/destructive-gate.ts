import { resolve } from 'node:path'
import { spawnGitSync } from './spawn-git.js'
import { createHash } from 'node:crypto'
import { GIT_CLEAR_RE } from './destructive-patterns.js'
import { verificationArgv } from './verification-command.js'
import { currentFileVersion } from '../agent/file-version.js'

export type DestructiveGateDecision = { block: false } | { block: true; message: string; actions: string[] }
export interface DestructiveGateState {
  noteVerification(status: 'passed' | 'failed' | 'blocked'): void
  noteToolExecuted(): void
  noteAdvisoryPressure(): void
  evaluate(toolName: string, input: Record<string, unknown>, cwd?: string): DestructiveGateDecision
  /** Only the pipeline's actual user approval may grant version-bound actions. */
  approve(toolName: string, input: Record<string, unknown>, cwd: string): void
}

function actions(command: string, cwd: string): Array<{ key: string; label: string; reusable: boolean }> {
  // Parse only literal Git segments. Opaque scripts remain subject to approval on every call.
  const result: Array<{ key: string; label: string; reusable: boolean }> = []
  for (const segment of command.split(/\n|;|&&|\|\|/)) {
    if (!GIT_CLEAR_RE.test(segment)) continue
    const start = segment.search(/\bgit\s/), text = segment.slice(Math.max(0, start)).trim()
    const argv = verificationArgv(text)
    const op = argv?.findIndex(a => ['checkout', 'restore', 'reset', 'stash', 'clean'].includes(a)) ?? -1
    const separator = argv?.indexOf('--', op + 1) ?? -1
    let root = cwd, knownGlobals = true
    if (argv) for (let i = 1; i < op; i++) {
      if (argv[i] === '-C' && argv[i + 1]) root = resolve(root, argv[++i]!)
      else if (argv[i]?.startsWith('-C')) root = resolve(root, argv[i]!.slice(2))
      else if (argv[i] !== '--no-pager') knownGlobals = false
    }
    const targets = separator >= 0 ? [...new Set(argv!.slice(separator + 1))] : []
    const versions = targets.map(target => {
      const file = resolve(root, target)
      try { return { file, version: currentFileVersion(file) } } catch { return { file, version: undefined } }
    }).sort((a, b) => a.file.localeCompare(b.file))
    const direct = /^(?:rtk(?:\s+proxy)?\s+)?git\s/.test(segment.trimStart()) && command.trimStart().startsWith(segment.trimStart())
    const reusable = direct && knownGlobals && !!argv && op > 0 && targets.length > 0 && targets.every(target => !/[?*\[\]]/.test(target) && !target.startsWith(':')) && versions.every(v => v.version !== undefined) && !/[`$<>|]/.test(text)
    // Include the source/ref and flags before --; never grant a different restore operation.
    let head: string | null = null
    if (reusable) { try { const probe = spawnGitSync(['rev-parse', '--verify', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 1000 }); if (probe.status === 0) head = String(probe.stdout).trim() } catch { /* Unknown source stays visible in the identity. */ } }
    const identity = reusable ? [argv!.slice(0, op).filter((_, i) => i === 0), root, head, argv!.slice(op, separator), versions] : [root, text, versions, command.slice(0, command.indexOf(segment))]
    result.push({ key: createHash('sha256').update(JSON.stringify(identity)).digest('hex'), label: `${argv?.[op] ?? 'git clear'}: ${targets.length ? versions.map(v => v.file).join(', ') : text}`, reusable })
  }
  if (!result.length && GIT_CLEAR_RE.test(command)) result.push({ key: 'opaque', label: '无法精确解析的 Git 清场操作', reusable: false })
  return result
}

export function createDestructiveGateState(_options?: { windowSize?: number; getVirtueCredit?: () => number }): DestructiveGateState {
  const authorized = new Set<string>()
  let verification: 'passed' | 'failed' | 'blocked' | 'unknown' = 'unknown'
  return {
    noteVerification(status) { verification = status },
    noteToolExecuted() {},
    noteAdvisoryPressure() {},
    approve(name, input, cwd) {
      if (name !== 'bash' || typeof input.command !== 'string') return
      for (const action of actions(input.command, cwd)) if (action.reusable) authorized.add(action.key)
    },
    evaluate(name, input, cwd = process.cwd()) {
      if (name !== 'bash' || typeof input.command !== 'string') return { block: false }
      const pending = actions(input.command, cwd).filter(action => !action.reusable || !authorized.has(action.key))
      if (!pending.length) return { block: false }
      return { block: true, actions: pending.map(a => a.key), message: [
        'destructive-gate: Git 清场需要真实用户审批或已有许可策略；模型重复调用不会授权。',
        `验证事实：${verification}。本次尚未执行。`,
        ...pending.map(a => `目标：${a.label} [${a.key.slice(0, 12)}]`),
        '恢复出口：读取当前文件，使用绑定 expected_version 的 edit_file.operations 或 bash.write_files 精确捕获事务；缺少捕获或有版本冲突时保留现场。Git 内容只作差异对照。',
      ].join('\n') }
    },
  }
}
