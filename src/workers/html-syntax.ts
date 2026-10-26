import { parse as parseHTML } from 'parse5'
import { parse as parseJS } from 'acorn'

export interface HTMLSyntaxResult {
  warning: string | null
  fatal: string | null
  checked?: boolean
  html: { markup: 'valid' | 'invalid'; scripts: number; checkedScripts: number; excluded: Array<{ line: number; reason: string }> }
  symbols: string[]
}

const JS_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript', 'text/jscript', 'application/x-javascript', 'application/x-ecmascript', 'text/x-javascript', 'text/x-ecmascript', 'text/livescript', ...[0, 1, 2, 3, 4, 5].map(n => `text/javascript1.${n}`)])
const VOIDS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext'])

/** Pure parsing only. Never evaluate code, resolve imports or fetch script URLs. */
export function htmlSyntaxRaw(content: string): HTMLSyntaxResult {
  const result: HTMLSyntaxResult = { warning: null, fatal: null, html: { markup: 'valid', scripts: 0, checkedScripts: 0, excluded: [] }, symbols: [] }
  const tree = parseHTML(content, { sourceCodeLocationInfo: true })
  const masks: Array<[number, number]> = []
  let scriptError: string | null = null
  function visit(node: any, inert = false): void {
    const loc = node.sourceCodeLocation
    if (node.nodeName === '#comment' && loc) masks.push([loc.startOffset, loc.endOffset])
    if (RAW_TEXT.has(node.tagName) && loc?.startTag) {
      const start = loc.startTag.endOffset, end = loc.endTag?.startOffset ?? loc.endOffset
      masks.push([start, end])
      if (node.tagName === 'script') {
        result.html.scripts++
        const attrs = new Map<string, string>(node.attrs.map((a: any) => [a.name, a.value]))
        const rawType = (attrs.get('type') ?? '').trim().toLowerCase(), isModule = rawType === 'module'
        const type = rawType.split(';')[0]!.trim()
        if (inert || attrs.has('src') || !isModule && !JS_TYPES.has(type)) {
          result.html.excluded.push({ line: loc.startLine, reason: inert ? 'inert_template' : attrs.has('src') ? 'external_script_not_loaded' : `data_script:${type}` })
        } else {
          const body = content.slice(start, end)
          try {
            const ast = parseJS(body, { ecmaVersion: 'latest', sourceType: isModule ? 'module' : 'script', locations: true })
            result.html.checkedScripts++
            for (const n of ast.body as any[]) {
              const declaration = n.type.startsWith('Export') ? n.declaration : n
              if (declaration?.id?.name) result.symbols.push(declaration.id.name)
              for (const d of declaration?.declarations ?? []) if (d.id?.type === 'Identifier') result.symbols.push(d.id.name)
            }
          } catch (e) {
            const error = e as Error & { loc?: { line: number; column: number } }
            const line = loc.startTag.endLine + (error.loc?.line ?? 1) - 1
            const column = (error.loc?.column ?? 0) + ((error.loc?.line ?? 1) === 1 ? loc.startTag.endCol - 1 : 0) + 1
            scriptError ??= `HTML 内联 ${isModule ? 'module' : 'script'} 语法错误（${line}:${column}）：${error.message}`
          }
        }
      }
    }
    for (const child of node.childNodes ?? []) visit(child, inert)
    if (node.content) visit(node.content, true)
  }
  visit(tree)
  let masked = content
  for (const [start, end] of masks.sort((a, b) => b[0] - a[0])) masked = masked.slice(0, start) + content.slice(start, end).replace(/[^\r\n]/g, ' ') + masked.slice(end)
  const stack: string[] = []
  for (const match of masked.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*\/?>/g)) {
    const full = match[0], tag = match[1]!.toLowerCase()
    if (full.endsWith('/>') || VOIDS.has(tag)) continue
    if (full.startsWith('</')) {
      if (stack.pop() !== tag) { result.fatal = `HTML tag mismatch: unexpected </${tag}> at position ${match.index}`; break }
    } else stack.push(tag)
  }
  if (!result.fatal && stack.length) result.fatal = `HTML tag mismatch: ${stack.length} unclosed tag(s): ${stack.map(t => `<${t}>`).join(', ')}`
  if (result.fatal) result.html.markup = 'invalid'
  result.fatal ??= scriptError
  result.warning = result.fatal
  if (result.fatal) result.symbols = []
  return result
}
