/** Shared values only: safe in config schemas without importing the config manager. */
export const TOOL_PRESET_NAMES = ['minimal', 'frontend', 'orchestration', 'full', 'taiyi'] as const
export type ToolPreset = typeof TOOL_PRESET_NAMES[number]
