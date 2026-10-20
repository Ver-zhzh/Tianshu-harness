/** Recognize match records only; context, status and edit hints are not matches. */
export function grepMatchFile(line: string): string | null {
  const nativeContext = line.match(/^(.+?):>\s*\d+│ /)
  if (nativeContext) return nativeContext[1]!
  const named = line.match(/^(.+?):\d+:/)
  if (named) return named[1]!
  return /^\d+:/.test(line) ? '(single file)' : null
}

export function grepOutputStats(content: string): { matches: number; files: string[] } {
  let matches = 0
  const files = new Set<string>()
  for (const line of content.split(/\r?\n/)) {
    const file = grepMatchFile(line)
    if (file === null) continue
    matches++
    files.add(file)
  }
  return { matches, files: [...files] }
}

export function grepTruncationMarker(content: string): string {
  const { matches } = grepOutputStats(content)
  return `[truncated: showing ${matches} matches — result was cut short; narrow path/glob or reduce context_lines, or increase max_results within the output budget]`
}
