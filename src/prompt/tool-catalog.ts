import type { ToolDefinition } from '../api/types.js'
import { stableStringify } from '../api/stable-json.js'
/** An explicit mount may append one tool, never replace an existing contract. */
export function appendExplicitTool(current: readonly ToolDefinition[], tool: ToolDefinition): ToolDefinition[] | undefined {
  const existing = current.find(definition => definition.name === tool.name)
  if (!existing) return [...current, tool]
  if (stableStringify(existing) !== stableStringify(tool)) throw new Error(`Explicit mount cannot replace published tool ${tool.name}`)
}
