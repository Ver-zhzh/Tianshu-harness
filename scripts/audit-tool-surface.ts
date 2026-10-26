/** Isolated real assembly audit. Does not start models, workers, tests or an installed client. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInteractiveToolRegistry } from '../src/bootstrap.js'
import { DEFAULT_CONFIG } from '../src/config/default.js'
import { __resetToolPresetForTest } from '../src/tools/tool-preset.js'
import { TOOL_PRESET_NAMES } from '../src/tools/tool-preset-names.js'
import { createMemoryTool } from '../src/tools/memory.js'
import { TodoStore } from '../src/tools/todo-store.js'
import { gateToolDefinitions } from '../src/agent/tool-tiers.js'
import { setActiveScheduler } from '../src/server/cron-scheduler.js'

const cwd = mkdtempSync(join(tmpdir(), 'audit-tool-surface-'))
const envNames = ['RIVET_HOME','RIVET_CONFIG_PATH','RIVET_SESSION_DIR','RIVET_TOOL_PRESET','RIVET_IMPORT_RESOURCE','RIVET_BROWSER_DEBUG','RIVET_REVIEW_CHANGES','RIVET_REPO_GRAPH','RIVET_CAPABILITY','RIVET_CLI_DISCOVER','RIVET_WEB_CRAWL','RIVET_WEB_MAP','RIVET_LEAVE_MARK']
const prior = Object.fromEntries(envNames.map(name => [name, process.env[name]]))
const cost = (defs: readonly unknown[]) => { const value = JSON.stringify(defs); return { count: defs.length, definitionChars: value.length, definitionBytes: Buffer.byteLength(value) } }
try {
  envNames.forEach(name => { delete process.env[name] })
  process.env.RIVET_HOME = join(cwd, 'home'); process.env.RIVET_CONFIG_PATH = join(cwd, 'config.json'); process.env.RIVET_SESSION_DIR = join(cwd, 'sessions')
  setActiveScheduler(undefined)
  const rows = TOOL_PRESET_NAMES.map(preset => {
    process.env.RIVET_TOOL_PRESET = preset; __resetToolPresetForTest()
    const config = structuredClone(DEFAULT_CONFIG); config.agent.verificationSnapshot = 'off'; config.agent.defaultDomain = 'qiming'
    const { registry } = createInteractiveToolRegistry({ sessionId: `audit-${preset}`, todoStore: new TodoStore() } as any, config, cwd)
    if (preset !== 'taiyi') registry.register(createMemoryTool({} as any, { embeddingProvider: { isAvailable: () => false } } as any))
    const defs = registry.getDefinitions()
    const main = gateToolDefinitions(defs, { enabled: true, preset: registry.preset, toolDescriptions: 'full' })
    const compact = gateToolDefinitions(defs, { enabled: true, preset: registry.preset, toolDescriptions: 'compact' })
    const legacyNames = new Set([...main.map(def => def.name), 'galaxy','starflow','plan_task','git_scout'])
    return { preset, registeredCount: registry.getAllNames().length, main: cost(main), compact: cost(compact), names: main.map(def => def.name),
      ...(preset === 'minimal' ? { sameDefinitionsWithOldVisibility: cost(defs.filter(def => legacyNames.has(def.name))) } : {}) }
  })
  console.log(JSON.stringify({ basis: 'isolated CLI, no MCP/LSP/scheduler/forced extras; UTF-8 bytes and characters are not API tokens', rows }, null, 2))
} finally {
  setActiveScheduler(undefined)
  for (const [name, value] of Object.entries(prior)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
  __resetToolPresetForTest(); rmSync(cwd, { recursive: true, force: true })
}
