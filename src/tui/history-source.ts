import { closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync, type Stats } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { createHash } from 'node:crypto'

export const SENSITIVE_HISTORY_KEY = /^(?:apikey|authorization|password|passwd|pwd|token|accesstoken|refreshtoken|idtoken|clientsecret|secret|privatekey|credentials?|oauth.*)$/i
const SOURCE_PAGE = 16_384
const UNAVAILABLE = '全文不可用；已脱敏预览仍可阅读'
const PREPARING = '全文准备中；查看详情或搜索以读取安全全文'
const RESTRICTED = '全文受限：JSON 结构或键长度无法可靠脱敏；已脱敏预览仍可阅读'
let folder: string | undefined, sequence = 0
function outputPath(): string {
  if (!folder) {
    const root = process.env.RIVET_HOME || tmpdir()
    mkdirSync(root, { recursive: true })
    folder = mkdtempSync(join(root, 'tianshu-ui-history-'))
    const owned = folder
    process.once('exit', () => { try { rmSync(owned, { recursive: true, force: true }) } catch { /* OS cleanup can remove a locked temporary file later. */ } })
  }
  return join(folder, `${++sequence}.txt`)
}
function signature(s: Stats): string { return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}` }
function safePath(original: string, snapshot: Stats): string {
  if (!folder) outputPath()
  return join(folder!, createHash('sha256').update(original + '\0' + signature(snapshot)).digest('hex') + '.txt')
}
export interface SafeHistorySource { path: string; original: string; snapshot: Stats; size: number; restricted?: boolean }
const sources = new Map<string, SafeHistorySource>()
// Published paths remain addressable for the process lifetime; this index holds metadata, never payloads.
const publishedSources = new Map<string, SafeHistorySource>()
const pending = new Map<string, string>()
class RestrictedSource extends Error {}

/** Sensitive values are skipped to their actual terminator, even over arbitrarily many pages. */
class TextRedactor {
  private pending = ''
  private skip = ''
  private expect: 'separator' | 'value' | '' = ''
  private escaped = false
  private word = ''
  write(text: string, final = false): string {
    this.pending += text
    let output = '', at = 0
    while (at < this.pending.length) {
      const ch = this.pending[at]!
      if (this.expect) {
        if (/\s/.test(ch)) { output += ch; at++; continue }
        if (this.expect === 'separator') {
          if (ch === '\\' && at + 1 === this.pending.length && !final) break
          if (ch === '\\' && (this.pending[at + 1] === '"' || this.pending[at + 1] === "'")) { output += '\\' + this.pending[at + 1]; at += 2; continue }
          this.expect = ''
          if (ch === ':' || ch === '=') { output += ch; this.expect = 'value'; at++ }
          continue
        }
        this.expect = ''
        if (ch === '\\' && at + 1 === this.pending.length && !final) { this.expect = 'value'; break }
        if (ch === '\\' && (this.pending[at + 1] === '"' || this.pending[at + 1] === "'")) {
          output += '\\' + this.pending[at + 1] + '***'; this.skip = 'encoded' + this.pending[at + 1]; at += 2; continue
        }
        if (ch === '"' || ch === "'") { output += ch + '***'; this.skip = ch; at++ }
        else { output += '***'; this.skip = 'bare'; this.word = '' }
        continue
      }
      if (this.skip) {
        if (this.skip.startsWith('encoded')) {
          if (ch === '\\' && at + 1 === this.pending.length && !final) break
          if (ch === '\\' && this.pending[at + 1] === this.skip.at(-1)) { output += '\\' + this.pending[at + 1]; this.skip = ''; at += 2; continue }
          if (ch === '\\' && this.pending[at + 1] === '\\') { at += 2; continue }
        } else if (this.skip === 'leading-bare') {
          if (/\s/.test(ch)) { at++; continue }
          this.skip = 'bare'; this.word = ''; continue
        } else if (this.skip === 'data') {
          if (/[\s"'<>\])]/.test(ch)) { this.skip = ''; continue }
        } else if (this.skip === 'bare') {
          if (/\s|[,;"'}&\]]/.test(ch)) {
            if (/\s/.test(ch) && this.word.toLowerCase() === 'bearer') { this.skip = 'leading-bare'; at++; continue }
            this.skip = ''; continue
          }
          if (this.word.length <= 6) this.word += ch
        } else if (this.escaped) this.escaped = false
        else if (ch === '\\') this.escaped = true
        else if (ch === this.skip) { output += ch; this.skip = '' }
        at++; continue
      }
      // This bounded delay identifies a key/prefix; the value itself never uses a fixed lookbehind.
      if (!final && this.pending.length - at < 256) break
      const rest = this.pending.slice(at, at + 256)
      const key = /^(?:api[_-]?key|authorization|password|passwd|pwd|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|private[_-]?key|credentials?|secret|token|oauth[\w-]{0,64})["']?/i.exec(rest)
      if (key) {
        output += key[0]
        at += key[0].length
        this.expect = 'separator'
        continue
      }
      const bearer = /^Bearer(?=\s)/i.exec(rest)
      const token = /^(?:sk|rk|ghp|github_pat)[_-](?=[\w-]{8})/i.exec(rest)
      const data = /^data:/i.exec(rest)
      if (bearer || token || data) {
        const prefix = bearer?.[0] ?? token?.[0] ?? data![0]
        output += bearer ? 'Bearer ***' : data ? 'data:[redacted]' : '***'
        at += prefix.length
        this.skip = data ? 'data' : bearer ? 'leading-bare' : 'bare'; this.word = ''
        continue
      }
      const code = ch.charCodeAt(0), next = this.pending.charCodeAt(at + 1)
      if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) { output += this.pending.slice(at, at + 2); at += 2 }
      else { output += ch; at++ }
    }
    this.pending = this.pending.slice(at)
    return output
  }
}

type Frame = { object: boolean; phase: 'key' | 'colon' | 'value' | 'comma'; sensitive: boolean }
/** A bounded JSON lexer removes entire sensitive values, including nested objects and arrays. */
class JsonRedactor {
  private stack: Frame[] = []
  private rootDone = false
  private string: 'key' | 'value' | '' = ''
  private key = ''
  private escaped = false
  private primitive = false
  private skipping = false
  private skipDepth = 0
  private skipQuote = false
  private skipStarted = false
  private finishValue(): void {
    const parent = this.stack.at(-1)
    if (parent) parent.phase = 'comma'
    else this.rootDone = true
  }
  write(text: string, final: boolean): string {
    let output = ''
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!
      if (this.skipping) {
        if (!this.skipStarted) {
          if (/\s/.test(ch)) continue
          this.skipStarted = true
          if (ch === '"') this.skipQuote = true
          else if (ch === '{' || ch === '[') this.skipDepth = 1
          else { this.primitive = true; i-- }
          continue
        }
        if (this.skipQuote) {
          if (this.escaped) this.escaped = false
          else if (ch === '\\') this.escaped = true
          else if (ch === '"') { this.skipQuote = false; if (!this.skipDepth) { this.skipping = false; this.finishValue() } }
        } else if (this.primitive) {
          if (/\s|[,}\]]/.test(ch)) { this.primitive = false; this.skipping = false; this.finishValue(); i-- }
        } else if (ch === '"') this.skipQuote = true
        else if (ch === '{' || ch === '[') this.skipDepth++
        else if (ch === '}' || ch === ']') { if (--this.skipDepth === 0) { this.skipping = false; this.finishValue() } }
        continue
      }
      if (this.string) {
        output += ch
        if (this.string === 'key') { this.key += ch; if (this.key.length > 512) throw new RestrictedSource() }
        if (this.escaped) this.escaped = false
        else if (ch === '\\') this.escaped = true
        else if (ch === '"') {
          if (this.string === 'key') {
            const frame = this.stack.at(-1)!
            let key: string
            try { key = JSON.parse(this.key) as string } catch { throw new RestrictedSource() }
            frame.sensitive = SENSITIVE_HISTORY_KEY.test(key.replace(/[^a-z0-9]/gi, ''))
            frame.phase = 'colon'
            this.key = ''
          } else this.finishValue()
          this.string = ''
        }
        continue
      }
      if (this.primitive) {
        if (/\s|[,}\]]/.test(ch)) { this.primitive = false; this.finishValue(); i-- }
        else output += ch
        continue
      }
      if (/\s/.test(ch)) { output += ch; continue }
      const frame = this.stack.at(-1)
      if (frame?.phase === 'key') {
        if (ch === '"') { this.string = 'key'; this.key = '"'; output += ch; continue }
        if (ch !== '}') throw new RestrictedSource()
      } else if (frame?.phase === 'colon') {
        if (ch !== ':') throw new RestrictedSource()
        frame.phase = 'value'; output += ch; continue
      } else if (frame?.phase === 'comma') {
        if (ch === ',') { frame.phase = frame.object ? 'key' : 'value'; frame.sensitive = false; output += ch; continue }
        if (ch !== (frame.object ? '}' : ']')) throw new RestrictedSource()
      }
      if (frame?.phase === 'value' && frame.sensitive) {
        this.skipping = true; this.skipStarted = false; this.skipDepth = 0; this.skipQuote = false
        output += '"***"'; i--; continue
      }
      if (ch === '}' || ch === ']') {
        if (!frame || ch !== (frame.object ? '}' : ']')) throw new RestrictedSource()
        this.stack.pop(); this.finishValue(); output += ch
      } else if (ch === '{' || ch === '[') {
        if (this.stack.length >= 128) throw new RestrictedSource()
        this.rootDone = false
        this.stack.push({ object: ch === '{', phase: ch === '{' ? 'key' : 'value', sensitive: false }); output += ch
      } else if (ch === '"') { this.string = 'value'; output += ch }
      else {
        if (this.rootDone || !/[\d\-tfn]/.test(ch)) throw new RestrictedSource()
        this.primitive = true; output += ch
      }
    }
    if (final) {
      if (this.primitive && !this.skipping) { this.primitive = false; this.finishValue() }
      if (this.stack.length || this.string || this.skipping) throw new RestrictedSource()
    }
    return output
  }
}

class SourceRedactor {
  private json: JsonRedactor | undefined
  private decided = false
  private controls = ''
  private plain = new TextRedactor()
  write(text: string, final = false): string {
    let clean = ''
    for (const ch of text) {
      if (this.controls) {
        if (this.controls === 'esc') this.controls = ch === '[' ? 'csi' : ch === ']' ? 'osc' : ''
        else if (this.controls === 'csi') { if (ch >= '@' && ch <= '~') this.controls = '' }
        else if (this.controls === 'osc-esc') this.controls = ch === '\\' ? '' : 'osc'
        else if (ch === '\x07') this.controls = ''
        else if (ch === '\x1b') this.controls = 'osc-esc'
        continue
      }
      if (ch === '\x1b') { this.controls = 'esc'; continue }
      const code = ch.charCodeAt(0)
      if ((code < 32 && ch !== '\n' && ch !== '\t') || (code >= 127 && code <= 159)) continue
      clean += ch
    }
    if (!this.decided && /\S/.test(clean)) { this.decided = true; if (/^\s*[[{]/.test(clean)) this.json = new JsonRedactor() }
    return this.plain.write(this.json ? this.json.write(clean, final) : clean, final)
  }
}

function assertSnapshot(source: SafeHistorySource): void {
  const current = statSync(source.original), old = source.snapshot
  if (!current.isFile() || current.dev !== old.dev || current.ino !== old.ino || current.size < old.size || (current.size === old.size && signature(current) !== signature(old))) throw new Error('全文来源已变化或不可用')
}

function* deriveSource(path: string): Generator<void, SafeHistorySource> {
  const original = resolve(path), snapshot = statSync(original)
  if (!snapshot.isFile()) throw new Error('全文来源不是文件')
  const cached = sources.get(original)
  if (cached && signature(cached.snapshot) === signature(snapshot) && existsSync(cached.path)) { sources.delete(original); sources.set(original, cached); return cached }
  const safe: SafeHistorySource = { original, snapshot, path: safePath(original, snapshot), size: 0 }
  if (existsSync(safe.path + '.ready') && existsSync(safe.path)) {
    safe.size = statSync(safe.path).size
    safe.restricted = existsSync(safe.path + '.restricted')
    sources.set(original, safe)
    publishedSources.set(resolve(safe.path), safe)
    while (sources.size > 32) sources.delete(sources.keys().next().value!)
    return safe
  }
  const partial = outputPath() + '.partial'
  const output = openSync(partial, 'wx', 0o600)
  let input: number | undefined, outputOpen = true
  const buffer = Buffer.alloc(SOURCE_PAGE), decoder = new StringDecoder('utf8'), redactor = new SourceRedactor()
  let published = false
  try {
    input = openSync(original, 'r')
    for (let offset = 0; offset < snapshot.size;) {
      const n = readSync(input, buffer, 0, Math.min(buffer.length, snapshot.size - offset), offset)
      if (!n) throw new Error('全文来源读取不完整')
      const clean = redactor.write(decoder.write(buffer.subarray(0, n)))
      if (clean) writeSync(output, clean)
      offset += n
      assertSnapshot(safe)
      yield
    }
    writeSync(output, redactor.write(decoder.end(), true))
    closeSync(output)
    outputOpen = false
    renameSync(partial, safe.path)
    published = true
  } catch (error) {
    if (!(error instanceof RestrictedSource)) throw error
    if (outputOpen) { closeSync(output); outputOpen = false }
    unlinkSync(partial)
    writeFileSync(safe.path, RESTRICTED, { encoding: 'utf8', mode: 0o600 })
    safe.restricted = true
    published = true
  } finally {
    if (input !== undefined) closeSync(input)
    if (!published) { if (outputOpen) closeSync(output); if (existsSync(partial)) unlinkSync(partial) }
  }
  safe.size = statSync(safe.path).size
  if (safe.restricted) writeFileSync(safe.path + '.restricted', '', { mode: 0o600 })
  writeFileSync(safe.path + '.ready', '', { mode: 0o600 })
  sources.set(original, safe)
  publishedSources.set(resolve(safe.path), safe)
  pending.delete(original)
  while (sources.size > 32) sources.delete(sources.keys().next().value!)
  return safe
}

export function prepareHistorySource(path: string): SafeHistorySource {
  const scan = deriveSource(path)
  for (;;) { const next = scan.next(); if (next.done) return next.value }
}
export async function prepareHistorySourceAsync(path: string, signal?: AbortSignal): Promise<SafeHistorySource> {
  const scan = deriveSource(path)
  try {
    for (;;) {
      if (signal?.aborted) throw new Error('搜索已取消')
      const next = scan.next()
      if (next.done) return next.value
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  } finally { scan.return(undefined as never) }
}
/** A result callback may expose this safe placeholder without synchronously scanning the artifact. */
export function declareHistorySource(path: string): string {
  const original = resolve(path), known = sources.get(original)
  let available = false, output: string | undefined
  try {
    const snapshot = statSync(original)
    available = snapshot.isFile()
    if (known && available && signature(snapshot) === signature(known.snapshot) && existsSync(known.path)) return known.path
    if (available) {
      output = safePath(original, snapshot)
      if (existsSync(output + '.ready') && existsSync(output)) return output
    }
  } catch { /* Missing declarations retain a safe unavailable pointer and can recover later. */ }
  const waiting = pending.get(original)
  if (waiting && existsSync(waiting)) return waiting
  output ??= outputPath()
  writeFileSync(output, available ? PREPARING : UNAVAILABLE, { encoding: 'utf8', mode: 0o600 })
  pending.set(original, output)
  while (pending.size > 32) pending.delete(pending.keys().next().value!)
  return output
}
export function markHistorySourceUnavailable(path: string): string {
  const output = declareHistorySource(path)
  writeFileSync(output, UNAVAILABLE, { encoding: 'utf8', mode: 0o600 })
  return output
}

/** Offsets refer to safe UTF-8 bytes; the original file is never exposed or rewritten. */
export function readSafeHistorySource(source: SafeHistorySource, offset: number, bytes = SOURCE_PAGE): { text: string; next: number; more: boolean } {
  assertSnapshot(source)
  const fd = openSync(source.path, 'r')
  try {
    const length = fstatSync(fd).size
    let start = Math.min(length, Math.max(0, Math.floor(offset)))
    const probe = Buffer.alloc(1)
    for (let i = 0; start > 0 && start < length && i < 3; i++) { readSync(fd, probe, 0, 1, start); if ((probe[0]! & 0xc0) !== 0x80) break; start-- }
    const budget = Math.min(65_536, Math.max(1, Math.floor(bytes))), buffer = Buffer.alloc(budget + 3)
    const n = readSync(fd, buffer, 0, buffer.length, start)
    let end = Math.min(n, budget)
    while (end < n && (buffer[end]! & 0xc0) === 0x80) end++
    const next = start + end
    return { text: buffer.subarray(0, end).toString('utf8'), next, more: next < length }
  } finally { closeSync(fd) }
}
export function readHistorySource(path: string, offset: number, bytes = SOURCE_PAGE): { text: string; next: number; more: boolean } {
  const published = publishedSources.get(resolve(path))
  const waiting = [...pending.entries()].find(([, output]) => output === resolve(path))
  return readSafeHistorySource(published ?? prepareHistorySource(waiting?.[0] ?? path), offset, bytes)
}
