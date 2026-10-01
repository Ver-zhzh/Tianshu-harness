import type { FrontendAction, FrontendPreferences } from './frontend-preferences.js'
export type { FrontendAction } from './frontend-preferences.js'

export interface FrontendActionFact {
  action: FrontendAction
  label: string
  command: string
  standard?: string
  legacy?: string
}

export const FRONTEND_ACTION_FACTS: readonly FrontendActionFact[] = [
  { action: 'history', label: '会话历史', command: '/pager', standard: 'ctrl_o' },
  { action: 'tasks', label: '任务面板', command: '/tasks', standard: 'ctrl_t' },
  { action: 'stash', label: '草稿暂存', command: '/stash', standard: 'ctrl_s' },
  { action: 'freeze', label: '冻结/恢复显示', command: '命令面板：冻结/恢复显示', standard: 'ctrl_q', legacy: 'ctrl_s' },
  { action: 'resume', label: '恢复显示', command: '命令面板：恢复显示', legacy: 'ctrl_q' },
  { action: 'inputHistory', label: '输入历史', command: '输入历史面板', standard: 'ctrl_r', legacy: 'ctrl_r' },
  { action: 'editor', label: '外部编辑', command: '/editor', standard: 'ctrl_g', legacy: 'ctrl_g' },
  { action: 'lastTool', label: '最近工具展开', command: '阅读页：展开工具', legacy: 'ctrl_o' },
  { action: 'thinking', label: '思考详情', command: '/thinking', legacy: 'ctrl_t' },
  { action: 'imagePaste', label: '图片粘贴', command: '/paste', standard: 'ctrl_v', legacy: 'ctrl_v' },
]

export interface KeybindingRow {
  action: FrontendAction
  label: string
  key?: string
  command: string
  custom: boolean
  focus: 'chat'
  aliases: string[]
}

export function getKeybindingRows(prefs: FrontendPreferences): KeybindingRow[] {
  return FRONTEND_ACTION_FACTS.map(fact => {
    const custom = Object.hasOwn(prefs.bindings, fact.action)
    const windowsPaste = fact.action === 'imagePaste' && !custom && prefs.keymap === 'standard' && process.platform === 'win32'
    const key = custom ? prefs.bindings[fact.action] : windowsPaste ? 'alt_v' : fact[prefs.keymap]
    return {
      action: fact.action, label: fact.label, key, command: fact.command, custom, focus: 'chat',
      aliases: windowsPaste ? ['ctrl_v'] : [],
    }
  })
}

// Rebinding stays within control/meta letters. Navigation, send, stop, input editing
// and global function keys remain owned by the app and InputLine.
const RESERVED = new Set(['ctrl_a', 'ctrl_b', 'ctrl_c', 'ctrl_d', 'ctrl_e', 'ctrl_f', 'ctrl_h', 'ctrl_i', 'ctrl_j', 'ctrl_k', 'ctrl_l', 'ctrl_m', 'ctrl_n', 'ctrl_p', 'ctrl_u', 'ctrl_w', 'ctrl_x', 'ctrl_y', 'ctrl_z', 'alt_w', 'alt_y'])

export function validateBindings(bindings: FrontendPreferences['bindings'], keymap: FrontendPreferences['keymap']): string[] {
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) return ['快捷键绑定必须为对象']
  const errors: string[] = []
  for (const [action, key] of Object.entries(bindings)) {
    if (!FRONTEND_ACTION_FACTS.some(fact => fact.action === action)) errors.push(`未知动作：${action}`)
    if (typeof key !== 'string' || !/^(ctrl|alt)_[a-z]$/.test(key) || RESERVED.has(key)) errors.push(`不可绑定：${String(key)}`)
  }
  const used = new Map<string, string>()
  for (const row of getKeybindingRows({ keymap, bindings } as FrontendPreferences)) {
    for (const key of [row.key, ...row.aliases]) {
      if (!key) continue
      const previous = used.get(key)
      if (previous) errors.push(`${key} 冲突：${previous} / ${row.label}`)
      else used.set(key, row.label)
    }
  }
  return errors
}

export function resolveFrontendAction(keyName: string, prefs: FrontendPreferences): FrontendAction | undefined {
  return getKeybindingRows(prefs).find(row => row.key === keyName || row.aliases.includes(keyName))?.action
}
