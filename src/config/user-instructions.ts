import { constants, openSync, closeSync, fstatSync, readSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { rivetHome } from './paths.js'
import { DISABLED_USER_INSTRUCTIONS, USER_INSTRUCTIONS_MAX_FILE_BYTES, UserInstructionsError, createUserInstructionsSnapshot, type UserInstructionsSnapshot } from '../prompt/user-instructions.js'

export interface UserInstructionsConfig { enabled?: boolean; path?: string }

/** Capture before overlays and restore even when absent: overlays cannot create authority. */
export function userInstructionsConfig(raw: Record<string, unknown>): unknown {
  return structuredClone((raw.agent as Record<string, unknown> | undefined)?.userInstructions)
}

export function restoreUserInstructionsConfig(raw: Record<string, unknown>, userValue: unknown): Record<string, unknown> {
  const agent = { ...(raw.agent as Record<string, unknown> | undefined) }
  delete agent.userInstructions
  if (userValue !== undefined) agent.userInstructions = structuredClone(userValue)
  return { ...raw, agent }
}

export function loadUserInstructions(config?: UserInstructionsConfig): UserInstructionsSnapshot {
  if (config?.enabled !== true) return DISABLED_USER_INSTRUCTIONS
  if (typeof config.path !== 'string' || !isAbsolute(config.path)) {
    throw new UserInstructionsError('user_instructions_config_invalid', '启用用户指令必须指定 instructions 目录内的绝对路径。')
  }
  let fd: number | undefined
  try {
    const root = realpathSync(join(rivetHome(), 'instructions'))
    if (relative(join(realpathSync(rivetHome()), 'instructions'), root) !== '') throw new Error('instructions directory is redirected')
    const file = realpathSync(config.path)
    const rel = relative(root, file)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('outside instructions directory')
    const before = statSync(file)
    if (!before.isFile()) throw new Error('not a regular file')
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || realpathSync(config.path) !== file || realpathSync(join(rivetHome(), 'instructions')) !== root) throw new Error('source changed while opening')
    if (opened.size > USER_INSTRUCTIONS_MAX_FILE_BYTES) throw new Error('file exceeds 16384 bytes')
    const bytes = Buffer.alloc(USER_INSTRUCTIONS_MAX_FILE_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const n = readSync(fd, bytes, length, bytes.length - length, null)
      if (n === 0) break
      length += n
    }
    if (length > USER_INSTRUCTIONS_MAX_FILE_BYTES) throw new Error('file exceeds 16384 bytes')
    const after = fstatSync(fd)
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || length !== after.size) throw new Error('source changed while reading')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))
    return createUserInstructionsSnapshot(text)
  } catch (error) {
    if (error instanceof UserInstructionsError) throw error
    throw new UserInstructionsError('user_instructions_source_invalid', '规则文件不可用：需为 instructions 目录内不超过 16 KiB 的普通 UTF-8 文件；未启用本次运行。')
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
