export interface PermissionAllowRule {
  tool: string
  params?: Record<string, string>
}

export interface PermissionConfig {
  allow: PermissionAllowRule[]
  /** Deny rules override allow rules and approval mode. */
  deny: PermissionAllowRule[]
  /** Optional bash command allowlist/denylist. */
  bash?: BashPermissionsConfig
}

export interface BashPermissionsConfig {
  /** Command prefixes that bypass bash-write approval. */
  allowlist: string[]
  /** Command prefixes that are always blocked. */
  denylist: string[]
}

/** Runtime permission overrides that apply only to the current session. */
export interface PermissionOverlay {
  allow: PermissionAllowRule[]
  deny: PermissionAllowRule[]
  bashAllow: string[]
  bashDeny: string[]
}

export function createPermissionOverlay(): PermissionOverlay {
  return { allow: [], deny: [], bashAllow: [], bashDeny: [] }
}

/** Characters that are NOT matched by the `*` wildcard in permission patterns.
 *  Prevents cross-token matching: `git status*` must NOT match
 *  `git status&&curl evil` — the wildcard must not cross shell operators.
 *  Mirrors SHELL_OPERATOR_RE character set (whitespace excluded so normal
 *  args like `--short` still match). */
const WILDCARD_EXCLUDE = `[^&|;<>()$\\x60\\\\!"']`

function patternMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, `${WILDCARD_EXCLUDE}*`)
  return new RegExp(`^${escaped}$`).test(value)
}

function paramsMatch(expected: Record<string, string> | undefined, actual: Record<string, unknown>): boolean {
  if (!expected) return true

  return Object.entries(expected).every(([key, pattern]) => {
    const value = actual[key]
    return typeof value === 'string' && patternMatches(pattern, value)
  })
}

export function isToolAllowed(toolName: string, input: Record<string, unknown>, rules: readonly PermissionAllowRule[] | undefined): boolean {
  if (!rules?.length) return false

  return rules.some(rule => patternMatches(rule.tool, toolName) && paramsMatch(rule.params, input))
}

/** Check whether a tool call matches any deny rule. */
export function isToolDenied(toolName: string, input: Record<string, unknown>, rules: readonly PermissionAllowRule[] | undefined): boolean {
  return isToolAllowed(toolName, input, rules)
}

function unwrapShellWrappers(cmd: string): string[] {
  const result: string[] = []
  const queue = [cmd]
  const seen = new Set<string>()

  while (queue.length > 0) {
    let cur = queue.shift()!.trim()
    if (!cur || seen.has(cur)) continue
    seen.add(cur)

    // unwrap outer ( ... ) if parens match all the way
    while (cur.startsWith('(') && cur.endsWith(')')) {
      let depth = 0
      let fullMatch = true
      for (let i = 0; i < cur.length - 1; i++) {
        if (cur[i] === '(') depth++
        else if (cur[i] === ')') depth--
        if (depth === 0) { fullMatch = false; break }
      }
      if (fullMatch && depth === 1) {
        cur = cur.slice(1, -1).trim()
        if (!cur || seen.has(cur)) break
        seen.add(cur)
      } else {
        break
      }
    }

    // Check for eval or bash/sh/zsh -c
    const evalMatch = cur.match(/^(?:eval|sh\s+-[a-z]*c|bash\s+-[a-z]*c|zsh\s+-[a-z]*c)\s+["']([\s\S]+)["']$/i)
    if (evalMatch && evalMatch[1]) {
      queue.push(evalMatch[1])
    }

    // Check for brace { ... }
    while (/^\{\s*([\s\S]+?);?\s*\}$/.test(cur)) {
      cur = cur.replace(/^\{\s*([\s\S]+?);?\s*\}$/, '$1').trim()
      if (!cur || seen.has(cur)) break
      seen.add(cur)
    }

    result.push(cur)
  }

  return result
}

/** Split a bash command into the individual commands the shell would run, for
 *  denylist scanning. Splits on sequencing/pipe operators (`;` `&&` `||` `|`
 *  `&` and newlines) and additionally surfaces command-substitution bodies
 *  (`$( … )` and backtick) as their own segments, so a denied command hidden
 *  inside `foo; taskkill …`, `foo && taskkill …` or `$(taskkill …)` is still
 *  seen. Redirections (`>` `<` `2>`) are NOT separators — they belong to the
 *  same command, so the leading token stays the command binary. */
export function splitShellSegments(command: string): string[] {
  const segments: string[] = []
  const seen = new Set<string>()

  function recurse(cmd: string) {
    const trimmed = cmd.trim()
    if (!trimmed || seen.has(trimmed)) return
    seen.add(trimmed)

    // Recursively extract and strip $(...) and `...`
    let current = trimmed
    const subshellRe = /\$\(([^()]*)\)|`([^`]*)`/
    let m: RegExpExecArray | null
    while ((m = subshellRe.exec(current)) !== null) {
      const inner = (m[1] ?? m[2] ?? '').trim()
      if (inner) {
        recurse(inner)
      }
      current = current.slice(0, m.index) + ' ' + current.slice(m.index + m[0].length)
    }

    // Split on sequencing / pipe operators
    const rawParts = current.split(/[;\n|&]+/)
    for (const rawPart of rawParts) {
      const part = rawPart.trim()
      if (!part) continue
      const unwrapped = unwrapShellWrappers(part)
      for (const u of unwrapped) {
        if (u === current) {
          segments.push(u)
        } else if (/[;\n|&]+/.test(u) || /\$\(([^()]*)\)|`([^`]*)`/.test(u)) {
          recurse(u)
        } else {
          segments.push(u)
        }
      }
    }
  }

  recurse(command)
  return Array.from(new Set(segments.map(s => s.trim()).filter(Boolean)))
}

function normalizeCommandText(cmd: string): string {
  let trimmed = cmd.trimStart()
  // strip env assignments: FOO=BAR or FOO="BAR BAZ" or FOO='BAR'
  while (/^\w+=/.test(trimmed)) {
    const m = /^\w+=(?:"[^"]*"|'[^']*'|\S*)\s*/.exec(trimmed)
    if (!m) break
    trimmed = trimmed.slice(m[0].length)
  }
  // strip leading parenthesis / brace
  while (/^[({]\s*/.test(trimmed)) {
    trimmed = trimmed.replace(/^[({]\s*/, '')
  }
  while (/\s*[)};]$/.test(trimmed)) {
    trimmed = trimmed.replace(/\s*[)};]$/, '')
  }
  // strip backslash on first token: \rm -> rm
  if (trimmed.startsWith('\\')) {
    trimmed = trimmed.slice(1)
  }
  // strip empty quotes on first token: ""cmd or ''cmd
  trimmed = trimmed.replace(/^(""|'')/, '')
  // unquote single/double quoted command token: "rm" -> rm, 'rm' -> rm
  const quotedToken = trimmed.match(/^("([^"]+)"|'([^']+)')(\s+[\s\S]*|$)/)
  if (quotedToken) {
    const token = quotedToken[2] ?? quotedToken[3] ?? ''
    const rest = quotedToken[4] ?? ''
    trimmed = token + rest
  }
  // normalize consecutive whitespace
  trimmed = trimmed.replace(/\s+/g, ' ').trim()
  return trimmed
}

/** Does a single command segment's leading command binary match a denylist
 *  prefix? Strips leading `VAR=value` env assignments, normalizes wrapper
 *  syntax / escaping / whitespace, and enforces a token boundary so `rm`
 *  matches `rm -rf` but not `rmdir`, and an argument that merely contains the
 *  word (`echo taskkill`) never matches. */
function segmentMatchesDenyPrefix(segment: string, denylist: readonly string[]): boolean {
  const normalized = normalizeCommandText(segment)
  if (!normalized) return false

  return denylist.some(entry => {
    if (!entry) return false
    const normEntry = entry.trim().replace(/\s+/g, ' ')
    if (!normalized.startsWith(normEntry)) return false
    const nextChar = normalized[normEntry.length]
    return nextChar === undefined || nextChar === ' ' || nextChar === '\t'
  })
}

/** Check whether a bash command is blocked by any denylist prefix.
 *
 *  Denylist is fail-closed: if ANY segment the shell would run starts with a
 *  denied prefix, the whole command is denied. This is deliberately NOT the
 *  allowlist logic — allowlisting rejects commands containing shell operators
 *  (to prevent `npx && rm -rf /` sneaking past the allowlist), but reusing that
 *  for denylist would let `taskkill …; rm -rf /` slip THROUGH the denylist,
 *  which is the opposite of what a denylist must do. */
export function isBashCommandDenied(command: string, denylist: readonly string[] | undefined): boolean {
  if (!denylist?.length) return false
  return splitShellSegments(command).some(seg => segmentMatchesDenyPrefix(seg, denylist))
}

/** Extract the first token (command binary) from a bash command for allowlist learning.
 *  "git add ." → "git", "npx tsx --test" → "npx" */
export function extractBashPrefix(command: string): string {
  const trimmed = command.trimStart()
  if (!trimmed) return ''
  const spaceIdx = trimmed.indexOf(' ')
  return spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)
}

/** Learn a bash command prefix into the session allowlist after user approval.
 *  Creates the bash config if needed; deduplicates to avoid unbounded growth. */
export function learnBashPrefix(command: string, permissions: PermissionConfig | undefined): void {
  if (!permissions || typeof command !== 'string') return
  const prefix = extractBashPrefix(command)
  if (!prefix) return
  // `CI=true npm test` 的首 token 是环境赋值——学进 allowlist 是死条目
  // （匹配前赋值已被剥离），留着只会让 allowlist 语义变含糊。
  if (prefix.includes('=')) return
  if (!permissions.bash) permissions.bash = { allowlist: [], denylist: [] }
  if (!permissions.bash.allowlist.includes(prefix)) {
    permissions.bash.allowlist.push(prefix)
  }
}

/** Learn a file-scoped allow rule into the session overlay after user approval,
 *  so subsequent identical edits to the SAME file don't re-prompt within the
 *  session. Mirrors learnBashPrefix for write tools; dedupes to bound growth.
 *  The path is stored verbatim — permission patterns treat non-`*` characters
 *  as literals (see patternMatches), so an exact path matches only itself. */
export function learnFileApproval(
  toolName: string,
  filePath: string,
  overlay: PermissionOverlay | undefined,
): void {
  if (!overlay || !filePath) return
  const exists = overlay.allow.some(r => r.tool === toolName && r.params?.file_path === filePath)
  if (!exists) overlay.allow.push({ tool: toolName, params: { file_path: filePath } })
}

/** Shell constructs `splitShellSegments` does NOT model, so a command containing
 *  them cannot be reasoned about segment-by-segment:
 *  - `>` `<` redirection writes/reads arbitrary paths regardless of the binary,
 *    so `echo x > ~/.zshrc` would sail through on an allowlisted `echo`;
 *  - `\` escaping changes what the shell treats as a separator;
 *  - `!` triggers history expansion.
 *  Commands containing these always fall back to an explicit prompt.
 *  注：`()`/`{}` 不进此表——unwrapShellWrappers + 递归分段已能建模（deny 侧
 *  穿透修复，2026-10-16 审计 P0），allow 侧还有 :326 的残余括号兜底拒；
 *  把它们列进来会让 `git diff $(git merge-base …)` 这类已建模命令永远无法获批
 *  （bash-allowlist.test.ts 的契约）。 */
const UNMODELLED_SHELL_CHARS = /[<>\\!]/

/** Binaries that take code as an argument. Matching only the binary name would
 *  grant everything the interpreter can be told to run, so `bash -c "rm -rf /"`
 *  must still prompt even when `bash` is allowlisted. */
const INTERPRETERS = new Set([
  'sh', 'bash', 'zsh', 'ksh', 'dash', 'fish',
  'node', 'deno', 'bun', 'python', 'python3', 'perl', 'ruby', 'php',
  'osascript', 'powershell', 'pwsh', 'cmd',
])

/** Inline-code flags for the binaries above (`-c`, `-e`, `--eval`, …). Only
 *  consulted for INTERPRETERS — plenty of benign commands use `-c` for
 *  unrelated purposes (`grep -c`, `wc -c`). */
const INLINE_CODE_FLAG = /^-{1,2}(c|e|eval|command|exec)$/i

/** Short-flag clusters carrying an inline-code switch: `bash -lc`, `sh -ec`,
 *  `node -pe`, `ruby -ne`. Single dash only — long flags like `--check` /
 *  `--experimental-*` are benign and must not be caught here. */
const INLINE_CODE_CLUSTER = /^-[a-z]*[ce][a-z]*$/i

/** Binaries that execute whatever they are handed, with no flag needed. */
const ALWAYS_PROMPT_BINARIES = new Set([
  'eval', 'exec', 'source', '.', 'xargs',
  // Wrapper binaries: they run their argument vector as a subprocess, so an
  // allowlisted wrapper would launder any command past the prompt.
  'timeout', 'nice', 'nohup', 'parallel', 'env', 'stdbuf',
])

/** Does one segment's leading binary match an allowlist entry?
 *  Mirrors segmentMatchesDenyPrefix (same token boundary), plus the fail-closed
 *  guards an ALLOW decision needs that a DENY decision does not.
 *
 *  `VAR=value` stripping differs from the deny side deliberately: an env
 *  assignment is itself a code-execution vector (`PATH=/tmp/evil:…`,
 *  `LD_PRELOAD=…`, `NODE_OPTIONS=--require=…`), and on the allow side
 *  "weakening" means *granting*. Only assignments with plainly inert values
 *  (no path separator, no expansion, no second `=`) may be stripped for
 *  matching; anything else falls to an explicit prompt. */
function segmentMatchesAllowEntry(segment: string, allowlist: readonly string[]): boolean {
  let trimmed = segment.trimStart()
  while (/^\w+=/.test(trimmed)) {
    const m = /^\w+=(\S*)\s+/.exec(trimmed)
    if (!m) return false // trailing assignment with no command — nothing to grant
    const value = m[1]!
    if (/[/:$=]/.test(value)) return false
    trimmed = trimmed.slice(m[0].length)
  }
  if (!trimmed) return false

  // Residual substitution delimiters mean splitShellSegments could not fully
  // parse this segment (e.g. nested `$( … $( … ) … )`). Denylist may tolerate a
  // parse miss — it only weakens a denial — but granting on text we never
  // inspected is the opposite, so fail closed.
  if (/[`()]/.test(trimmed)) return false

  const tokens = trimmed.split(/\s+/)
  const binary = tokens[0] ?? ''
  // A binary that is itself an expansion (`$CMD args`) is unknowable statically.
  if (binary.includes('$')) return false
  const base = binary.slice(binary.lastIndexOf('/') + 1)
  if (ALWAYS_PROMPT_BINARIES.has(base)) return false
  if (INTERPRETERS.has(base) && tokens.slice(1).some(t => INLINE_CODE_FLAG.test(t) || INLINE_CODE_CLUSTER.test(t))) return false

  return allowlist.some(entry => {
    if (!entry || !trimmed.startsWith(entry)) return false
    const nextChar = trimmed[entry.length]
    return nextChar === undefined || nextChar === ' ' || nextChar === '\t'
  })
}

/** Check whether a bash command is covered by the allowlist.
 *
 *  Every command the shell would actually run must be allowlisted — the same
 *  segmentation used by the denylist (`splitShellSegments`), so `npx && rm -rf /`
 *  is still rejected when only `npx` is allowlisted, because the `rm` segment is
 *  not covered.
 *
 *  This replaces an earlier rule that rejected any command containing a shell
 *  metacharacter anywhere. That rule was an unconditional wall rather than a
 *  permission check: `npm test -- --grep "foo"` and
 *  `git diff $(git merge-base main HEAD)` could never be approved no matter what
 *  the user allowlisted, because the quote and the `$(` alone disqualified them.
 *  Segment-wise coverage keeps the chaining bypass closed while letting an
 *  approval actually stick. */
export function isBashCommandAllowlisted(command: string, allowlist: readonly string[] | undefined): boolean {
  if (!allowlist?.length) return false
  const trimmed = command.trim()
  if (!trimmed) return false
  if (UNMODELLED_SHELL_CHARS.test(trimmed)) return false
  const segments = splitShellSegments(trimmed)
  if (!segments.length) return false
  return segments.every(seg => segmentMatchesAllowEntry(seg, allowlist))
}
