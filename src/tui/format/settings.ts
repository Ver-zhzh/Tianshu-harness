/**
 * `/config` 设置面板渲染 —— 分类页签、搜索与对齐字段。
 *
 * 复用 overlay-frame 的框线原语；所有宽度计算走 `stringWidth` / display width，
 * 不用 `.length`（CJK 标签占 2 格，用 length 会把右边框顶歪）。
 */

import { panelHeader, panelSearch } from './panel-layout.js'
import { wrapReadingText } from './reading-layout.js'
import stringWidth from 'string-width'
import { color } from '../engine/ansi.js'
import { truncateToDisplayWidth } from '../width.js'
import type { RivetTheme } from '../theme.js'
import type { SettingsView } from '../settings-flow.js'
import {
  frameInset,
  frameLine,
  frameHintRows,
  CURSOR,
} from './overlay-frame.js'

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

const EFFECT_LABEL: Record<SettingsView['fields'][number]['effect'], string> = {
  immediate: '即时',
  'next-session': '下次会话',
  'next-startup': '下次启动',
}

/** 定宽单元格：先按显示宽度截断，再右填充到 w。 */
function cell(text: string, w: number): string {
  if (w <= 0) return ''
  const clipped = truncateToDisplayWidth(text, w)
  return clipped + ' '.repeat(Math.max(0, w - stringWidth(clipped)))
}

/**
 * 计算可见窗口 —— 选中项始终在窗口内，列表比窗口短时不滚动。
 */
function windowStart(index: number, count: number, rows: number): number {
  if (count <= rows || rows <= 0) return 0
  const half = Math.floor(rows / 2)
  return Math.max(0, Math.min(count - rows, index - half))
}

export function renderSettings(view: SettingsView, width: number, height: number, theme: RivetTheme): string[] {
  if (width <= 0 || height <= 0) return []
  const dirty = view.dirtyBlocks.length
  const title = dirty ? `设置 · ${dirty} 项未保存` : '设置'
  const footer = frameHintRows(footerActions(view), width, theme)
  const contentWidth = Math.max(0, width - frameInset(width) * 2)
  if (height < footer.length + 4) return [frameLine(title, width, theme), ...footer].slice(0, height)
  const lines = panelHeader(title, view.categories.map(category => category.label + (category.dirty ? '*' : '')), view.categoryIndex, width, theme)
  if (height >= 18) lines.push(frameLine('', width, theme), ...panelSearch(view.query ?? '', view.mode === 'search', '/ 搜索全部设置', width, theme), frameLine('', width, theme))
  else if (view.mode === 'search' || view.query) lines.push(frameLine(`搜索：${view.query ?? ''}▏`, width, theme))
  const budget = Math.max(1, height - lines.length - footer.length - (height >= 18 ? 3 : 2))
  let body: string[]
  if (view.mode === 'browse' && view.focus === 'categories' && width < 64 && !view.query) {
    const start = windowStart(view.categoryIndex, view.categories.length, budget)
    body = view.categories.slice(start, start + budget).map((category, i) => color(`${start + i === view.categoryIndex ? CURSOR : ' '} ${category.label}${category.dirty ? ' *' : ''}`, start + i === view.categoryIndex ? theme.primary : theme.secondary))
  } else body = buildRightRows(view, contentWidth, theme, budget)
  while (body.length && !body.at(-1)?.trim()) body.pop()
  lines.push(...body.map(row => frameLine(row, width, theme)))
  if (lines.length + footer.length + 2 <= height) lines.push(frameLine('', width, theme))
  const status = wrapReadingText(statusLine(view, Number.MAX_SAFE_INTEGER, theme), contentWidth)
  lines.push(...status.slice(0, Math.max(1, Math.min(2, height - lines.length - footer.length))).map(row => frameLine(row, width, theme)), ...footer)
  return lines.slice(0, height)
}

/** 右栏内容：字段列表 / 枚举选择列表 / 文本编辑缓冲 / 退出确认。 */
function buildRightRows(view: SettingsView, rightW: number, theme: RivetTheme, rows: number): string[] {
  const out: string[] = []
  const pad = (body: string): string => ` ${body}`

  if (view.mode === 'confirm-discard') {
    out.push(pad(color(cell(`有 ${view.dirtyBlocks.length} 项改动未保存`, rightW - 1), theme.warning, { bold: true })))
    out.push(pad(color(cell('Enter 放弃并退出 · Esc 回去继续改 · S 保存', rightW - 1), theme.muted)))
  } else if (view.picker) {
    const { options, index, label } = view.picker
    out.push(pad(color(cell(label, rightW - 1), theme.secondary, { bold: true })))
    const listSpace = Math.max(1, rows - 1)
    const start = windowStart(index, options.length, listSpace)
    for (let i = 0; i < listSpace; i++) {
      const opt = options[start + i]
      if (!opt) break
      const selected = start + i === index
      const cursor = selected ? color(CURSOR, theme.primary, { bold: true }) : ' '
      const text = cell(opt.label, Math.max(0, rightW - 4))
      out.push(pad(`${cursor} ${color(text, selected ? theme.primary : theme.secondary, selected ? { bold: true } : {})}`))
    }
  } else if (view.editor) {
    out.push(pad(color(cell(view.editor.label, rightW - 1), theme.secondary, { bold: true })))
    const cursor = color('▏', theme.primary, { bold: true })
    const budget = Math.max(0, rightW - 5)
    let buffer = ''
    let used = 0
    const glyphs = Array.from(graphemes.segment(view.editor.buffer), part => part.segment)
    for (const glyph of glyphs.reverse()) {
      const width = stringWidth(glyph)
      if (used + width > budget) break
      buffer = glyph + buffer
      used += width
    }
    out.push(pad(`${color('>', theme.primary, { bold: true })} ${color(buffer, theme.secondary)}${cursor}`))
  } else {
    if (view.query && view.fields.length === 0) out.push(pad(color(cell('没有匹配的设置', rightW - 1), theme.muted)))
    const start = windowStart(view.fieldIndex, view.fields.length, rows)
    // 三列预算必须严格加和到 rightW —— 早期版本对每列各设下限（max(6,…)），
    // 窄终端下下限之和超过 rightW，行宽溢出把右边框顶到下一行。
    const budget = Math.max(0, rightW - 3) // 前导空格 + 游标 + 脏标记
    const effectW = budget >= 24 ? 8 : 0 // 太窄时收起「生效时机」列，提示行仍会说
    const rest = Math.max(0, budget - effectW - 1) // -1 = 标签与取值之间的间隔
    const valueW = Math.min(30, Math.floor(rest / 2))
    const labelW = Math.max(0, rest - valueW)
    for (let i = 0; i < rows; i++) {
      const field = view.fields[start + i]
      if (!field) break
      const selected = start + i === view.fieldIndex
      const focused = selected && view.focus === 'fields'
      const cursor = focused ? color(CURSOR, theme.primary, { bold: true }) : ' '
      const mark = field.dirty ? color('*', theme.warning) : ' '
      const label = color(cell(field.label, labelW), focused ? theme.primary : theme.secondary, focused ? { bold: true } : {})
      const value = color(cell(field.value, valueW), field.dirty ? theme.warning : theme.muted)
      const effect = effectW > 0 ? color(cell(EFFECT_LABEL[field.effect], effectW), theme.dim) : ''
      out.push(pad(`${cursor}${mark}${label} ${value}${effect}`))
    }
  }

  while (out.length < rows) out.push(cell('', rightW))
  return out.slice(0, rows)
}

function statusLine(view: SettingsView, budget: number, theme: RivetTheme): string {
  if (view.error) return color(truncateToDisplayWidth(`✗ ${view.error}`, budget), theme.error)
  if (view.status) return color(truncateToDisplayWidth(view.status, budget), theme.success)
  if (view.mode === 'search') return color(truncateToDisplayWidth(`搜索全部分类 · ${view.fields.length} 项匹配 · Enter 查看结果 · Esc 取消搜索`, budget), theme.muted)
  const field = view.fields[view.fieldIndex]
  const hint = view.editor?.hint ?? field?.hint
  const scope = `用户默认${field ? ` · ${EFFECT_LABEL[field.effect]}` : ''}`
  if (hint) return color(truncateToDisplayWidth(`${scope} · ${hint}`, budget), theme.muted)
  // 无 hint 兜底：说明面板用途 + 生效语义，比一句干巴巴的路径更有用。
  const cat = view.categories[view.categoryIndex]
  const catName = cat ? cat.label : '当前分类'
  return color(truncateToDisplayWidth(`${scope} · ${catName}`, budget), theme.dim)
}

function footerActions(view: SettingsView): [string, string][] {
  switch (view.mode) {
    case 'confirm-discard':
      return [['Enter', '放弃退出'], ['S', '保存'], ['Esc', '继续编辑']]
    case 'picker':
      return [['↑↓', '选择'], ['Enter', '确认'], ['Esc', '返回']]
    case 'editor':
      return [['Enter', '提交'], ['Ctrl-U', '清空'], ['Esc', '返回']]
    case 'search':
      return [['↑↓', '结果'], ['Enter', '查看'], ['Ctrl-U', '清空'], ['Esc', '取消搜索']]
    case 'browse':
      return [['↑↓', '移动'], ...(view.query ? [] : [['Tab', '分类/字段']] as [string, string][]), ['Enter', view.focus === 'categories' ? '查看字段' : '编辑'], ['/', '搜索'], ['Ctrl+S', '保存'], ['Esc', view.query ? '取消搜索' : '退出']]
  }
}
