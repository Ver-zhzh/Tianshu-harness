/**
 * @mention parser — extract @file:, @folder:, @symbol: references from user input.
 */
import { resolve as resolvePath, relative as relativePath, isAbsolute, sep } from 'node:path'

export interface MentionReference {
  type: 'file' | 'folder' | 'symbol' | 'codebase'
  value: string
  raw: string
}

// Quoted form `@file:"a b.ts"` carries paths with spaces (Windows: C:\Program
// Files\…); the bare `[^\s]+` form stays supported for everything else.
const MENTION_RE = /@(file|folder|symbol|codebase):(?:"([^"]+)"|([^\s]+))/g

export function parseMentions(input: string): MentionReference[] {
  const refs: MentionReference[] = []
  for (const match of input.matchAll(MENTION_RE)) {
    const type = match[1] as MentionReference['type']
    const value = (match[2] ?? match[3] ?? '').trim()
    refs.push({ type, value, raw: match[0]! })
  }
  return refs
}

export function stripMentions(input: string): string {
  return input.replace(MENTION_RE, '').replace(/\s+/g, ' ').trim()
}

/** 把 mention 路径规范为相对 cwd 的相对路径（cwd 外的保持原样，便于识别外部引用）。
 *  归一为正斜杠：Windows 的 relative() 产出反斜杠，会把平台分隔符泄漏进
 *  mentions context / 提交语义（跨平台期望是正斜杠路径）。 */
export function normalizeMentionPath(cwd: string, p: string): string {
  const abs = resolvePath(cwd, p)
  const rel = relativePath(cwd, abs)
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? p : rel.split(sep).join('/')
}

/** 批量规范化（turn-step-producer 组装 mentions context 时调用）。 */
export function normalizeMentionRefs(refs: MentionReference[], cwd: string): MentionReference[] {
  return refs.map(r => ({ ...r, value: normalizeMentionPath(cwd, r.value) }))
}

export function renderMentionContext(refs: MentionReference[]): string | null {
  if (refs.length === 0) return null

  const lines = ['<mentions>']
  for (const ref of refs) {
    // ref.value 源自用户原始输入（@file: 后缀），直接拼进 ref 属性可造成属性逃逸
    // （如 a" /><context-update …），伪造附录 markup。转义后再拼接。
    // ref.type 是字面量联合类型，作标签名安全，无需转义。
    lines.push(`  <${ref.type} ref="${escapeXml(ref.value)}" />`)
  }
  lines.push('</mentions>', '', 'Resolve these @mentions before proceeding. Use read_file/grep/semantic_search as needed.')
  return lines.join('\n')
}

/** XML 转义：与 src/prompt/volatile.ts 的 escapeXml 同契约（含属性引号）。 */
function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
