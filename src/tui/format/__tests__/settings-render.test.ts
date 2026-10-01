/**
 * renderSettings 测试：左右分栏在窄/矮终端下的行数与宽度钳制。
 *
 * OverlayEngine 用定长网格绘制——行数超 height 会静默截掉页脚，行宽超 columns
 * 会把右边框顶到下一行。CJK 标签（「审查子代理」占 10 格）是这里最容易踩的坑，
 * 故断言 stripAnsi 后的**显示宽度**恒等于 width，而非字符数。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import stringWidth from 'string-width'
import { renderSettings } from '../settings.js'
import { getTheme } from '../../theme.js'
import type { SettingsView } from '../../settings-flow.js'

const theme = getTheme()
const stripAnsi = (s: string): string => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')

function baseView(overrides: Partial<SettingsView> = {}): SettingsView {
  return {
    mode: 'browse',
    focus: 'categories',
    categories: [
      { id: 'workers', label: '子代理', dirty: false },
      { id: 'review', label: '审查子代理', dirty: true },
      { id: 'vision', label: '识图模型', dirty: false },
      { id: 'basics', label: '基础', dirty: false },
      { id: 'net', label: '网络与镜像', dirty: false },
    ],
    categoryIndex: 0,
    fields: [
      { id: 'workers.routing.code_edit', label: '路由 code_edit', value: 'cheap-flash', kind: 'enum', effect: 'next-session', dirty: false },
      { id: 'workers.patcherTier', label: '天梁 patcher 档位', value: 'cheap', kind: 'enum', effect: 'next-session', dirty: true },
      { id: 'agent.approval', label: '审批模式', value: 'auto-safe', kind: 'enum', effect: 'immediate', dirty: false },
    ],
    fieldIndex: 0,
    dirtyBlocks: ['review'],
    ...overrides,
  }
}

function assertGrid(lines: string[], width: number, height: number): void {
  assert.ok(lines.length <= height, `行数不得超出 ${height}，实际 ${lines.length}`)
  for (const [i, line] of lines.entries()) {
    assert.equal(stringWidth(stripAnsi(line)), width, `第 ${i} 行显示宽度应为 ${width}：${JSON.stringify(stripAnsi(line))}`)
  }
}

describe('renderSettings — 网格钳制', () => {
  it('常规终端下行数与行宽都精确', () => {
    const lines = renderSettings(baseView(), 100, 24, theme)
    assertGrid(lines, 100, 24)
  })

  it('矮终端（10 行）不溢出，页脚仍在最后两行之内', () => {
    const lines = renderSettings(baseView(), 80, 10, theme)
    assertGrid(lines, 80, 10)
    assert.match(lines.map(stripAnsi).join('\n'), /Esc/)
  })

  it('极矮终端（6 行）仍返回完整框体', () => {
    const lines = renderSettings(baseView(), 60, 6, theme)
    assertGrid(lines, 60, 6)
  })

  it('窄终端（40 列）左栏收缩但不破框', () => {
    const lines = renderSettings(baseView(), 40, 20, theme)
    assertGrid(lines, 40, 20)
  })

  it('字段行很多时按窗口滚动，选中项保持可见', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: `f${i}`,
      label: `字段 ${i}`,
      value: `值 ${i}`,
      kind: 'text' as const,
      effect: 'next-session' as const,
      dirty: false,
    }))
    const lines = renderSettings(baseView({ fields: many, fieldIndex: 37, focus: 'fields' }), 100, 20, theme)
    assertGrid(lines, 100, 20)
    assert.ok(lines.some(l => stripAnsi(l).includes('字段 37')), '选中字段应在可见窗口内')
  })

  it('CJK 分类页签与搜索边框按显示宽度对齐', () => {
    const lines = renderSettings(baseView(), 100, 24, theme)
    assertGrid(lines, 100, 24)
    assert.ok(lines[1]!.includes('\x1b[7m'), 'active category has a reverse badge')
    const search = lines.map(stripAnsi).find(line => line.includes('│'))!
    assert.equal(stringWidth(search.slice(0, search.indexOf('│'))), 2)
    assert.equal(stringWidth(search.slice(0, search.lastIndexOf('│'))), 97)
  })

  it('未保存计数出现在标题栏', () => {
    const lines = renderSettings(baseView({ dirtyBlocks: ['review', 'workers'] }), 100, 24, theme)
    assert.match(stripAnsi(lines[1]!), /2 项未保存/)
  })

  it('picker 模式渲染选项列表并按快捷键提示切换页脚', () => {
    const view = baseView({
      mode: 'picker',
      focus: 'fields',
      picker: {
        label: '工具档位',
        options: [{ id: 'minimal', label: 'minimal — 27 个工具' }, { id: 'full', label: 'full — 47 个全集' }],
        index: 1,
      },
    })
    const lines = renderSettings(view, 100, 20, theme)
    assertGrid(lines, 100, 20)
    assert.ok(lines.some(l => stripAnsi(l).includes('full — 47 个全集')))
    assert.match(lines.map(stripAnsi).join('\n'), /确认/)
  })

  it('editor 模式渲染输入缓冲，超长内容截断而不破框', () => {
    const view = baseView({
      mode: 'editor',
      focus: 'fields',
      editor: { label: '代理地址', buffer: 'http://127.0.0.1:7890/'.repeat(20) },
    })
    const lines = renderSettings(view, 60, 16, theme)
    assertGrid(lines, 60, 16)
  })

  it('退出确认态提示未保存项数', () => {
    const lines = renderSettings(baseView({ mode: 'confirm-discard' }), 90, 16, theme)
    assertGrid(lines, 90, 16)
    assert.ok(lines.some(l => stripAnsi(l).includes('1 项改动未保存')))
    assert.match(lines.map(stripAnsi).join('\n'), /放弃退出/)
  })

  it('校验错误优先于提示行显示', () => {
    const lines = renderSettings(baseView({ error: '需为不小于 0 的整数' }), 90, 16, theme)
    assertGrid(lines, 90, 16)
    assert.ok(lines.some(l => stripAnsi(l).includes('需为不小于 0 的整数')))
  })

  it('空分类表（数据未就绪）不抛错', () => {
    const lines = renderSettings(baseView({ categories: [], fields: [], dirtyBlocks: [] }), 80, 12, theme)
    assertGrid(lines, 80, 12)
  })
})
