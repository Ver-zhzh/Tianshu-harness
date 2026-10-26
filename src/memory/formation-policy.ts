export interface MemoryFormationConfig {
  autoCapture: boolean
  consolidation: boolean
}

export const MEMORY_FORMATION_ENV = {
  autoCapture: 'RIVET_MEMORY_AUTO_CAPTURE',
  consolidation: 'RIVET_MEMORY_CONSOLIDATION',
} as const

/** Unknown non-empty values close the gate; only an explicit opt-in enables it. */
export function memoryFormationOverride(value: string | undefined): boolean | null {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return null
  return normalized === '1' || normalized === 'on' || normalized === 'true'
}

export function memoryFormationEnabled(value: string | undefined, configured = false): boolean {
  return memoryFormationOverride(value) ?? configured
}

export function resolveMemoryFormation(config?: Partial<MemoryFormationConfig>, env = process.env): MemoryFormationConfig {
  return {
    autoCapture: memoryFormationEnabled(env[MEMORY_FORMATION_ENV.autoCapture], config?.autoCapture === true),
    consolidation: memoryFormationEnabled(env[MEMORY_FORMATION_ENV.consolidation], config?.consolidation === true),
  }
}
