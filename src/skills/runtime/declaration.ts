/**
 * 技能 Python 运行时声明（issue #523 WP1）。
 *
 * 目录型技能包根的 `runtime.yaml`（与 SKILL.md、scripts/ 同级）声明解释器
 * 约束与脚本入口。解析分两层：
 *  - parseRuntimeDeclaration：纯函数（YAML + 形状 + 包内路径的字符串级校验），
 *    不碰文件系统，直接可测。
 *  - checkRuntimeDeclarationPaths：文件系统级校验（存在性 + realpath 包内
 *     containment，符号链接逃逸在此被捕获）。
 * 解析失败不 throw——返回 { ok:false, errorCode:'invalid_declaration' }，由
 * 调用方记入 metadata 并在 doctor 展示，不阻断技能加载。
 */
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { parseDocument } from 'yaml'

export interface RuntimeEntryDeclaration {
  /** 包内 POSIX 相对路径的 .py 脚本。 */
  script: string
  timeoutSeconds?: number
}

export interface RuntimeDeclaration {
  version: 1
  python: {
    /** 逗号分隔的版本约束（>=,>,<=,<,==,!=），如 ">=3.10,<3.15"。缺省 = 不约束。 */
    requires?: string
    /** 包内依赖清单路径；缺省 = 仅标准库。 */
    requirements?: string
    entries: Record<string, RuntimeEntryDeclaration>
  }
}

/** 挂在 SkillMetadata.runtime 上的声明信息：合法声明或声明错误，二选一。 */
export interface SkillRuntimeMetadata {
  declaration?: RuntimeDeclaration
  error?: string
}

export type RuntimeDeclarationResult =
  | { ok: true; declaration: RuntimeDeclaration }
  | { ok: false; errorCode: 'invalid_declaration'; message: string }

const invalid = (message: string): RuntimeDeclarationResult => ({ ok: false, errorCode: 'invalid_declaration', message })

/**
 * 包内路径的字符串级校验：拒绝绝对路径、盘符、反斜杠、空段、`.`/`..`、
 * 控制字符与尾随 `.`/空格的段。与 skill-package.ts 的 validateResourcePath
 * 同一严格度，但保持纯函数以便脱离包读取单测（runtime/ 不反向依赖上层）。
 */
function isInPackagePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false
  if (value.includes('\\') || isAbsolute(value) || /^[a-zA-Z]:/.test(value)) return false
  return value.split('/').every(part =>
    !!part && part !== '.' && part !== '..' && !/[<>:"|?*\x00-\x1f]/.test(part) && !/[. ]$/.test(part)
  )
}

/** requirements.ts 的 -r/-c 递归引用复用同一纯校验（导出不改变行为）。 */
export { isInPackagePath }

export function parseRuntimeDeclaration(source: string): RuntimeDeclarationResult {
  const document = parseDocument(source, { uniqueKeys: true })
  if (document.errors.length) return invalid(document.errors.map(e => e.message).join('; '))
  const value: unknown = document.toJS({ maxAliasCount: 20 })
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('runtime.yaml must be a YAML mapping')
  const root = value as Record<string, unknown>
  if (root.version !== 1) return invalid(`未知声明版本: ${root.version === undefined ? '(missing)' : String(root.version)}（仅支持 version: 1）`)
  const python = root.python
  if (!python || typeof python !== 'object' || Array.isArray(python)) return invalid('runtime.yaml requires a python mapping')
  const py = python as Record<string, unknown>
  const declaration: RuntimeDeclaration = { version: 1, python: { entries: {} } }
  if (py.requires !== undefined) {
    if (typeof py.requires !== 'string' || !py.requires.trim()) return invalid('python.requires must be a non-empty version constraint string')
    declaration.python.requires = py.requires
  }
  if (py.requirements !== undefined) {
    if (!isInPackagePath(py.requirements)) return invalid(`python.requirements must stay inside the skill package: ${String(py.requirements)}`)
    declaration.python.requirements = py.requirements
  }
  if (!py.entries || typeof py.entries !== 'object' || Array.isArray(py.entries)) return invalid('python.entries must be a mapping with at least one entry')
  const entries = Object.entries(py.entries as Record<string, unknown>)
  if (entries.length === 0) return invalid('python.entries must declare at least one entry')
  for (const [name, raw] of entries) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid(`entry ${name}: must be a mapping`)
    const entry = raw as Record<string, unknown>
    if (!isInPackagePath(entry.script)) return invalid(`entry ${name}: script must stay inside the skill package: ${String(entry.script)}`)
    if (!entry.script.toLowerCase().endsWith('.py')) return invalid(`entry ${name}: script must be a .py file: ${entry.script}`)
    const declared: RuntimeEntryDeclaration = { script: entry.script }
    if (entry.timeoutSeconds !== undefined) {
      if (typeof entry.timeoutSeconds !== 'number' || !Number.isFinite(entry.timeoutSeconds) || entry.timeoutSeconds <= 0) {
        return invalid(`entry ${name}: timeoutSeconds must be a positive number`)
      }
      declared.timeoutSeconds = entry.timeoutSeconds
    }
    declaration.python.entries[name] = declared
  }
  return { ok: true, declaration }
}

/**
 * 文件系统级校验：声明引用的每个路径（requirements + 各 entry.script）必须
 * 存在，且 realpath 后仍留在包根内（符号链接逃逸在此被拒绝）。
 */
export function checkRuntimeDeclarationPaths(skillDir: string, declaration: RuntimeDeclaration): RuntimeDeclarationResult {
  let rootReal: string
  try {
    rootReal = realpathSync(skillDir)
  } catch {
    return invalid(`skill directory unreadable: ${skillDir}`)
  }
  const declared = [declaration.python.requirements, ...Object.values(declaration.python.entries).map(e => e.script)]
    .filter((p): p is string => p !== undefined)
  for (const path of declared) {
    let real: string
    try {
      real = realpathSync(resolve(skillDir, path))
    } catch {
      return invalid(`declared path not found: ${path}`)
    }
    if (real !== rootReal && !real.startsWith(rootReal + sep)) return invalid(`declared path escapes skill package: ${path}`)
  }
  return { ok: true, declaration }
}

/**
 * 加载层入口：目录型技能根存在 runtime.yaml 时读出并做两层校验。
 * 文件不存在返回 undefined（旧技能零变化）；读/解析/校验失败返回
 * { error }——不阻断技能加载，由 doctor 展示。
 */
export function readRuntimeDeclaration(skillDir: string): SkillRuntimeMetadata | undefined {
  let source: string
  try {
    source = readFileSync(join(skillDir, 'runtime.yaml'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    return { error: error instanceof Error ? error.message : String(error) }
  }
  const parsed = parseRuntimeDeclaration(source)
  if (!parsed.ok) return { error: parsed.message }
  const checked = checkRuntimeDeclarationPaths(skillDir, parsed.declaration)
  return checked.ok ? { declaration: checked.declaration } : { error: checked.message }
}
