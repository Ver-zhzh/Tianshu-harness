/**
 * requirements.txt 解析与审核（issue #523 WP2）。
 *
 * 技能包带来的 requirements 是**不受信输入**：只允许「包名 + 版本约束 +
 * extras + 环境标记 + 哈希」与包内 -r/-c 递归引用；拒绝一切会改变解析
 * 语义或引入未审计来源的形态（editable / 本地路径 / VCS / 直接 URL /
 * 包内 index-url 族——包源只能来自用户应用配置 mirrors.pypi）。
 *
 * 失效方向：漏放只会让某类声明被误拒（作者可改写为允许形态），误放则让
 * 包把依赖解析指向攻击者控制的源——故白名单制，未知选项一律拒绝。
 *
 * 违规报错带 1-based 行号与替代写法建议。
 */
import { realpathSync, readFileSync } from 'node:fs'
import { resolve, sep, dirname, relative, posix } from 'node:path'
import { isInPackagePath } from './declaration.js'
import type { RuntimeErrorCode } from './run-contract.js'

export interface AuditedRequirement {
  name: string
  extras: string[]
  /** 裸版本约束文本（如 ">=1.0,<2"）；缺省 = 未约束。 */
  constraint?: string
  /** PEP 508 环境标记原文（如 `python_version < "3.12"`）。 */
  marker?: string
  /** 钉死哈希（'sha256:<hex>' 等）。 */
  hashes: string[]
  /** 无 ==/=== 精确钉死 → 重新准备时解析结果可能变化（报告里标注）。 */
  unpinned: boolean
  /** 来源（引入它的文件 + 1-based 行号）。 */
  origin: { file: string; line: number }
}

export interface AuditedRequirements {
  requirements: AuditedRequirement[]
  /** -c 约束文件的钉死表：name → 约束文本（约束不生成安装项）。 */
  constraints: Record<string, string>
  /** 命中的约束文件（包内相对路径，供报告）。 */
  constraintFiles: string[]
  /** 命中的全部引用文件（含 -r，包内相对路径）。 */
  includedFiles: string[]
  /** 根文件的确定性渲染；files 保留实际 pip 引用图，-c 不降为安装项或注释。 */
  normalized: string
  rootFile: string
  files: Record<string, string>
}

export type RequirementsAuditResult =
  | { ok: true; audited: AuditedRequirements }
  | { ok: false; errorCode: Extract<RuntimeErrorCode, 'invalid_requirements'>; message: string }

const fail = (message: string): RequirementsAuditResult => ({ ok: false, errorCode: 'invalid_requirements', message })

/** 递归护栏：深度与引用文件数上限（防 -r 炸弹）。 */
const MAX_INCLUDE_DEPTH = 4
const MAX_INCLUDE_FILES = 8

/** PEP 508 包名。 */
const NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/
/** 版本约束允许的字符（逗号分隔的 ~=,==,>=,<=,!=,>,<,=== 与版本号/通配）。 */
const CONSTRAINT_RE = /^(?:\s*(?:~=|===|==|!=|>=|<=|>|<)\s*[A-Za-z0-9.*+!]+\s*,?)+\s*$/
const HASH_RE = /^--hash=(sha256|sha384|sha512):[0-9a-fA-F]+$/

interface LogicalLine { text: string; line: number }

/** 物理行 → 逻辑行（`\` 续行合并），行号取逻辑行首行；剥离行内注释。 */
function logicalLines(source: string): LogicalLine[] {
  const out: LogicalLine[] = []
  let buffer = ''
  let startLine = 0
  const physical = source.replace(/\r\n/g, '\n').split('\n')
  physical.forEach((raw, index) => {
    const lineNo = index + 1
    const line = raw.trimEnd()
    if (!buffer) startLine = lineNo
    if (line.endsWith('\\')) {
      buffer += line.slice(0, -1) + ' '
      return
    }
    buffer += line
    // 行内注释：空白后的 # 起（pip 同规则）；行首 # 由调用侧跳过。
    const text = buffer.replace(/\s+#.*$/, '').trim()
    buffer = ''
    out.push({ text, line: startLine })
  })
  if (buffer.trim()) out.push({ text: buffer.replace(/\s+#.*$/, '').trim(), line: startLine })
  return out
}

const MARKER_NAMES = new Set(['python_version', 'python_full_version', 'os_name', 'sys_platform', 'platform_release', 'platform_system', 'platform_version', 'platform_machine', 'platform_python_implementation', 'implementation_name', 'implementation_version', 'extra'])
function validMarker(source: string): boolean {
  const tokens: string[] = []
  let rest = source.trim()
  while (rest) {
    const match = rest.match(/^(===|==|!=|<=|>=|~=|<|>|\(|\)|'[^']*'|"[^"]*"|[A-Za-z_][A-Za-z0-9_]*)/)
    if (!match || tokens.length >= 256) return false
    tokens.push(match[0]); rest = rest.slice(match[0].length).trimStart()
  }
  let index = 0, depth = 0
  const atom = () => { const value = tokens[index++]; return !!value && (value.startsWith('"') || value.startsWith("'") || MARKER_NAMES.has(value)) }
  const factor = (): boolean => {
    if (++depth > 32) return false
    let ok: boolean
    if (tokens[index] === '(') { index++; ok = expression() && tokens[index++] === ')' }
    else {
      if (!atom()) return false
      const op = tokens[index++]
      if (op === 'not') { if (tokens[index++] !== 'in') return false }
      else if (!['===', '==', '!=', '<=', '>=', '~=', '<', '>', 'in'].includes(op ?? '')) return false
      ok = atom()
    }
    depth--; return ok
  }
  const term = (): boolean => { if (!factor()) return false; while (tokens[index] === 'and') { index++; if (!factor()) return false } return true }
  const expression = (): boolean => { if (!term()) return false; while (tokens[index] === 'or') { index++; if (!term()) return false } return true }
  return expression() && index === tokens.length
}

/** 解析单条 requirement 行（选项与注释已剥离）；同行 --hash= 一并提取校验。 */
function parseRequirementLine(text: string, file: string, line: number): AuditedRequirement | RequirementsAuditResult {
  // 同行哈希：pkg==1.0 --hash=sha256:…（续行形态由调用侧处理）。
  const hashes: string[] = []
  text = text.replace(/\s+--hash=(\S+)/g, (_all, hash: string) => {
    hashes.push(hash)
    return ''
  })
  for (const hash of hashes) {
    if (!/^(sha256|sha384|sha512):[0-9a-fA-F]+$/.test(hash)) {
      return fail(`第 ${line} 行（${file}）：非法哈希 "--hash=${hash}"（支持 sha256/sha384/sha512）。`)
    }
  }
  // 直接引用（pkg @ url/path）一律拒绝。
  const directRef = text.match(/^(\S+)\s*@\s*(\S+).*$/)
  if (directRef) {
    return fail(`第 ${line} 行（${file}）：不允许直接引用 "${directRef[2]}"（本地路径/VCS/URL）。改用包名+版本约束从索引安装，如 "${directRef[1]}==1.0"。`)
  }
  const markerSplit = text.split(';')
  const marker = markerSplit.length > 1 ? markerSplit.slice(1).join(';').trim() : undefined
  const head = markerSplit[0]!.trim()
  if (head.includes('/') || head.includes('\\')) {
    return fail(`第 ${line} 行（${file}）：不允许本地路径依赖 "${head}"。改用包名+版本约束从索引安装。`)
  }
  const nameMatch = head.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(.*)$/)
  if (!nameMatch || !NAME_RE.test(nameMatch[1]!)) {
    return fail(`第 ${line} 行（${file}）：无法解析为包名约束 "${text}"。本地目录路径不允许；改用包名+版本约束从索引安装。`)
  }
  const name = nameMatch[1]!
  const extras = nameMatch[2]
    ? nameMatch[2].slice(1, -1).split(',').map(e => e.trim()).filter(Boolean)
    : []
  for (const extra of extras) {
    if (!NAME_RE.test(extra)) return fail(`第 ${line} 行（${file}）：非法 extra "${extra}"。`)
  }
  const constraint = (nameMatch[3] ?? '').trim()
  if (constraint && !CONSTRAINT_RE.test(constraint)) {
    return fail(`第 ${line} 行（${file}）：无法解析的版本约束 "${constraint}"。支持 ~=,==,===,!=,>=,<=,>,< 逗号组合。`)
  }
  if (marker !== undefined && !marker) return fail(`第 ${line} 行（${file}）：环境标记为空。`)
  if (marker && !validMarker(marker)) return fail(`第 ${line} 行（${file}）：环境标记非法或含不支持的选项。`)
  return {
    name,
    extras,
    ...(constraint ? { constraint } : {}),
    ...(marker ? { marker } : {}),
    hashes,
    unpinned: !constraint.split(',').some(part => /^\s*={2,3}[^*]+$/.test(part)),
    origin: { file, line },
  }
}

interface ParseState {
  requirements: AuditedRequirement[]
  constraints: Record<string, string>
  constraintFiles: string[]
  includedFiles: string[]
  filesRead: number
  files: Record<string, string>
  sourceFiles?: Record<string, string>
}

/**
 * 单个文件的递归解析。mode='install' 的安装项进 requirements；'constraint'
 * （-c 文件）只进 constraints 表、不生成安装项、不接受 -r/哈希。
 */
function parseFile(
  source: string,
  fileLabel: string,
  packageRoot: string,
  state: ParseState,
  depth: number,
  mode: 'install' | 'constraint',
  filePath = 'requirements.txt',
): RequirementsAuditResult | undefined {
  if (depth > MAX_INCLUDE_DEPTH) return fail(`-r/-c 递归深度超过上限 ${MAX_INCLUDE_DEPTH}（${fileLabel}）。`)
  let current: AuditedRequirement | undefined
  const output: string[] = []
  let currentIndex = -1
  for (const { text, line } of logicalLines(source)) {
    if (!text || text.startsWith('#')) continue

    // -r / -c 递归引用（`-r path` / `-rpath` / `--requirement=path` 形态）。
    const include = text.match(/^-(r|c)[=\s](\S+)$/) ?? text.match(/^-(r|c)(\S+)$/)
      ?? text.match(/^--(requirement|constraint)[=\s](\S+)$/)
    if (include) {
      const kind = include[1] ?? include[3]!
      const target = include[2] ?? include[4]!
      const nestedMode = (kind === 'c' || kind === 'constraint') ? 'constraint' : 'install'
      if (mode === 'constraint' && nestedMode === 'install') {
        return fail(`第 ${line} 行（${fileLabel}）：约束文件（-c）里不允许 -r 安装项引用。`)
      }
      const nestedPath = relative(packageRoot, resolve(packageRoot, dirname(filePath), target)).split(sep).join('/')
      if (!isInPackagePath(nestedPath) || /^(?:[\\/]|[A-Za-z]:)/.test(target)) return fail(`第 ${line} 行（${fileLabel}）：-${kind} 引用 "${target}" 越出技能包。改为包内相对路径。`)
      if (++state.filesRead > MAX_INCLUDE_FILES) return fail(`-r/-c 引用文件数超过上限 ${MAX_INCLUDE_FILES}。`)
      let content: string
      try {
        if (state.sourceFiles) {
          if (!(nestedPath in state.sourceFiles)) throw new Error('missing')
          content = state.sourceFiles[nestedPath]!
        } else {
        const real = realpathSync(resolve(packageRoot, nestedPath))
        const rootReal = realpathSync(packageRoot)
        if (real !== rootReal && !real.startsWith(rootReal + sep)) {
          return fail(`第 ${line} 行（${fileLabel}）：-${kind} 引用 "${target}" 经符号链接越出技能包。`)
        }
        content = readFileSync(real, 'utf8')
        }
      } catch {
        return fail(`第 ${line} 行（${fileLabel}）：-${kind} 引用 "${target}" 不存在或不可读。`)
      }
      state.includedFiles.push(nestedPath)
      if (nestedMode === 'constraint') state.constraintFiles.push(nestedPath)
      const nested = parseFile(content, nestedPath, packageRoot, state, depth + 1, nestedMode, nestedPath)
      if (nested) return nested
      output.push(`-${nestedMode === 'constraint' ? 'c' : 'r'} ${posix.relative(posix.dirname(filePath), nestedPath)}`)
      current = undefined
      continue
    }

    // 索引源/宿主信任选项：包源只能来自用户应用配置（mirrors.pypi）。
    const indexOpt = text.match(/^--(index-url|extra-index-url|trusted-host)[=\s]/)
    if (indexOpt) {
      return fail(`第 ${line} 行（${fileLabel}）：不允许包内 --${indexOpt[1]}——包源只能来自用户应用配置（mirrors.pypi）。`)
    }
    // editable / 本地路径 / VCS / URL。
    if (/^--?e(?:ditable)?(?:[=\s]|$)/.test(text)) {
      return fail(`第 ${line} 行（${fileLabel}）：不允许 editable 安装（-e/--editable）。改用包名+版本约束从索引安装。`)
    }
    if (/^(?:\.\.?[\/]|[\/~]|[A-Za-z]:[\/\\])/.test(text) || /^(?:git|hg|svn|bzr)\+/.test(text) || /^https?:\/\//.test(text) || /^file:/.test(text)) {
      return fail(`第 ${line} 行（${fileLabel}）：不允许本地路径/VCS/URL 依赖 "${text}"。改用包名+版本约束从索引安装。`)
    }
    // 哈希：附着于上一条安装项。
    if (text.startsWith('--hash=')) {
      if (!HASH_RE.test(text)) return fail(`第 ${line} 行（${fileLabel}）：非法哈希 "${text}"（支持 sha256/sha384/sha512）。`)
      if (!current) return fail(`第 ${line} 行（${fileLabel}）：--hash 必须跟随一条 requirement。`)
      current.hashes.push(text.slice('--hash='.length))
      output[currentIndex] += ` ${text}`
      continue
    }
    // 其余选项一律拒绝（白名单制）。
    if (text.startsWith('-')) {
      return fail(`第 ${line} 行（${fileLabel}）：不支持的选项 "${text.split(/\s/)[0]}"。requirements 仅允许包名约束、extras、环境标记、--hash 与包内 -r/-c。`)
    }

    const parsed = parseRequirementLine(text, fileLabel, line)
    if ('ok' in parsed) return parsed
    if (mode === 'constraint') {
      state.constraints[parsed.name] = [state.constraints[parsed.name], parsed.constraint].filter(Boolean).join(',')
    } else {
      state.requirements.push(parsed)
      current = parsed
    }
    currentIndex = output.length
    output.push(renderRequirement(parsed))
  }
  state.files[filePath] = output.join('\n') + '\n'
  return undefined
}

function renderRequirement(req: AuditedRequirement): string {
  const extras = req.extras.length ? `[${req.extras.join(',')}]` : ''
  const marker = req.marker ? ` ; ${req.marker}` : ''
  return `${req.name}${extras}${req.constraint ?? ''}${marker}${req.hashes.map(hash => ` --hash=${hash}`).join('')}`
}

/**
 * 审核 requirements 文本。`packageRoot` 提供时支持包内 -r/-c 递归
 * （realpath 校验防符号链接逃逸）；缺省时 -r/-c 一律报错。
 */
export function auditRequirements(source: string, options: { packageRoot?: string; requirementsFile?: string; files?: Record<string, string> } = {}): RequirementsAuditResult {
  if (!options.packageRoot && /^-(r|c)[=\s]?|--(?:requirement|constraint)[=\s]/m.test(source)) {
    return fail('requirements 含 -r/-c 引用，但未提供包根用于解析（仅目录型技能包支持）。')
  }
  const state: ParseState = { requirements: [], constraints: {}, constraintFiles: [], includedFiles: [], filesRead: 0, files: {}, sourceFiles: options.files }
  const rootFile = options.requirementsFile ?? 'requirements.txt'
  if (!isInPackagePath(rootFile)) return fail('requirements 根文件越出技能包')
  const error = parseFile(source, '<requirements>', options.packageRoot ?? '', state, 0, 'install', rootFile)
  if (error) return error
  return { ok: true, audited: { ...state, rootFile, normalized: state.files[rootFile]!, files: state.files } }
}
