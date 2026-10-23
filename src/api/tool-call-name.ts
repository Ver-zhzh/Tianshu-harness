export type ToolNameFailure = 'unknown' | 'ambiguous' | 'incomplete' | 'identity'

export class ToolNameProtocolError extends Error {
  constructor(readonly reason: ToolNameFailure) {
    super(`上游工具调用协议异常（${reason}）：无法唯一确定工具名称或调用归属，已停止本次响应；本次工具未执行。请切换模型或检查端点的工具调用格式。`)
    this.name = 'ToolNameProtocolError'
  }
}

/** Shared by all calls in one attempt; only actual wire declarations qualify. */
export class ToolNameVocabulary {
  readonly names: ReadonlySet<string>
  readonly prefixes: ReadonlySet<string>
  readonly expandable: ReadonlySet<string>
  readonly canonical: ReadonlyMap<string, string>

  constructor(names: readonly string[]) {
    this.names = new Set(names)
    const canonical = new Map([...this.names].map(name => [name, name]))
    // Some OpenAI-compatible gateways expose function calls as
    // `functions.<declared-name>`. Only this exact wrapper is accepted, and a
    // real wire declaration always wins if it already uses that spelling.
    for (const name of this.names) {
      if (name.startsWith('functions.')) continue
      const wrapped = `functions.${name}`
      if (!canonical.has(wrapped)) canonical.set(wrapped, name)
    }
    this.canonical = canonical
    const prefixes = new Set<string>()
    const expandable = new Set<string>()
    for (const name of canonical.keys()) {
      for (let length = 0; length <= name.length; length++) {
        prefixes.add(name.slice(0, length))
        if (length < name.length) expandable.add(name.slice(0, length))
      }
    }
    this.prefixes = prefixes
    this.expandable = expandable
  }
}

/** Keep plausible delta/echo/snapshot interpretations instead of guessing. */
export class ToolCallName {
  private candidates = new Set([''])
  fragments = 0

  constructor(private readonly vocabulary: ToolNameVocabulary) {}

  append(part: string): { repeat: boolean; snapshot: boolean } {
    if (!part) return { repeat: false, snapshot: false }
    this.fragments++
    const next = new Set<string>()
    let repeat = false
    let snapshot = false
    for (const current of this.candidates) {
      const appended = current + part
      if (this.vocabulary.prefixes.has(appended)) next.add(appended)
      if (part === current) { next.add(current); repeat = true }
      if (current && part.length > current.length && part.startsWith(current) && this.vocabulary.prefixes.has(part)) {
        next.add(part)
        snapshot = true
      }
    }
    this.candidates = next
    if (!next.size) throw new ToolNameProtocolError('unknown')
    return { repeat, snapshot }
  }

  get candidateCount(): number { return this.candidates.size }

  get completeNames(): string[] {
    return [...new Set([...this.candidates].flatMap(name => {
      const canonical = this.vocabulary.canonical.get(name)
      return canonical ? [canonical] : []
    }))]
  }

  /** Early hints must also exclude incomplete branches and longer tool names. */
  get hintName(): string | undefined {
    const [name] = this.candidates
    return name && this.candidates.size === 1 && this.vocabulary.canonical.has(name)
      && !this.vocabulary.expandable.has(name) ? this.vocabulary.canonical.get(name) : undefined
  }

  resolve(final: boolean): string | undefined {
    const names = this.completeNames
    if (names.length > 1) {
      if (final) throw new ToolNameProtocolError('ambiguous')
      return undefined
    }
    // Some providers send finish_reason before trailing name/argument chunks.
    // A registered short name is not complete while it can still grow.
    if (names.length === 1) return final || this.hintName === names[0] ? names[0] : undefined
    if (final) throw new ToolNameProtocolError('incomplete')
    return undefined
  }
}
