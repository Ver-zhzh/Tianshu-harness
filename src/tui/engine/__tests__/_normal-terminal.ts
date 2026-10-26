import { displayWidth } from '../../width.js'

/** Interprets the renderer's ANSI into physical screen cells and native scrollback. */
export class NormalTerminal {
  isTTY = true
  columns: number
  rows: number
  screen: string[][]
  scrollback: string[] = []
  cursorRow = 0
  cursorCol = 0
  private saved?: { screen: string[][]; row: number; col: number }
  private caret: [number, number] = [0, 0]

  constructor(columns = 100, rows = 24) {
    this.columns = columns; this.rows = rows
    this.screen = Array.from({ length: rows }, () => [])
  }
  on(): this { return this }
  removeListener(): this { return this }
  text(): string { return [...this.scrollback, ...this.screen.map(line => line.join(''))].join('\n') }
  private newline(): void {
    this.cursorCol = 0
    if (this.cursorRow < this.rows - 1) { this.cursorRow++; return }
    const line = this.screen.shift()!.join('')
    if (!this.saved) this.scrollback.push(line)
    this.screen.push([])
  }
  resize(columns: number, rows: number): void {
    this.columns = columns
    while (this.screen.length > rows) {
      this.scrollback.push(this.screen.shift()!.join('')); this.cursorRow--
    }
    while (this.screen.length < rows) this.screen.push([])
    this.rows = rows
    this.cursorRow = Math.max(0, Math.min(rows - 1, this.cursorRow))
    this.cursorCol = Math.min(columns - 1, this.cursorCol)
  }
  write = (text: string): boolean => {
    for (let i = 0; i < text.length;) {
      const rest = text.slice(i)
      // eslint-disable-next-line no-control-regex
      const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(rest)
      if (osc) { i += osc[0].length; continue }
      // eslint-disable-next-line no-control-regex
      const csi = /^\x1b\[([\d;?<>=]*)(?:[ -/]*)([@-~])/.exec(rest)
      if (csi) {
        const [, params = '', op] = csi
        const values = params.split(';').map(Number), n = values[0] || 1
        if (params === '?1049' && op === 'h' && !this.saved) {
          this.saved = { screen: this.screen, row: this.cursorRow, col: this.cursorCol }
          this.screen = Array.from({ length: this.rows }, () => []); this.cursorRow = this.cursorCol = 0
        } else if (params === '?1049' && op === 'l' && this.saved) {
          const saved = this.saved; this.saved = undefined
          this.screen = saved.screen; this.cursorRow = saved.row; this.cursorCol = saved.col
        } else if (!/[?<>=]/.test(params)) {
          if (op === 'A') this.cursorRow = Math.max(0, this.cursorRow - n)
          else if (op === 'B') this.cursorRow = Math.min(this.rows - 1, this.cursorRow + n)
          else if (op === 'G') this.cursorCol = n - 1
          else if (op === 'H' || op === 'f') {
            this.cursorRow = Math.min(this.rows - 1, n - 1); this.cursorCol = (values[1] || 1) - 1
          } else if (op === 's') this.caret = [this.cursorRow, this.cursorCol]
          else if (op === 'u') [this.cursorRow, this.cursorCol] = this.caret
          else if (op === 'K') this.screen[this.cursorRow] = values[0] === 2 ? [] : this.screen[this.cursorRow]!.slice(0, this.cursorCol)
          else if (op === 'J') {
            if (values[0] === 2) this.screen = Array.from({ length: this.rows }, () => [])
            else {
              this.screen[this.cursorRow] = this.screen[this.cursorRow]!.slice(0, this.cursorCol)
              for (let row = this.cursorRow + 1; row < this.rows; row++) this.screen[row] = []
            }
          }
        }
        i += csi[0].length; continue
      }
      const ch = String.fromCodePoint(text.codePointAt(i)!); i += ch.length
      if (ch === '\r') { this.cursorCol = 0; continue }
      if (ch === '\n') { this.newline(); continue }
      if (ch < ' ') continue
      const width = displayWidth(ch)
      if (!width) continue
      if (this.cursorCol + width > this.columns) this.newline()
      const line = this.screen[this.cursorRow]!
      while (line.length < this.cursorCol) line.push(' ')
      line[this.cursorCol++] = ch
      for (let col = 1; col < width; col++) line[this.cursorCol++] = ''
    }
    return true
  }
}
