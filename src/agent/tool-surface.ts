import type { ToolRegistry } from '../tools/registry.js'
import type { ToolDefinition } from '../api/types.js'
import { ALL_KNOWN_TOOLS, toolMountRestriction, type ToolGatingState } from './tool-tiers.js'
import type { ToolSurfaceSnapshot } from '../server/protocol.js'
export type { ToolSurfaceSnapshot } from '../server/protocol.js'
export function describeToolSurface(registry: ToolRegistry, activeDefs: readonly ToolDefinition[], gating?: ToolGatingState): ToolSurfaceSnapshot {
  const registered = new Set(registry.getAllNames()), available = new Set(registry.getDefinitions().map(d => d.name)), active = new Set(activeDefs.map(d => d.name))
  const tools = [...new Set([...ALL_KNOWN_TOOLS, ...registered, ...active])].sort().map(name => {
    const restriction = gating && toolMountRestriction(name, gating)
    const state = restriction ?? (active.has(name) ? 'visible' : !registered.has(name) ? 'unregistered' : !available.has(name) ? 'unavailable' : 'cold')
    return { name, state } as ToolSurfaceSnapshot['tools'][number]
  })
  const definitions = JSON.stringify(activeDefs)
  return { preset: registry.preset ?? gating?.preset ?? 'unknown', registeredCount: registered.size, visibleCount: active.size,
    definitionChars: definitions.length, definitionBytes: Buffer.byteLength(definitions), tools }
}
