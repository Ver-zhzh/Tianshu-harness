import { parseDocument } from 'yaml'
import type { SkillRuntimeMetadata } from './runtime/declaration.js'

export type SkillMode = 'auto' | 'manual' | 'off'
export interface SkillMetadata {
  displayName?: string
  shortDescription?: string
  defaultPrompt?: string
  defaultMode: SkillMode
  dependencies: unknown[]
  unsupported: string[]
  /** Python 运行时声明（issue #523）：目录型技能根的 runtime.yaml 解析结果。
   *  解析失败不阻断加载，错误记录在 error 里由 doctor 展示。 */
  runtime?: SkillRuntimeMetadata
}

export function parseSkillYaml(raw: string): Record<string, unknown> {
  const document = parseDocument(raw, { uniqueKeys: true })
  if (document.errors.length) throw new Error(document.errors.map(e => e.message).join('; '))
  const value: unknown = document.toJS({ maxAliasCount: 20 })
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Skill metadata must be a YAML mapping')
  return value as Record<string, unknown>
}

export function skillMetadata(frontmatter: Record<string, unknown>, openai?: Record<string, unknown>): SkillMetadata {
  const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const ui = object(openai?.interface)
  const policy = object(openai?.policy)
  const dependencies = object(openai?.dependencies)
  const string = (value: unknown) => typeof value === 'string' ? value : undefined
  return {
    displayName: string(ui.display_name), shortDescription: string(ui.short_description), defaultPrompt: string(ui.default_prompt),
    defaultMode: frontmatter['disable-model-invocation'] === true || policy.allow_implicit_invocation === false ? 'manual' : 'auto',
    dependencies: Array.isArray(dependencies.tools) ? dependencies.tools : [],
    unsupported: ['allowed-tools', 'context', 'agent', 'model', 'hooks', 'user-invocable'].filter(key => frontmatter[key] !== undefined),
  }
}
