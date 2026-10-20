import { isAbsolute, resolve } from 'node:path'
import { statSync } from 'node:fs'
import type { SkillCreationContext, SkillDraftReference } from '../server/protocol.js'
import { SkillDrafts } from './skill-drafts.js'
import { SkillManagement } from './skill-management.js'

export const SKILL_CREATION_TOOLS = ['skill', 'ask_user_question', 'read_file', 'glob', 'grep'] as const
export interface SkillDraftWrite {
  name: string
  scope: 'personal' | 'project'
  content: string
  expectedVersion?: string | null
}
export type SkillDraftWriter = (input: SkillDraftWrite) => Promise<SkillDraftReference>

export function parseSkillCreation(value: unknown): SkillCreationContext {
  if (!value || typeof value !== 'object') throw new Error('Invalid skillCreation')
  const raw = value as Record<string, unknown>
  if (raw.scope !== 'personal' && raw.scope !== 'project') throw new Error('Choose personal or project scope')
  if (typeof raw.initialInput !== 'string' || !raw.initialInput.trim() || raw.initialInput.length > 16000) throw new Error('Missing skill creation input')
  let cwd: string | undefined
  if (raw.scope === 'project') {
    if (typeof raw.cwd !== 'string' || !isAbsolute(raw.cwd) || !statSync(raw.cwd).isDirectory()) throw new Error('Project scope requires an existing absolute directory')
    cwd = resolve(raw.cwd)
  }
  return { scope: raw.scope, ...(cwd ? { cwd } : {}), initialInput: raw.initialInput }
}

export function createSkillDraftWriter(context: () => SkillCreationContext | undefined, management = new SkillManagement()): SkillDraftWriter {
  const drafts = new SkillDrafts(management)
  return async input => {
    const target = context()
    if (!target || input.scope !== target.scope) throw new Error('Draft scope differs from the user-selected creation scope')
    const saved = drafts.save(target, input.name, input.content, input.expectedVersion ?? null)
    return { name: saved.name, scope: target.scope, ...(target.cwd ? { cwd: target.cwd } : {}), version: saved.version }
  }
}
