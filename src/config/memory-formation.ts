import { loadConfig, saveConfig } from './manager.js'
import { MEMORY_FORMATION_ENV, memoryFormationOverride, resolveMemoryFormation, type MemoryFormationConfig } from '../memory/formation-policy.js'

export interface MemoryFormationSnapshot {
  configured: MemoryFormationConfig
  effective: MemoryFormationConfig
  overrides: Record<keyof MemoryFormationConfig, boolean | null>
  effectiveAfter: 'new-session'
}

function snapshot(configured: MemoryFormationConfig): MemoryFormationSnapshot {
  return {
    configured,
    effective: resolveMemoryFormation(configured),
    overrides: {
      autoCapture: memoryFormationOverride(process.env[MEMORY_FORMATION_ENV.autoCapture]),
      consolidation: memoryFormationOverride(process.env[MEMORY_FORMATION_ENV.consolidation]),
    },
    effectiveAfter: 'new-session',
  }
}

export function getMemoryFormationConfig(): MemoryFormationSnapshot {
  return snapshot(loadConfig({ skipProfileOverlay: true }).agent.memoryFormation)
}

export function setMemoryFormationConfig(input: unknown): MemoryFormationSnapshot {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Expected memory formation settings')
  const patch = input as Record<string, unknown>
  const keys = Object.keys(patch)
  if (keys.length === 0 || keys.some(key => !Object.hasOwn(MEMORY_FORMATION_ENV, key) || typeof patch[key] !== 'boolean')) {
    throw new TypeError('Provide autoCapture and/or consolidation as booleans')
  }
  const cfg = loadConfig({ skipProfileOverlay: true })
  cfg.agent.memoryFormation = { ...cfg.agent.memoryFormation, ...patch } as MemoryFormationConfig
  saveConfig(cfg)
  return snapshot(cfg.agent.memoryFormation)
}
