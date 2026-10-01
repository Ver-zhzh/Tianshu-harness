import { COMMAND_CATALOG } from '../command-catalog.js'
import type { FrontendPreferences } from '../frontend-preferences.js'
import { getKeybindingRows } from '../keybindings.js'
import type { RivetTheme } from '../theme.js'
import type { KeyPress } from './input-handler.js'
import { color } from './ansi.js'
import { frameLine, frameInset, frameHintRows } from '../format/overlay-frame.js'
import { panelHeader, panelSearch } from '../format/panel-layout.js'
import { displayWidth, truncateToDisplayWidth } from '../width.js'
import { wrapReadingText } from '../format/reading-layout.js'

interface HelpEntry { label: string; text: string; command?: string }
export class HelpPanel {
  private tab = 0
  private selected = 0
  private query = ''
  private searching = false
  private detail?: HelpEntry
  private offset = 0
  constructor(private preferences: () => Readonly<FrontendPreferences>, private theme: () => RivetTheme, private close: () => void, private fill: (text: string) => void) {}
  onActivate(): void { this.tab = 0; this.selected = 0; this.query = ''; this.searching = false; this.detail = undefined; this.offset = 0 }
  paste(text: string): void { if (this.searching) { this.query += text.replace(/[\r\n]/g, ' '); this.selected = 0 } }
  private entries(): HelpEntry[] {
    const bindings = getKeybindingRows(this.preferences() as FrontendPreferences)
    const key = (value: string) => value.replace(/^ctrl_/, 'Ctrl+').replace(/^alt_/, 'Alt+').replace(/[a-z]$/, letter => letter.toUpperCase())
    let rows: HelpEntry[]
    if (this.tab === 2) rows = bindings.map(row => ({ label: `${row.key ? key(row.key) : '—'}  ${row.label}`, text: `${row.label}\n${row.command}\n焦点：对话${row.custom ? ' · 自定义' : ''}${row.aliases.length ? '\n兼容：' + row.aliases.map(key).join('、') : ''}` }))
    else if (this.tab === 1) rows = COMMAND_CATALOG.filter(row => !row.displayOnly).map(row => ({ label: `${row.name}  ${row.description}`, text: `${row.name}${row.argsHint ? ' ' + row.argsHint : ''}\n\n${row.description}`, command: row.name }))
    else rows = [
      { label: '输入与发送', text: `当前输入方式：${this.preferences().inputMode === 'multiline' ? '多行' : '单行'}\nCtrl+J 换行；发送方式以输入底栏为准。\nCtrl+C 停止当前任务；菜单返回后草稿与附件保留。` },
      ...['/model', '/settings', '/permission', '/theme', '/resume'].map(name => { const row = COMMAND_CATALOG.find(item => item.name === name)!; const labels: Record<string, string> = { '/model': '选择模型', '/settings': '调整设置', '/permission': '管理权限', '/theme': '选择外观', '/resume': '恢复会话' }; return { label: `${row.name}  ${labels[name]}`, text: row.description, command: row.name } }),
      ...bindings.filter(row => row.action === 'history' || row.action === 'tasks').map(row => ({ label: `${row.key ? key(row.key) : row.command}  ${row.label}`, text: `${row.label}\n${row.command}`, command: row.command })),
    ]
    const query = this.query.toLowerCase()
    return rows.filter(row => (row.label + row.text).toLowerCase().includes(query))
  }
  handleKey(key: KeyPress): boolean {
    if (key.name === 'ctrl_c') { this.close(); return true }
    if (key.name === 'escape') {
      if (this.detail) { this.detail = undefined; this.offset = 0 }
      else if (this.searching || this.query) { this.searching = false; this.query = ''; this.selected = 0 }
      else this.close()
      return true
    }
    if (this.detail) {
      if (key.char === 'i' && this.detail.command && !key.ctrl && !key.meta) { const command = this.detail.command; this.close(); this.fill(command + ' ') }
      if (key.name === 'down' || key.name === 'pagedown') this.offset += key.name === 'down' ? 1 : 5
      if (key.name === 'up' || key.name === 'pageup') this.offset = Math.max(0, this.offset - (key.name === 'up' ? 1 : 5))
      return true
    }
    if (key.name === 'return') { this.detail = this.entries()[this.selected]; this.searching = false; this.offset = 0; return true }
    if (this.searching) {
      if (key.name === 'backspace') this.query = Array.from(this.query).slice(0, -1).join('')
      else if (key.char && !key.ctrl && !key.meta) this.query += key.char
      if (key.char || key.name === 'backspace') this.selected = 0
    } else if (key.char === '/') { this.searching = true; this.query = ''; this.selected = 0; return true }
    else if (key.name === 'right' || key.name === 'left' || key.name === 'tab') { this.tab = (this.tab + (key.name === 'left' || key.shift ? 2 : 1)) % 3; this.query = ''; this.selected = 0; return true }
    const count = this.entries().length
    if (key.name === 'up') this.selected = Math.max(0, this.selected - 1)
    if (key.name === 'down') this.selected = Math.min(Math.max(0, count - 1), this.selected + 1)
    return true
  }
  render(width: number, height: number): string[] {
    const theme = this.theme()
    const footer = frameHintRows(this.detail ? (this.detail.command ? [['i', '回填草稿'], ['↑↓', '滚动'], ['Esc', '返回']] : [['↑↓', '滚动'], ['Esc', '返回']]) : [['←→', '页签'], ['/', '搜索'], ['↑↓', '选择'], ['Enter', '详情'], ['Esc', '返回']], width, theme)
    const top = panelHeader('帮助', ['概览', '命令', '快捷键'], this.tab, width, theme)
    const contentWidth = Math.max(1, width - frameInset(width) * 2)
    if (height >= 18) top.push(frameLine('', width, theme))
    if (this.detail) top.push(frameLine(color('详情 · i 回填后由你发送', theme.muted), width, theme))
    else if (height >= 18 && (this.tab !== 0 || this.searching || this.query)) top.push(...panelSearch(this.query, this.searching, '/ 搜索命令或快捷键', width, theme), frameLine('', width, theme))
    else if (this.searching || this.query) top.push(frameLine(`搜索：${this.query}▏`, width, theme))
    else if (this.tab === 0 && height >= 24) {
      const keyRows = getKeybindingRows(this.preferences() as FrontendPreferences).filter(row => row.key)
      const keys = keyRows.map(row => `${row.key!.replace(/^ctrl_/, 'Ctrl+').replace(/^alt_/, 'Alt+').replace(/[a-z]$/, letter => letter.toUpperCase())}  ${row.label}`)
      const columns = width >= 100 ? 3 : width >= 72 ? 2 : 1, cellWidth = Math.floor(contentWidth / columns)
      const overview = ['直接描述任务，让天枢协助你阅读、编写与验证代码。', '', '常用快捷键']
      for (let i = 0; i < keys.length; i += columns) overview.push(keys.slice(i, i + columns).map(text => { const clipped = truncateToDisplayWidth(text, cellWidth - 2); return clipped + ' '.repeat(Math.max(0, cellWidth - displayWidth(clipped))) }).join(''))
      overview.push('', '常用入口')
      top.push(...overview.map(row => frameLine(color(row, theme.secondary), width, theme)))
    }
    const budget = Math.max(1, height - top.length - footer.length)
    let body: string[]
    if (this.detail) { const rows = wrapReadingText(this.detail.text, Math.max(1, width - 4)); this.offset = Math.min(this.offset, Math.max(0, rows.length - budget)); body = rows.slice(this.offset, this.offset + budget) }
    else { const entries = this.entries(); const start = Math.max(0, Math.min(this.selected - budget + 1, entries.length - budget)); body = entries.slice(start, start + budget).map((row, i) => color(`${start + i === this.selected ? '❯' : ' '} ${row.label}`, start + i === this.selected ? theme.primary : theme.muted)); if (!body.length) body = ['没有匹配结果；Esc 清除搜索'] }
    const gap = top.length + body.length + footer.length < height ? [frameLine('', width, theme)] : []
    return [...top, ...body.map(row => frameLine(row, width, theme)), ...gap, ...footer].slice(0, height)
  }
}
