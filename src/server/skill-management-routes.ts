import { sessionSkillSnapshot } from '../skills/session-skill-snapshot.js'
import { queueSessionSkillMode } from '../skills/session-skill-policy.js'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { RouteHandler } from './index.js'
import { withAuth } from './route-auth.js'
import { SkillManagement, type SkillContext } from '../skills/skill-management.js'
import { SkillImports, type ImportSource } from '../skills/skill-import.js'
import type { SkillMode } from '../skills/skill-metadata.js'
import { SkillDrafts, SkillDraftConflict, skillDraftVersion } from '../skills/skill-drafts.js'
import { completeSkillDraft } from '../skills/skill-draft-model.js'
import { parseSkillMarkdown } from '../skills/skill-loader.js'

export function buildSkillManagementRoutes(apiToken?: string, management = new SkillManagement(), complete = completeSkillDraft) {
  const imports = new SkillImports(management)
  const drafts = new SkillDrafts(management)
  const context = (data: Record<string, unknown>): SkillContext => {
    if (data.scope !== 'personal' && data.scope !== 'project') throw new Error('Choose personal or project scope')
    const result: SkillContext = { scope: data.scope, cwd: typeof data.cwd === 'string' ? data.cwd : undefined }
    management.root(result)
    return result
  }
  const cwd = (data: Record<string, unknown>) => typeof data.cwd === 'string' ? data.cwd : undefined
  const string = (data: Record<string, unknown>, key: string) => { if (typeof data[key] !== 'string') throw new Error(`Missing ${key}`); return data[key] as string }
  const wrap = (handler: (data: Record<string, unknown>, params: Record<string, string>) => unknown | Promise<unknown>): RouteHandler => withAuth(async (body, params) => {
    try { return { status: 200, body: await handler(body && typeof body === 'object' ? body as Record<string, unknown> : {}, params ?? {}) } }
    catch (error) { return { status: error instanceof SkillDraftConflict ? 409 : 400, body: { error: error instanceof Error ? error.message : String(error) } } }
  }, apiToken)
  return {
    'POST /skill-drafts/parse': wrap(data => {
      const { name, description, body } = parseSkillMarkdown(string(data, 'content'), 'draft')
      return { name, description, body }
    }),
    'GET /skill-drafts/:name/status': wrap((_data, params) => drafts.status(context(params), params.name!, params.version ?? '')),
    'GET /skill-library': wrap((_data, params) => management.list(params.cwd)),
    'GET /skill-library/:skillId': wrap((_data, params) => {
      const skill = management.inspect(params.skillId!, params.cwd)
      // runtime 为只读声明摘要（issue #523 WP1）——不触发任何环境准备/安装。
      return { skill, content: management.content(params.skillId!, params.cwd), runtime: skill.metadata?.runtime ?? null }
    }),
    'PUT /skill-session/:sessionId/mode': wrap((data, params) => {
      const directory = string(data, 'cwd')
      return queueSessionSkillMode(directory, params.sessionId!, sessionSkillSnapshot(directory, params.sessionId!, management, { purpose: 'catalog' }), string(data, 'name'), string(data, 'mode') as SkillMode)
    }),
    'PUT /skill-library/:skillId/mode': wrap((data, params) => management.setMode(params.skillId!, string(data, 'mode') as SkillMode, cwd(data))),
    'PUT /skill-library/:skillId': wrap((data, params) => management.edit(params.skillId!, string(data, 'content'), string(data, 'expectedVersion'), cwd(data))),
    'DELETE /skill-library/:skillId': wrap((_data, params) => { management.remove(params.skillId!, params.version!, params.cwd); return { removed: true, effective: 'new-session' } }),
    'POST /skill-library/:skillId/copy': wrap((data, params) => imports.copy(params.skillId!, context(data), cwd(data))),
    'POST /skill-library/:skillId/update': wrap((data, params) => imports.update(params.skillId!, cwd(data))),
    'POST /skill-import/preview': wrap(data => imports.preview(data.source as ImportSource)),
    'POST /skill-import/diff': wrap(data => imports.diff(string(data, 'previewId'), string(data, 'candidateId'), string(data, 'skillId'), cwd(data))),
    'POST /skill-import/install': wrap(data => {
      if (!Array.isArray(data.selections)) throw new Error('Missing selections')
      return imports.install(string(data, 'previewId'), context(data), data.selections as Parameters<SkillImports['install']>[2])
    }),
    'DELETE /skill-import/:previewId': wrap((_data, params) => { imports.cancel(params.previewId!); return { cancelled: true } }),
    'GET /skill-import/standard-dirs': wrap((_data, params) => ({ directories: [
      join(homedir(), '.claude', 'skills'), join(homedir(), '.agents', 'skills'), join(homedir(), '.codex', 'skills'),
      ...(params.cwd ? [join(params.cwd, '.claude', 'skills'), join(params.cwd, '.agents', 'skills')] : []),
    ] })),
    'GET /skill-drafts': wrap((_data, params) => ({ drafts: drafts.list(context(params)) })),
    'GET /skill-drafts/:name': wrap((_data, params) => { const content = drafts.read(context(params), params.name!); return { content, version: skillDraftVersion(content) } }),
    'PUT /skill-drafts/:name': wrap((data, params) => {
      if (data.expectedVersion !== undefined && data.expectedVersion !== null && typeof data.expectedVersion !== 'string') throw new Error('Invalid expectedVersion')
      return drafts.save(context(data), params.name!, string(data, 'content'), data.expectedVersion as string | null | undefined)
    }),
    'POST /skill-drafts/:name/approve': wrap((data, params) => {
      if (data.expectedVersion !== undefined && typeof data.expectedVersion !== 'string') throw new Error('Invalid expectedVersion')
      return drafts.approve(context(data), params.name!, data.expectedVersion as string | undefined)
    }),
    'DELETE /skill-drafts/:name': wrap((_data, params) => drafts.reject(context(params), params.name!, params.version)),
    'POST /skill-drafts/generate': wrap(data => {
      if (!Array.isArray(data.paths) || data.paths.some(p => typeof p !== 'string')) throw new Error('Invalid source paths')
      return drafts.generate(context(data), { name: string(data, 'name'), goal: string(data, 'goal'), paths: data.paths as string[], excerpt: typeof data.excerpt === 'string' ? data.excerpt : undefined }, complete)
    }),
  }
}
