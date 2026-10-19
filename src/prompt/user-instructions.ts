import { createHash } from 'node:crypto'

export const USER_INSTRUCTIONS_MAX_RENDERED_CHARS = 1024
export const USER_INSTRUCTIONS_MAX_FILE_BYTES = 16384

export type UserInstructionsSnapshot =
  | Readonly<{ version: 1; state: 'disabled' }>
  | Readonly<{ version: 1; state: 'active'; text: string; digest: string }>

export type AppliedUserInstructions =
  | Readonly<{ version: 1; state: 'active'; digest: string }>
  | Readonly<{ version: 1; state: 'revoked' }>

export type UserInstructionsErrorCode =
  | 'user_instructions_config_invalid'
  | 'user_instructions_source_invalid'
  | 'user_instructions_over_budget'
  | 'user_instructions_boundary_required'
  | 'user_instructions_payload_invalid'

export class UserInstructionsError extends Error {
  readonly retryable = false
  constructor(readonly code: UserInstructionsErrorCode, detail: string) {
    super(`${code}: ${detail}`)
    this.name = 'UserInstructionsError'
  }
}

export const DISABLED_USER_INSTRUCTIONS: UserInstructionsSnapshot = Object.freeze({ version: 1, state: 'disabled' })
export const USER_INSTRUCTIONS_REVOKED_BLOCK = '<user-instructions state="disabled">此前同名用户长期指令已停用；其他安全约束继续生效。</user-instructions>'

export function normalizeUserInstructions(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim()
}

function activeBlock(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  return `<user-instructions>\n用户长期指令；本块替代此前同名块；不改变运行时权限；与项目安全约束冲突时从严。\n${escaped}\n</user-instructions>`
}

export function createUserInstructionsSnapshot(raw: string): UserInstructionsSnapshot {
  const text = normalizeUserInstructions(raw)
  if (!text || text.includes('\0')) throw new UserInstructionsError('user_instructions_source_invalid', '规则必须是非空且不含 NUL 的 UTF-8 文本。')
  const block = activeBlock(text)
  const chars = block.length + 2
  if (chars > USER_INSTRUCTIONS_MAX_RENDERED_CHARS) {
    throw new UserInstructionsError('user_instructions_over_budget', `完整渲染为 ${chars} 字符，上限 ${USER_INSTRUCTIONS_MAX_RENDERED_CHARS}；请缩短规则，不会自动截断。`)
  }
  return Object.freeze({ version: 1, state: 'active', text, digest: createHash('sha256').update(block).digest('hex') })
}

/** IPC is a validation boundary; missing or damaged snapshots must never disable rules. */
export function parseUserInstructionsSnapshot(raw: unknown): UserInstructionsSnapshot {
  if (raw && typeof raw === 'object') {
    const value = raw as Record<string, unknown>
    if (value.version === 1 && value.state === 'disabled' && Object.keys(value).every(key => ['version', 'state'].includes(key))) return DISABLED_USER_INSTRUCTIONS
    if (value.version === 1 && value.state === 'active' && typeof value.text === 'string'
      && Object.keys(value).every(key => ['version', 'state', 'text', 'digest'].includes(key))) {
      try {
        const snapshot = createUserInstructionsSnapshot(value.text)
        if (snapshot.state === 'active' && snapshot.text === value.text && snapshot.digest === value.digest) return snapshot
      } catch { /* report a payload error, not a local-file error */ }
    }
  }
  throw new UserInstructionsError('user_instructions_payload_invalid', '规则快照缺失、损坏或版本不受支持；已拒绝执行。')
}

export function isAppliedUserInstructions(raw: unknown): raw is AppliedUserInstructions {
  if (!raw || typeof raw !== 'object') return false
  const value = raw as Record<string, unknown>
  return value.version === 1 && (value.state === 'revoked'
    ? Object.keys(value).every(key => ['version', 'state'].includes(key))
    : value.state === 'active' && typeof value.digest === 'string' && /^[a-f0-9]{64}$/.test(value.digest)
      && Object.keys(value).every(key => ['version', 'state', 'digest'].includes(key)))
}

export function appliedUserInstructions(snapshot: UserInstructionsSnapshot, prior?: AppliedUserInstructions): AppliedUserInstructions | undefined {
  return snapshot.state === 'active' ? { version: 1, state: 'active', digest: snapshot.digest }
    : prior ? { version: 1, state: 'revoked' } : undefined
}

export function userInstructionsMatch(snapshot: UserInstructionsSnapshot, applied?: AppliedUserInstructions): boolean {
  return snapshot.state === 'active' ? applied?.state === 'active' && applied.digest === snapshot.digest : applied?.state !== 'active'
}

export function renderUserInstructions(snapshot?: UserInstructionsSnapshot, revoked = false): string | undefined {
  if (!snapshot || snapshot.state === 'disabled') return revoked ? USER_INSTRUCTIONS_REVOKED_BLOCK : undefined
  const checked = parseUserInstructionsSnapshot(snapshot)
  return checked.state === 'active' ? activeBlock(checked.text) : undefined
}
