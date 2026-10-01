import type { DraftSnapshot, InputLine } from './engine/input-line.js'

/** One process-local slot; exchange never drops a nonempty draft. */
export class DraftSlot {
  private saved: DraftSnapshot | null = null
  get occupied(): boolean { return this.saved !== null }
  exchange(line: InputLine): 'saved' | 'restored' | 'swapped' | 'empty' {
    const current = line.snapshot()
    const hasDraft = !!(current.value || current.images.length)
    if (!hasDraft && !this.saved) return 'empty'
    const previous = this.saved
    this.saved = hasDraft ? current : null
    if (previous) line.restore(previous)
    else line.clearAll()
    return previous ? hasDraft ? 'swapped' : 'restored' : 'saved'
  }
}
