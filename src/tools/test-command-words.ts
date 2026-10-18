/** Classification only. Unsupported shell syntax fails towards less evidence. */
export function verificationArgv(command: string): string[] | null {
  const argv: string[] = []
  let word = '', quote = '', active = false
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (/[\n\r]/.test(c)) return null
    if (quote === "'") { if (c === quote) quote = ''; else word += c; continue }
    if (/[`$]/.test(c)) return null
    if (!quote && c === '\\' && /['"\\\s]/.test(command[i + 1] ?? '')) { word += command[++i]; active = true; continue }
    if (c === '%') {
      if (i + 2 < command.length && /^[0-9A-Fa-f]{2}$/.test(command.slice(i + 1, i + 3))) {
        word += command.slice(i, i + 3)
        i += 2
        if (!quote) active = true
        continue
      }
      if (quote) { word += c; continue }
      return null
    }
    if (quote) {
      if (c === quote) quote = ''
      else word += c
      continue
    }
    if (c === "'" || c === '"') { quote = c; active = true; continue }
    if (/[;&|<>()]/.test(c)) return null
    if (/\s/.test(c)) {
      if (active) { argv.push(word); word = ''; active = false }
    } else { word += c; active = true }
  }
  if (quote) return null
  if (active) argv.push(word)
  return argv
}


/** All words were parsed without expansion. Single quoting preserves literal argv. */
export function shellWord(word: string): string {
  return "'" + word.replaceAll("'", "'\\''") + "'"
}
