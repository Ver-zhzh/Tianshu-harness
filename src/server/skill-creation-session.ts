import { parseSkillCreation, SKILL_CREATION_TOOLS } from '../skills/skill-creation.js'
import type { CreateSessionInput, RuntimeSessionManager } from './session-manager.js'
import type { SkillCreationContext } from './protocol.js'
import { withAuth } from './route-auth.js'
import type { RouteHandler } from './index.js'
import { resolveSessionWorkspaceForSession } from './workspace.js'
import { rivetHome } from '../config/paths.js'
import { loadConfig } from '../config/manager.js'
import type { SessionRecord } from './protocol.js'

export const isPlanModeState = (v: unknown): v is 'off' | 'planning' =>
  v === 'off' || v === 'planning'
export const isAskModeState = (v: unknown): v is 'off' | 'asking' =>
  v === 'off' || v === 'asking'

export function creationTargetRecord(record: SessionRecord, value: unknown): Partial<SessionRecord> {
  const context = parseSkillCreation(value)
  const workspace = resolveSessionWorkspaceForSession({ requested: context.cwd,
    mode: context.scope === 'personal' ? 'scratch' : 'explicit', processCwd: record.cwd,
    sessionId: record.id, rivetHome: rivetHome(), readConfig: loadConfig })
  assertCreationWorkspace(context, workspace.source)
  return { skillCreation: context, cwd: workspace.path, workspaceSource: workspace.source, workspaceRoots: undefined }
}

export function assertCreationWorkspace(context: SkillCreationContext | undefined, source: string) {
  if (context?.scope === 'personal' && source !== 'scratch') throw new Error('Cannot create the isolated skill workspace')
}

export function creationSessionInput(input: CreateSessionInput): CreateSessionInput {
  if (input.initialComposerDraft !== undefined && (typeof input.initialComposerDraft !== 'string' || input.initialComposerDraft.length > 16000 || input.prompt?.trim())) throw new Error('Invalid initial composer draft')
  if (!input.skillCreation) return input
  const skillCreation = parseSkillCreation(input.skillCreation)
  if (input.prompt?.trim()) throw new Error('Skill creation starts only after the user sends a message')
  return { ...input, skillCreation, cwd: skillCreation.cwd, workspaceRoots: undefined,
    workspaceMode: skillCreation.scope === 'personal' ? 'scratch' : 'explicit', isolatedWorktree: false,
    allowedTools: [...SKILL_CREATION_TOOLS] }
}

export function readCreationRequest(data: object & { prompt?: string }): { input: Pick<CreateSessionInput, 'skillCreation' | 'initialComposerDraft'> } | { error: string } {
  try {
    const input = creationSessionInput({
      ...('skillCreation' in data ? { skillCreation: parseSkillCreation(data.skillCreation) } : {}),
      ...('initialComposerDraft' in data ? { initialComposerDraft: data.initialComposerDraft as string } : {}),
      prompt: data.prompt,
    })
    return { input: { skillCreation: input.skillCreation, initialComposerDraft: input.initialComposerDraft } }
  } catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
}

export function creationPrompt(prompt: string, context?: SkillCreationContext): string {
  if (!context) return prompt
  if (!context.started && !prompt.trim().startsWith('/skill skill-creator')) prompt = `/skill skill-creator ${prompt}`
  return `${prompt}\nSelected draft scope: ${context.scope}${context.cwd ? ` (${context.cwd})` : ''}. Save a draft only; publication requires the review card.`
}

export function buildSkillCreationRoutes(manager: RuntimeSessionManager, apiToken?: string): Record<string, RouteHandler> {
  return { 'PUT /sessions/:id/skill-creation': withAuth(async (body, params) => {
    try { return { status: 200, body: manager.updateSkillCreation(params!.id!, body) } }
    catch (error) { return { status: 409, body: { error: String(error) } } }
  }, apiToken) }
}
