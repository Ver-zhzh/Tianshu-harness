/**
 * ask_user_question 的 Tab 化面板渲染。
 *
 * 交互模型（对齐截图式多题表单）：
 * - 顶部 Tab 条：每题一个 Tab（已答题加 ✓）+ 末尾「提交」Tab，←/→ 自由切换，
 *   不再强制线性答题、答完即自动提交。
 * - 题页：编号选项行（多选带 [ ]/[x]）+ 光标行；末两行固定为
 *   「输入自定义回答…」（Other 输入子模式）与「在输入框中讨论」（= Esc 关闭面板）。
 * - 提交页（Submit Tab）：Review your answers——逐题列出 问题 → 答案
 *   （未答标「将跳过」），用户显式选「提交回答」才组串发出。
 *
 * 只负责渲染；状态机（Tab 切换 / 答题 / 提交）在 engine/app.ts 的 pendingAskFlow。
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import { ambiguousWideEnabled, displayWidth, hardWrapToDisplayWidth, truncateToDisplayWidth } from '../width.js'
import {
  frameTop,
  frameBottom,
  frameLine,
  frameDivider,
  frameHintRows,
  CURSOR,
} from './overlay-frame.js'
import { followListWindow } from './overlay.js'

/** 题页末尾两个固定功能行的文案（行序与 app.ts 键分发一致，改动需同步）。 */
export const ASK_OTHER_ROW_LABEL = '输入自定义回答…'
export const ASK_CHAT_ROW_LABEL = '在输入框中讨论（关闭面板）'
/** 提交页两个动作行。 */
export const ASK_SUBMIT_ROW_LABEL = '提交回答'
export const ASK_CANCEL_ROW_LABEL = '取消'

export interface AskPanelTab {
  /** 题面截断后的短标签。 */
  label: string
  /** 该题是否已有有效答案（选中项或自定义文本）。 */
  answered: boolean
}

export interface AskReviewEntry {
  prompt: string
  /** draftToAnswer 组出的答案；null = 未答（提交时跳过）。 */
  answer: string | null
}

export interface AskQuestionPanelData {
  tabs: AskPanelTab[]
  /** 当前 Tab：0..tabs.length-1 为题页；=== tabs.length 为提交页。 */
  activeTab: number
  /** 题页字段（activeTab < tabs.length 时有效）。 */
  prompt: string
  allowMultiple: boolean
  options: string[]
  /** 多选已勾选项下标。 */
  selected: number[]
  /** 光标行（题页：0..options.length+1；提交页：0=提交 / 1=取消）。 */
  cursor: number
  inputSubMode?: {
    active: boolean
    label: string
    placeholder: string
    value: string
    /** 光标位（value 内 UTF-16 偏移）；缺省 = 末尾。 */
    cursorPos?: number
  }
  /** 提交页字段：逐题答案汇总。 */
  review: AskReviewEntry[]
  /** 硬件光标落点（输入子模式渲染方回填——与 connect/choice-panel 同款）。 */
  caret?: { row: number; col: number } | null
}

/** 题页行数 = 选项数 + 2（Other 行 + 讨论行）。 */
export function askQuestionRowCount(data: Pick<AskQuestionPanelData, 'options'>): number {
  return data.options.length + 2
}

function wrapText(text: string, width: number): string[] {
  const out = text.split('\n').flatMap(line => hardWrapToDisplayWidth(line, Math.max(1, width), { ambiguousAsWide: ambiguousWideEnabled() }))
  return out.length > 0 ? out : ['']
}

/** Tab 条跟随活动题，已答题带 ✓；窄屏保留当前题与位置。 */
function renderTabBar(data: AskQuestionPanelData, width: number, theme: RivetTheme): string {
  const segments: { label: string; active: boolean; answered: boolean }[] = data.tabs.map((t, i) => ({
    label: t.label,
    active: i === data.activeTab,
    answered: t.answered,
  }))
  segments.push({ label: '提交', active: data.activeTab === data.tabs.length, answered: false })

  const labelBudget = Math.max(12, Math.floor((width - 9 - segments.length * 2) / segments.length))
  const labels = segments.map(seg => {
    const mark = seg.answered ? '✓ ' : ''
    return `${mark}${truncateToDisplayWidth(seg.label, labelBudget - displayWidth(mark))}`
  })
  const active = Math.min(Math.max(data.activeTab, 0), segments.length - 1)
  let start = 0
  let end = segments.length
  let position = ''
  if (displayWidth(labels.join('  ')) > width - 9) {
    position = ` ${active + 1}/${segments.length}`
    const budget = Math.max(4, width - 13 - displayWidth(position))
    start = active
    end = active + 1
    while (start > 0 || end < segments.length) {
      if (start > 0 && displayWidth(labels.slice(start - 1, end).join('  ')) <= budget) start--
      else if (end < segments.length && displayWidth(labels.slice(start, end + 1).join('  ')) <= budget) end++
      else break
    }
  }
  const parts = segments.slice(start, end).map((seg, i) => seg.active ? color(labels[start + i]!, theme.primary, { bold: true }) : color(labels[start + i]!, theme.dim))
  const bar = `${color(`← ${start ? '… ' : ''}`, theme.dim)}${parts.join('  ')}${color(`${end < segments.length ? ' …' : ''} →${position}`, theme.dim)}`
  return frameLine(` ${bar}`, width, theme)
}

/** 编号选项行：`> 2. [x] 选项文本`。checkbox 为 null 时不渲染方框（功能行/单选）。 */
function renderOptionRow(
  index: number,
  label: string,
  checkbox: boolean | null,
  cursor: boolean,
  width: number,
  theme: RivetTheme,
): string {
  const cursorGlyph = cursor ? color(CURSOR, theme.primary, { bold: true }) : ' '
  const box = checkbox === null ? '' : checkbox ? '[x] ' : '[ ] '
  const prefix = `${index + 1}. ${box}`
  const budget = Math.max(1, width - 6 - displayWidth(prefix) - 2)
  const truncated = truncateToDisplayWidth(label, budget)
  const text = cursor
    ? color(`${prefix}${truncated}`, theme.primary, { bold: true })
    : color(`${prefix}${truncated}`, theme.secondary)
  return frameLine(` ${cursorGlyph} ${text}`, width, theme)
}

export function renderAskQuestionPanel(data: AskQuestionPanelData, width: number, height: number, theme: RivetTheme): string[] {
  const lines: string[] = []
  data.caret = null
  const innerWidth = width - 6
  const onSubmitTab = data.activeTab >= data.tabs.length

  lines.push(frameTop(width, theme))
  lines.push(renderTabBar(data, width, theme))
  lines.push(frameDivider(width, theme))

  if (!onSubmitTab) {
    const inputSubMode = data.inputSubMode?.active ? data.inputSubMode : undefined
    const hints: Array<[string, string]> = inputSubMode ? [['Enter', '提交'], ['Esc', '返回选项']] : [['↑↓', '移动']]
    if (!inputSubMode) {
      if (data.tabs.length > 1) hints.unshift(['←→', '切换'])
      if (data.allowMultiple) hints.push(['空格', '多选'])
      hints.push(['Enter', '确认'], ['Esc', '取消'])
    }
    const footer = frameHintRows(hints, width, theme)
    const promptBudget = Math.max(1, Math.min(3, height - lines.length - footer.length - (inputSubMode ? 2 : 0) - 3))
    const promptLines = wrapText(data.prompt, innerWidth).slice(0, promptBudget)
    for (const p of promptLines) {
      lines.push(frameLine(`  ${color(p, theme.secondary)}`, width, theme))
    }
    lines.push(frameLine('', width, theme))

    const contentBudget = Math.max(1, height - lines.length - footer.length - (inputSubMode ? 2 : 0) - 1)
    const labels = [...data.options, ASK_OTHER_ROW_LABEL, ASK_CHAT_ROW_LABEL]
    const start = followListWindow(data.cursor, labels.length, contentBudget)
    let rows = 0
    for (let i = start; i < labels.length && rows < contentBudget; i++, rows++) {
      const checked = i < data.options.length && data.allowMultiple ? data.selected.includes(i) : null
      lines.push(renderOptionRow(i, labels[i]!, checked, data.cursor === i, width, theme))
    }
    while (rows < contentBudget) {
      lines.push(frameLine('', width, theme))
      rows++
    }

    if (inputSubMode) {
      lines.push(frameLine(` ${color(inputSubMode.label, theme.muted)}`, width, theme))
      // 光标是硬件 caret（格边界、零占位），与 connect/choice-panel 同款——行内不画字形。
      // 超宽窗口化：光标前缀超出可视宽时从行首丢弃（尾部锚定），保光标可见。
      const value = inputSubMode.value
      const pos = Math.min(Math.max(inputSubMode.cursorPos ?? value.length, 0), value.length)
      const max = Math.max(1, width - 8)
      let start = 0
      while (start < pos && displayWidth(value.slice(start, pos)) > max - 1) {
        start += value.codePointAt(start)! > 0xffff ? 2 : 1
      }
      let visible = value.slice(start)
      if (displayWidth(visible) > max) visible = truncateToDisplayWidth(visible, max)
      const shown = visible.length > 0
        ? color(visible, theme.secondary)
        : color(inputSubMode.placeholder, theme.dim)
      data.caret = { row: lines.length + 1, col: 5 + displayWidth(value.slice(start, pos)) }
      lines.push(frameLine(` ${color(CURSOR, theme.primary, { bold: true })} ${shown}`, width, theme))
    }
    lines.push(...footer)
    lines.push(frameBottom(width, theme))
    return lines
  }

  const footer = frameHintRows([['←→', '切换'], ['↑↓', '移动'], ['Enter', '确认'], ['Esc', '取消']], width, theme)
  lines.push(frameLine(`  ${color('确认你的回答', theme.warning, { bold: true })}`, width, theme))
  const answered = data.review.filter(entry => entry.answer).length
  const unanswered = data.review.length - answered
  lines.push(frameLine(`  ${color(`已答 ${answered}/${data.review.length}${unanswered ? ` · 未答 ${unanswered} 题将跳过` : ''}`, theme.muted)}`, width, theme))
  const reviewBudget = Math.max(0, height - lines.length - footer.length - 3)
  let used = 0
  data.review.forEach((entry, i) => {
    if (used + 2 > reviewBudget) return
    const q = truncateToDisplayWidth(entry.prompt.replace(/\s+/g, ' ').trim(), innerWidth - 4)
    lines.push(frameLine(`  ${color(`${i + 1}. ${q}`, theme.secondary)}`, width, theme))
    const answerLine = entry.answer
      ? color(`→ ${truncateToDisplayWidth(entry.answer, innerWidth - 6)}`, theme.success)
      : color('→ （未答，将跳过）', theme.muted)
    lines.push(frameLine(`    ${answerLine}`, width, theme))
    used += 2
  })
  const actions = [ASK_SUBMIT_ROW_LABEL, ASK_CANCEL_ROW_LABEL]
  actions.forEach((label, i) => {
    const cursor = data.cursor === i
    const cursorGlyph = cursor ? color(CURSOR, theme.primary, { bold: true }) : ' '
    const text = cursor
      ? color(`${i + 1}. ${label}`, theme.primary, { bold: true })
      : color(`${i + 1}. ${label}`, theme.secondary)
    lines.push(frameLine(` ${cursorGlyph} ${text}`, width, theme))
  })
  lines.push(...footer)
  lines.push(frameBottom(width, theme))
  return lines
}
