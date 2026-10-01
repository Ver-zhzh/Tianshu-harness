/**
 * Headless state machine behind the `/config` settings panel.
 *
 * Pure and side-effect free like `connect-flow.ts`: it owns the two cursors
 * (category column / field column), the focus side, the edit buffer, and the
 * draft config; it produces a `SettingsView` for the renderer and hands the
 * dirty draft to `settings-persist.ts` on save. No config I/O lives here, so the
 * cursor-boundary and validation rules are unit-testable without a terminal.
 */

import {
  buildCategories,
  dirtyBlocks,
  type SettingsBlockId,
  type SettingsDraft,
  type SettingsEffect,
  type SettingsEnv,
  type SettingsField,
  type SettingsFieldKind,
  type SettingsOption,
} from './settings-model.js'

export type SettingsMode = 'browse' | 'search' | 'picker' | 'editor' | 'confirm-discard'
export type SettingsFocus = 'categories' | 'fields'

export interface SettingsViewCategory {
  id: string
  label: string
  dirty: boolean
}

export interface SettingsViewField {
  categoryLabel?: string
  id: string
  label: string
  value: string
  kind: SettingsFieldKind
  effect: SettingsEffect
  dirty: boolean
  hint?: string
}

export interface SettingsView {
  query?: string
  mode: SettingsMode
  focus: SettingsFocus
  categories: SettingsViewCategory[]
  categoryIndex: number
  fields: SettingsViewField[]
  fieldIndex: number
  /** `picker` mode: the enum choice list for the selected field. */
  picker?: { label: string; options: SettingsOption[]; index: number }
  /** `editor` mode: free-text / integer buffer for the selected field. */
  editor?: { label: string; buffer: string; hint?: string }
  /** Validation failure for the last edit attempt. */
  error?: string
  /** Result line after a save ("已保存 …" / "保存失败 …"). */
  status?: string
  dirtyBlocks: SettingsBlockId[]
}

export interface SettingsSaveRequest {
  baseline: SettingsDraft
  draft: SettingsDraft
  blocks: SettingsBlockId[]
}

export interface SettingsSaveResult {
  saved: SettingsBlockId[]
  errors: string[]
  /** Draft re-read from disk after a successful write, when available. */
  persisted?: SettingsDraft
}

export class SettingsFlow {
  private readonly env: SettingsEnv
  private baseline: SettingsDraft
  private current: SettingsDraft
  private mode: SettingsMode = 'browse'
  private focus: SettingsFocus = 'categories'
  private catIndex = 0
  private fieldIndex = 0
  private pickerIndex = 0
  private buffer = ''
  private query = ''
  private error?: string
  private status?: string

  constructor(baseline: SettingsDraft, env: SettingsEnv) {
    this.baseline = baseline
    this.current = baseline
    this.env = env
  }

  // ── view ───────────────────────────────────────────────────

  view(): SettingsView {
    const categories = buildCategories(this.current, this.env)
    const cats = categories.map(cat => ({
      id: cat.id,
      label: cat.label,
      dirty: cat.fields.some(f => this.isFieldDirty(f)),
    }))
    const fields = this.visibleFields().map(f => ({
      id: f.id,
      label: f.label,
      value: f.display(this.current, this.env),
      kind: f.kind,
      effect: f.effect,
      dirty: this.isFieldDirty(f),
      hint: f.hint,
      categoryLabel: this.query ? categories.find(cat => cat.fields.some(field => field.id === f.id))?.label : undefined,
    }))

    const view: SettingsView = {
      mode: this.mode,
      query: this.query,
      focus: this.focus,
      categories: cats,
      categoryIndex: this.catIndex,
      fields,
      fieldIndex: this.fieldIndex,
      error: this.error,
      status: this.status,
      dirtyBlocks: this.dirty(),
    }

    const field = this.activeField()
    if (this.mode === 'picker' && field) {
      view.picker = {
        label: field.label,
        options: field.options?.(this.current, this.env) ?? [],
        index: this.pickerIndex,
      }
    }
    if (this.mode === 'editor' && field) {
      view.editor = { label: field.label, buffer: this.buffer, hint: field.hint }
    }
    return view
  }

  dirty(): SettingsBlockId[] {
    return dirtyBlocks(this.baseline, this.current)
  }

  /** True while free text is being typed — the caller must not treat keys as shortcuts. */
  isTextEditing(): boolean {
    return this.mode === 'editor' || this.mode === 'search'
  }

  startSearch(): void {
    if (this.mode !== 'browse') return
    this.mode = 'search'
    this.focus = 'fields'
    this.error = undefined
    this.status = undefined
  }

  editSearch(query: string): void {
    if (this.mode !== 'search') return
    this.query = query
    this.fieldIndex = 0
  }

  // ── navigation ─────────────────────────────────────────────

  moveUp(): void {
    if (this.mode === 'picker') {
      this.pickerIndex = Math.max(0, this.pickerIndex - 1)
      return
    }
    if (this.mode === 'search') { this.fieldIndex = Math.max(0, this.fieldIndex - 1); return }
    if (this.mode !== 'browse') return
    if (this.focus === 'categories') this.setCategory(this.catIndex - 1)
    else this.fieldIndex = Math.max(0, this.fieldIndex - 1)
  }

  moveDown(): void {
    if (this.mode === 'picker') {
      const count = this.pickerOptions().length
      this.pickerIndex = Math.min(Math.max(0, count - 1), this.pickerIndex + 1)
      return
    }
    if (this.mode === 'search') { this.fieldIndex = Math.min(Math.max(0, this.fieldCount() - 1), this.fieldIndex + 1); return }
    if (this.mode !== 'browse') return
    if (this.focus === 'categories') this.setCategory(this.catIndex + 1)
    else this.fieldIndex = Math.min(Math.max(0, this.fieldCount() - 1), this.fieldIndex + 1)
  }

  focusCategories(): void {
    if (this.mode !== 'browse') return
    if (this.query) return
    this.focus = 'categories'
    this.error = undefined
  }

  focusFields(): void {
    if (this.mode !== 'browse') return
    if (this.fieldCount() === 0) return
    this.focus = 'fields'
    this.fieldIndex = Math.min(this.fieldIndex, this.fieldCount() - 1)
    this.error = undefined
  }

  toggleFocus(): void {
    if (this.focus === 'categories') this.focusFields()
    else this.focusCategories()
  }

  // ── editing ────────────────────────────────────────────────

  /** Enter: descend into the field column, or open/commit an edit. */
  activate(): void {
    this.status = undefined
    if (this.mode === 'confirm-discard') return
    if (this.mode === 'search') {
      this.mode = 'browse'
      this.focus = 'fields'
      return
    }
    if (this.mode === 'picker') {
      this.commitPicker()
      return
    }
    if (this.mode === 'editor') {
      this.commitEditor()
      return
    }
    if (this.focus === 'categories') {
      this.focusFields()
      return
    }
    const field = this.activeField()
    if (!field) return
    this.error = undefined
    switch (field.kind) {
      case 'bool': {
        const currentOn = field.selectedId?.(this.current) === 'true'
        this.applyValue(field, currentOn ? 'false' : 'true')
        return
      }
      case 'enum': {
        const options = field.options?.(this.current, this.env) ?? []
        if (options.length === 0) {
          this.error = '没有可选项——先用 /connect 连接一个服务商'
          return
        }
        const selected = field.selectedId?.(this.current)
        const at = options.findIndex(o => o.id === selected)
        this.pickerIndex = at >= 0 ? at : 0
        this.mode = 'picker'
        return
      }
      case 'text':
      case 'int': {
        this.buffer = field.raw?.(this.current) ?? ''
        this.mode = 'editor'
        return
      }
      case 'action': {
        if (field.run) this.current = field.run(this.current)
        return
      }
    }
  }

  typeChar(ch: string): void {
    if (this.mode === 'search') { this.editSearch(this.query + ch); return }
    if (this.mode !== 'editor') return
    this.buffer += ch
    this.error = undefined
  }

  backspace(): void {
    if (this.mode === 'search') { this.editSearch([...this.query].slice(0, -1).join('')); return }
    if (this.mode !== 'editor') return
    this.buffer = [...this.buffer].slice(0, -1).join('')
    this.error = undefined
  }

  clearBuffer(): void {
    if (this.mode === 'search') { this.editSearch(''); return }
    if (this.mode !== 'editor') return
    this.buffer = ''
  }

  /**
   * Esc. Closes the innermost layer; from `browse` with unsaved edits it asks
   * for confirmation first, because silently dropping edits is exactly the
   * "failure you cannot see" shape this panel is meant to avoid.
   */
  cancel(): 'handled' | 'closed' {
    switch (this.mode) {
      case 'search':
        this.query = ''
        this.fieldIndex = 0
        this.mode = 'browse'
        this.focus = 'categories'
        return 'handled'
      case 'picker':
      case 'editor':
        this.mode = 'browse'
        this.buffer = ''
        this.error = undefined
        return 'handled'
      case 'confirm-discard':
        this.mode = 'browse'
        return 'handled'
      case 'browse':
        if (this.query) {
          this.query = ''
          this.fieldIndex = 0
          this.focus = 'categories'
          return 'handled'
        }
        if (this.dirty().length > 0) {
          this.mode = 'confirm-discard'
          this.error = undefined
          return 'handled'
        }
        return 'closed'
    }
  }

  /** Enter/y on the discard prompt: throw the edits away and close. */
  confirmDiscard(): 'closed' {
    this.mode = 'browse'
    this.current = this.baseline
    return 'closed'
  }

  isConfirmingDiscard(): boolean {
    return this.mode === 'confirm-discard'
  }

  // ── save ───────────────────────────────────────────────────

  /** Snapshot for the persist layer. Returns no blocks when nothing changed. */
  saveRequest(): SettingsSaveRequest {
    return { baseline: this.baseline, draft: this.current, blocks: this.dirty() }
  }

  /** Fold a persist result back in: saved blocks become the new baseline. */
  commitSaved(result: SettingsSaveResult): void {
    if (result.saved.length > 0) {
      const originalFrontend = this.baseline.frontend
      const pendingFrontend = !result.saved.includes('frontend') && this.dirty().includes('frontend') ? this.current.frontend : undefined
      this.baseline = result.persisted ?? this.current
      if (pendingFrontend && !result.persisted) this.baseline = { ...this.baseline, frontend: originalFrontend }
      this.current = this.baseline
      if (pendingFrontend) this.current = { ...this.current, frontend: pendingFrontend }
    }
    const parts: string[] = []
    if (result.saved.length > 0) parts.push(`已保存 ${result.saved.length} 项：${result.saved.join(', ')}`)
    if (result.errors.length > 0) parts.push(`失败：${result.errors.join('；')}`)
    if (parts.length === 0) parts.push('没有改动，未写入')
    this.status = parts.join(' · ')
    this.error = result.errors.length > 0 ? result.errors[0] : undefined
    this.mode = 'browse'
  }

  // ── internals ──────────────────────────────────────────────

  private setCategory(index: number): void {
    const categories = buildCategories(this.current, this.env)
    const next = Math.min(Math.max(0, categories.length - 1), Math.max(0, index))
    if (next !== this.catIndex) {
      this.catIndex = next
      this.fieldIndex = 0
    }
  }

  private fieldCount(): number {
    return this.visibleFields().length
  }

  private activeField(): SettingsField | undefined {
    return this.visibleFields()[this.fieldIndex]
  }

  private visibleFields(): SettingsField[] {
    const categories = buildCategories(this.current, this.env)
    const query = this.query.trim().toLocaleLowerCase()
    if (!query) return categories[this.catIndex]?.fields ?? []
    return categories.flatMap(cat => cat.fields.filter(field =>
      [cat.label, field.id, field.label, field.hint ?? '', field.display(this.current, this.env)]
        .join(' ').toLocaleLowerCase().includes(query),
    ))
  }

  private pickerOptions(): SettingsOption[] {
    const field = this.activeField()
    return field?.options?.(this.current, this.env) ?? []
  }

  private commitPicker(): void {
    const field = this.activeField()
    const option = this.pickerOptions()[this.pickerIndex]
    if (!field || !option) {
      this.mode = 'browse'
      return
    }
    this.applyValue(field, option.id)
    if (!this.error) this.mode = 'browse'
  }

  private commitEditor(): void {
    const field = this.activeField()
    if (!field) {
      this.mode = 'browse'
      return
    }
    this.applyValue(field, this.buffer)
    if (!this.error) {
      this.mode = 'browse'
      this.buffer = ''
    }
  }

  private applyValue(field: SettingsField, value: string): void {
    const next = field.apply?.(this.current, value)
    if (!next) return
    if ('error' in next) {
      this.error = next.error
      return
    }
    this.current = next
    this.error = undefined
  }

  private isFieldDirty(field: SettingsField): boolean {
    return field.display(this.baseline, this.env) !== field.display(this.current, this.env)
  }
}
