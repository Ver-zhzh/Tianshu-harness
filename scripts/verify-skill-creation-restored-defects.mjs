/** Restore each skill-creation contract defect in memory; never rewrite a shared checkout. */
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { registerHooks, createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'

const root = resolve(import.meta.dirname, '..')
const { transformSync } = createRequire(join(root, 'package.json'))('esbuild')
const cases = [
  ['cross-process draft lock absent', 'src/skills/skill-drafts.ts', 'src/skills/__tests__/skill-draft-contract.test.ts', 'another process holding', s => s.replace(/return new RepoLock\([^\n]+\.withLock\(write\)/, 'return write()')],
  ['identity mismatch accepted', 'src/skills/skill-drafts.ts', 'src/skills/__tests__/skill-draft-contract.test.ts', 'all draft writes', s => s.replace("if (skill.name !== name) throw new Error('Draft name must match the YAML name')", '')],
  ['empty description or body accepted', 'src/skills/skill-drafts.ts', 'src/skills/__tests__/skill-draft-contract.test.ts', 'all draft writes', s => s.replace("if (!skill.description.trim() || !skill.body.trim()) throw new Error('Skill draft requires a description and instructions')", '')],
  ['missing YAML name falls back to filename', 'src/skills/skill-drafts.ts', 'src/skills/__tests__/skill-draft-contract.test.ts', 'all draft writes', s => s.replace("parseSkillMarkdown(content, '')", 'parseSkillMarkdown(content, name)')],
  ['stale version silently overwrites', 'src/skills/skill-drafts.ts', 'src/skills/__tests__/skill-draft-contract.test.ts', 'draft revisions', s => s.replace('if (expectedVersion === undefined) return', 'return; if (expectedVersion === undefined) return')],
  ['execution whitelist is only cosmetic', 'src/agent/tool-pipeline.ts', 'src/agent/__tests__/tool-pipeline.test.ts', 'enforces creation-session', s => s.replace('if (deps.config.executionToolAllowlist &&', 'if (false && deps.config.executionToolAllowlist &&')],
  ['writer lost at actual tool consumer', 'src/agent/tool-pipeline.ts', 'src/agent/__tests__/tool-pipeline.test.ts', 'passes the draft writer', s => s.replace('saveSkillDraft: deps.config.saveSkillDraft', 'saveSkillDraft: undefined')],
  ['target changes leave old working directory', 'src/server/skill-creation-session.ts', 'src/server/__tests__/skill-creation-session.test.ts', 'creation is idle', s => s.replace('cwd: workspace.path, workspaceSource: workspace.source', 'cwd: record.cwd, workspaceSource: record.workspaceSource')],
]

if (process.env.SKILL_CREATION_RESTORED_DEFECT !== undefined) {
  const entry = cases[Number(process.env.SKILL_CREATION_RESTORED_DEFECT)]
  assert.ok(entry, 'unknown restored defect')
  registerHooks({ load(url, context, next) {
    if (!url.startsWith('file:') || fileURLToPath(url) !== join(root, entry[1])) return next(url, context)
    const source = readFileSync(new URL(url), 'utf8')
    const restored = entry[4](source)
    assert.notEqual(restored, source, 'restoration anchor missing')
    return { shortCircuit: true, format: 'module', source: transformSync(restored, { loader: 'ts', format: 'esm', target: 'esnext' }).code }
  } })
} else {
  const home = mkdtempSync(join(tmpdir(), 'rivet-creator-mutation-'))
  writeFileSync(join(home, 'config.json'), '{}')
  try {
    for (const [i, [name, , file, pattern]] of cases.entries()) {
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--import', import.meta.filename, '--test', '--test-name-pattern=' + pattern, file], {
        cwd: root, env: { ...process.env, RIVET_HOME: home, RIVET_SESSION_DIR: join(home, 'sessions'), SKILL_CREATION_RESTORED_DEFECT: String(i) },
        encoding: 'utf8', timeout: 30_000, windowsHide: true,
      })
      const output = result.stdout + result.stderr
      assert.ok(result.status === 1 && output.includes('AssertionError') && !output.includes('restoration anchor missing'), `${name}: expected assertion RED\n${output.slice(-2500)}`)
      console.log('ASSERTION RED: ' + name)
    }
    console.log(`${cases.length} restored defects caught; checkout untouched`)
  } finally { rmSync(home, { recursive: true, force: true }) }
}
