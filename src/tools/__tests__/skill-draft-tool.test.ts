import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SKILL_TOOL } from '../skill.js'
import type { ToolCallParams } from '../types.js'
import { createSkillDraftWriter } from '../../skills/skill-creation.js'
import { SkillManagement } from '../../skills/skill-management.js'
import { SkillDrafts } from '../../skills/skill-drafts.js'
import { createRouter } from '../../server/index.js'
import { buildSkillManagementRoutes } from '../../server/skill-management-routes.js'

test('native draft saving uses the trusted scope and shares CLI/HTTP identity and revision checks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-skill-'))
  const cwd = join(root, 'project'); mkdirSync(cwd)
  const management = new SkillManagement(join(root, 'home'), join(root, 'external'))
  const target = { scope: 'project' as const, cwd, initialInput: 'Create a reporting skill' }
  const writer = createSkillDraftWriter(() => target, management)
  const content = '---\nname: weekly\ndescription: Use for weekly reports.\n---\nFollow agreed steps.'
  const params = { cwd, toolUseId: 'draft', input: { action: 'save_draft', name: 'weekly', scope: 'project', content, expectedVersion: null }, saveSkillDraft: writer } as ToolCallParams
  assert.equal((await SKILL_TOOL.execute({ ...params, saveSkillDraft: undefined })).isError, true)
  assert.equal((await SKILL_TOOL.execute({ ...params, input: { ...params.input, scope: 'personal' } })).isError, true)
  const saved = await SKILL_TOOL.execute(params)
  assert.ok(!saved.isError); assert.equal(saved.skillDraft?.name, 'weekly')
  assert.deepEqual(saved.skillDraft, { name: 'weekly', scope: 'project', cwd, version: new SkillDrafts(management).list(target)[0]!.version })
  assert.ok(!management.list(cwd).skills.some(s => s.name === 'weekly'))
  assert.equal(SKILL_TOOL.requiresApproval(params), true)
  const router = createRouter(buildSkillManagementRoutes('fixture', management)), headers = { authorization: 'Bearer fixture' }
  const empty = content.replace('Use for weekly reports.', '').replace('Follow agreed steps.', '')
  assert.equal((await router('PUT', '/skill-drafts/weekly', { ...target, content: empty }, headers)).status, 400)
  assert.equal((await router('PUT', '/skill-drafts/weekly', { ...target, content: content.replace('weekly', 'other') }, headers)).status, 400)
  assert.equal((await router('POST', '/skill-drafts/weekly/approve', { ...target, expectedVersion: 'stale' }, headers)).status, 409)
  assert.equal((await router('POST', '/skill-drafts/weekly/approve', { ...target, expectedVersion: saved.skillDraft!.version }, headers)).status, 200)
  assert.deepEqual(new SkillDrafts(management).status(target, 'weekly', saved.skillDraft!.version), { status: 'published' })
})
