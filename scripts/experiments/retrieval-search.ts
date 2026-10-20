import { readdirSync, readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync, lstatSync, realpathSync, statSync, openSync, fstatSync, readSync, closeSync, constants } from 'node:fs'
import { join, dirname } from 'node:path'
import type { ToolDefinition } from '../../src/api/types.js'
import { LongWorld, sha } from './recovery-long-world.js'
import { resolveCapability, CapabilityError, capabilityFailure, describe } from './experiment-capabilities.js'
import { observation } from './experiment-protocol.js'

export function hasSearchTruncationMarker(content: string): boolean {
  return /^\[truncated: showing \d+ matches[^\r\n]*\]$/m.test(content)
    || /^\[已截断[^\r\n]*\]$/m.test(content)
    || /^\.\.\.\s*[（(]已截断[^\r\n]*[）)]$/m.test(content)
}

/** Bound allocation and reading even if the file grows after stat. */
export function readProjectionFile(path: string, remaining: number): Buffer {
  const limit = () => new CapabilityError('search_projection_limit', 'The selected search scope exceeds 32 MiB or 2048 files. Narrow path and retry; no partial search was performed.')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new CapabilityError('search_special_file', 'Search declared regular files; special files are not readable search inputs.')
    if (stat.size > remaining) throw limit()
    const chunks: Buffer[] = []; let bytes = 0
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining - bytes + 1))
      const count = readSync(fd, chunk, 0, chunk.length, null)
      if (!count) return Buffer.concat(chunks, bytes)
      bytes += count
      if (bytes > remaining) throw limit()
      chunks.push(chunk.subarray(0, count))
    }
  } finally { closeSync(fd) }
}

export class RetrievalSearch {
  private grep!: typeof import('../../src/tools/grep.js')['GREP_TOOL']
  private reads!: typeof import('../../src/tools/read-file.js')
  private section!: typeof import('../../src/tools/read-section.js')['READ_SECTION_TOOL']
  private grepSession = 'long-pilot'
  private qualifications = 0
  readonly metrics: { tool: string; bytes: number; duplicateVisibleBytes: number; binding: string; fileVersions: Record<string, string>; completeness: string }[] = []
  private seen = new Set<string>()
  constructor(readonly world: LongWorld) {}
  resetMetrics() { this.metrics.length = 0; this.seen.clear() }
  async initialize() { await this.world.initialize(); this.grep = (await import('../../src/tools/grep.js')).GREP_TOOL; this.reads = await import('../../src/tools/read-file.js'); this.section = (await import('../../src/tools/read-section.js')).READ_SECTION_TOOL }
  definitions(): ToolDefinition[] { return [...this.world.definitions(), { ...this.grep.definition,
    description: this.grep.definition.description + '\nSearch covers declared task inputs only; private/runtime/temp data are excluded. semantic_search and hash_edit are unavailable in this experiment; use the declared read_file/read_section/edit_file/write_file tools. ' + describe(this.world.capabilities) },
    { name: 'read_section', description: 'Read a specific section from a declared file, including read-ref recovery. Production READ_SECTION_TOOL, file sections only; no artifact IDs. ' + describe(this.world.capabilities),
      input_schema: { type: 'object', properties: { file_path: { type: 'string' }, section: { type: 'string', description: 'L1-L20 or c0-c500' } }, required: ['file_path', 'section'] } }] }
  /** A disposable declared-input projection prevents the host grep from seeing .tmp, graders or escaping links. */
  private inputs(path = ''): Record<string, Buffer> {
    const found: Record<string, Buffer> = {}; let bytes = 0, count = 0
    const scope = resolveCapability(this.world.root, path, 'list', this.world.capabilities)
    const walk = (path: string) => {
      let selected: ReturnType<typeof resolveCapability>
      try { selected = resolveCapability(this.world.root, path, 'list', this.world.capabilities) } catch { return }
      if (lstatSync(selected.absolute).isSymbolicLink()) return
      if (selected.directory) { for (const e of readdirSync(selected.absolute)) walk(join(path, e).replaceAll('\\', '/')); return }
      if (count >= 2048) throw new CapabilityError('search_projection_limit', 'The selected search scope exceeds 2048 files. Narrow path and retry; no partial search was performed.')
      const data = readProjectionFile(selected.absolute, 32 * 1024 * 1024 - bytes)
      bytes += data.length
      count++
      found[path] = data
    }
    if (scope.path) walk(scope.path)
    else for (const root of this.world.capabilities.readable) walk(root)
    return found
  }
  private versions(input: Record<string, any>, search: boolean) {
    if (search) {
      return Object.fromEntries(Object.entries(this.inputs(input.path ?? '')).map(([p, data]) => [p, sha(data)]))
    }
    const versions: Record<string, string> = {}
    for (const p of (Array.isArray(input.file_paths) ? input.file_paths : [input.file_path])) {
      try { const f = resolveCapability(this.world.root, p, 'read', this.world.capabilities); versions[f.path] = sha(readFileSync(f.absolute)) } catch { /* rejected calls have no valid binding */ }
    }
    return versions
  }
  async execute(name: string, input: Record<string, any>, signal?: AbortSignal) {
    let before: Record<string, string> = {}
    try { if (name === 'grep' || name === 'read_file' || name === 'read_section') before = this.versions(input, name === 'grep') } catch { /* rejected query has no usable version binding */ }
    let result: any
    if (name === 'read_section') {
      signal?.throwIfAborted()
      try {
        if (input.artifactId) throw new CapabilityError('artifact_unavailable', 'Read a declared file_path and section; artifact IDs are not exposed in this experiment.')
        const selected = resolveCapability(this.world.root, input.file_path, 'read', this.world.capabilities)
        result = await this.section.execute({ cwd: this.world.root, input: { ...input, file_path: selected.path }, sessionId: 'long-pilot', toolUseId: String(this.world.events.length), abortSignal: signal } as any)
        result.observation = observation(result.isError ? 'unknown' : 'candidate', result.isError ? 'tool_error' : 'tool_completed', true, name, this.world.sourceHash())
      } catch (e) { if (!(e instanceof CapabilityError)) throw e; result = capabilityFailure(e, this.world.sourceHash()) }
      this.world.events.push({ at: new Date().toISOString(), name, input, result, sourceHash: this.world.sourceHash() })
    } else if (name !== 'grep') result = await this.world.execute(name, input, signal)
    else {
      signal?.throwIfAborted()
      const projection = mkdtempSync(join(this.world.privateRoot, 'search-'))
      try {
        const selected = resolveCapability(this.world.root, input.path ?? '', 'list', this.world.capabilities)
        // A symlinked root could bypass projection semantics; require an ordinary selected path.
        if (selected.path && (lstatSync(selected.absolute).isSymbolicLink() || realpathSync(selected.absolute) !== selected.absolute)) throw new CapabilityError('search_symlink', 'Search a declared regular path; symlinks are excluded from the search projection.')
        const files = this.inputs(selected.path)
        for (const [p, data] of Object.entries(files)) { const target = join(projection, p); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, data) }
        if (selected.directory) mkdirSync(join(projection, selected.path), { recursive: true })
        result = await this.grep.execute({ cwd: projection, input: { ...input, path: selected.path || '.' }, sessionId: this.grepSession, toolUseId: String(this.world.events.length), abortSignal: signal } as any)
        // Preserve production grep→edit observation semantics across the projection.
        // Register only what grep itself marked observed and whose actual bytes still match.
        if (!result.isError) for (const [p, data] of Object.entries(files)) {
          if (this.reads.getFileReadMtime(join(projection, p), this.grepSession) === null) continue
          const actual = resolveCapability(this.world.root, p, 'read', this.world.capabilities), first = statSync(actual.absolute)
          let current: Buffer
          try { current = readProjectionFile(actual.absolute, data.length) }
          catch (error) { if (error instanceof CapabilityError) continue; throw error }
          const matches = sha(current) === sha(data), last = statSync(actual.absolute)
          if (matches && first.mtimeMs === last.mtimeMs && first.size === last.size) this.reads.registerGrepFileAccess(actual.absolute, last.mtimeMs, this.grepSession)
        }
        result.content = result.content.replaceAll(projection + '/', '')
        result.observation = observation(result.isError ? 'unknown' : 'candidate', result.isError ? 'tool_error' : 'tool_completed', true, 'grep', this.world.sourceHash())
      } catch (e) {
        if (signal?.aborted) throw e
        if (!(e instanceof CapabilityError)) throw e
        result = capabilityFailure(e, this.world.sourceHash())
      } finally { rmSync(projection, { recursive: true, force: true }) }
      this.world.events.push({ at: new Date().toISOString(), name, input, result, sourceHash: this.world.sourceHash() })
    }
    const text = result.content ?? ''; let after: Record<string, string> = {}
    try { if (name === 'grep' || name === 'read_file' || name === 'read_section') after = this.versions(input, name === 'grep') } catch { /* cannot reuse unresolved evidence */ }
    const completeness = result.isError ? 'rejected-or-error' : /截断|不完整|truncat|\[read-ref\]/i.test(text) ? 'partial-or-reference' : 'reported-output'
    const binding = sha({ name, input, versions: before, payload: sha(text) })
    const reusable = (name === 'grep' || name === 'read_file' || name === 'read_section') && !result.isError && completeness === 'reported-output' && Object.keys(before).length > 0 && sha(before) === sha(after)
    this.metrics.push({ tool: name, bytes: Buffer.byteLength(text), duplicateVisibleBytes: reusable && this.seen.has(binding) ? Buffer.byteLength(text) : 0, binding, fileVersions: before, completeness })
    if (reusable) this.seen.add(binding)
    return result
  }
  async qualify() {
    const priorSession = this.grepSession
    this.grepSession = 'qualification-' + (++this.qualifications)
    try {
    const marker = 'PRIVATE_SEARCH_CANARY_7f04b2'
    writeFileSync(join(this.world.privateRoot, 'canary.txt'), marker)
    writeFileSync(join(this.world.root, '.tmp/canary.txt'), marker)
    const root = await this.execute('grep', { pattern: marker, literal: true })
    const known = await this.execute('grep', { pattern: 'export', path: 'src', context_lines: 2, max_results: 1 })
    // A truncated directory result may contain only a context line; it must not stand in for a witnessed match.
    const anchor = Object.entries(this.inputs('src')).find(([, data]) => /\bexport\b/.test(data.toString('utf8')))?.[0]
    const editorProbe = anchor ? await this.execute('grep', { pattern: 'export', path: anchor, literal: true }) : null
    const editorObservationBridged = !!anchor && !editorProbe?.isError && this.reads.getFileReadMtime(join(this.world.root, anchor), this.grepSession) !== null
    const outside = await this.execute('grep', { pattern: marker, path: '../' })
    return { passed: !root.isError && !root.content.includes(marker) && hasSearchTruncationMarker(known.content) && !known.isError && outside.isError === true && editorObservationBridged,
      root, known, editorProbe, outside, editorObservationBridged, engine: 'production GREP_TOOL over declared-input projection, with byte-checked original-path editor observation bridge; no private grader access' }
    } finally { this.grepSession = priorSession }
  }
}
