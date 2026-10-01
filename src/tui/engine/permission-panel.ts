import type { PermissionView, PermissionRuleView } from '../permission-view.js'
import { permissionRemovalCommand } from '../permission-view.js'
import type { RivetTheme } from '../theme.js'
import type { KeyPress } from './input-handler.js'
import { color } from './ansi.js'
import { frameLine, frameHintRows } from '../format/overlay-frame.js'
import { panelHeader, panelSearch, numberedChoice } from '../format/panel-layout.js'
import { wrapReadingText } from '../format/reading-layout.js'

interface Entry { label: string; text: string; command?: string; rule?: PermissionRuleView }
interface Form { title: string; value: string; submit: (value: string) => void }
export class PermissionPanel {
  private tab = 0
  private selected = 0
  private query = ''
  private searching = false
  private detail?: Entry
  private offset = 0
  private confirm = ''
  private removing = false
  private form?: Form
  private error = ''
  constructor(private view: () => PermissionView, private theme: () => RivetTheme, private close: () => void, private execute: (command: string) => void, private grant: (path: string, mode: 'read' | 'write') => void) {}
  onActivate(): void { this.tab = 0; this.selected = 0; this.query = ''; this.searching = false; this.detail = undefined; this.form = undefined; this.error = ''; this.offset = 0; this.removing = false; this.confirm = '' }
  private entries(): Entry[] {
    const view = this.view()
    let entries: Entry[]
    if (this.tab === 0) entries = [
      { label: '监督 · 人工确认高风险操作', text: '监督模式\n所有需审批的操作等待你确认。\n确认后保存为本用户默认；当前会话立即生效。', command: '/permission supervise' },
      { label: '自动 · 低风险自动，高风险确认', text: '自动模式\n低/无风险工具自动执行，高风险仍需确认。\n检查点维持现有设置。确认后保存为本用户默认。', command: '/permission auto' },
      { label: '全自动 · 跳过权限确认', text: '全自动风险说明\n所有工具直接执行；无轮次刹车和进度播报。\n沙箱仍拦截项目外写入，Windows 沙箱能力降级。\n可使用 /rollback 与 Git 检查点回滚。\n保存为本用户默认；仅在完全信任任务时使用。\n输入 confirm，再按 Enter 确认。', command: '/permission unattended confirm' },
    ]
    else if (this.tab === 1) entries = view.rules.map(rule => ({ label: `${rule.source === 'config' ? '配置·只读' : '会话'} ${rule.kind}  ${rule.pattern}`, text: `${rule.kind} · ${rule.source === 'config' ? '配置来源，只读' : '仅本次会话'}\n\n${rule.pattern}\n\ndeny 优先于 allow 和模式。配置规则请通过现有配置入口修改。`, rule }))
    else if (this.tab === 2) entries = view.grants.map(item => ({ label: `${item.mode === 'write' ? '读写' : '只读'}  ${item.root}`, text: `${item.root}\n能力：${item.mode === 'write' ? '读写' : '只读'}\n范围：本工作区已记住的授权\n撤销入口：rivet config revoke-dir <路径>。此页面没有撤销接口。` }))
    else entries = [{ label: view.trusted ? '当前项目：已授信' : '当前项目：未授信', text: `工作区：${view.cwd}\n\n未授信时忽略项目安全敏感配置和 hooks。\n授信只对本机生效，独立于目录读写授权。\n${view.trusted ? '撤销后 hooks 即刻停用；安全键下次会话忽略。' : '授信后 hooks 即刻可用；配置安全键下次会话生效。'}\n确认${view.trusted ? '撤销' : '授信'}当前项目？`, command: view.trusted ? '/trust off' : '/trust' }]
    return entries.filter(row => (row.label + row.text).toLowerCase().includes(this.query.toLowerCase()))
  }
  paste(text: string): void { if (this.form) this.form.value += text.replace(/[\r\n]/g, ' '); else if (this.searching) { this.query += text.replace(/[\r\n]/g, ' '); this.selected = 0 } }
  handleKey(key: KeyPress): boolean {
    if (key.name === 'ctrl_c') { this.close(); return true }
    if (key.name === 'escape') {
      if (this.form) this.form = undefined
      else if (this.removing) this.removing = false
      else if (this.detail) { this.detail = undefined; this.confirm = ''; this.offset = 0 }
      else if (this.searching || this.query) { this.searching = false; this.query = ''; this.selected = 0 }
      else this.close()
      this.error = ''; return true
    }
    if (this.form) {
      if (key.name === 'return') this.form.submit(this.form.value.trim())
      else if (key.name === 'backspace') this.form.value = Array.from(this.form.value).slice(0, -1).join('')
      else if (key.char && !key.ctrl && !key.meta) this.form.value += key.char
      return true
    }
    if (this.detail) {
      if (key.name === 'down' || key.name === 'pagedown') this.offset += key.name === 'down' ? 1 : 5
      if (key.name === 'up' || key.name === 'pageup') this.offset = Math.max(0, this.offset - (key.name === 'up' ? 1 : 5))
      if (this.detail.command?.includes('unattended')) {
        if (key.name === 'backspace') this.confirm = this.confirm.slice(0, -1)
        else if (key.char && !key.ctrl && !key.meta) this.confirm += key.char
      } else if (key.char === 'd' && this.detail.rule?.source === 'session') this.removing = true
      if (key.name === 'return') {
        if (this.removing && this.detail.rule) {
          const command = permissionRemovalCommand(this.detail.rule, this.view())
          if (command) { this.close(); this.execute(command) } else this.error = '该规则已变化，请返回重新选择'
        } else if (this.detail.command && (!this.detail.command.includes('unattended') || this.confirm === 'confirm')) { const command = this.detail.command; this.close(); this.execute(command) }
      }
      return true
    }
    if (this.searching) {
      if (key.name === 'backspace') this.query = Array.from(this.query).slice(0, -1).join('')
      else if (key.char && !key.ctrl && !key.meta) this.query += key.char
      if (key.char || key.name === 'backspace') this.selected = 0
    } else {
      if (key.name === 'right' || key.name === 'left' || key.name === 'tab') { this.tab = (this.tab + (key.name === 'left' || key.shift ? 3 : 1)) % 4; this.selected = 0; this.query = ''; return true }
      if (key.char === '/') { this.searching = true; this.query = ''; this.selected = 0; return true }
      if (key.char === 'a' && this.tab === 1) this.form = { title: '新增会话规则：allow|deny <tool> [param=value] 或 bash allow|deny <prefix>', value: '', submit: value => { if (/^(allow|deny)\s+\S+|^bash\s+(allow|deny)\s+\S+/.test(value)) { this.close(); this.execute('/permission ' + value) } else this.error = '请填写完整规则；不会修改配置规则' } }
      if (key.char === 't' && this.tab === 1) this.form = { title: '测试规则：<tool> <JSON input>（不执行工具）', value: '', submit: value => { const split = value.indexOf(' '); try { if (split < 1) throw new Error(); const parsed = JSON.parse(value.slice(split + 1)); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); this.close(); this.execute('/permission test ' + value) } catch { this.error = '需要工具名与 JSON 对象' } } }
      if (key.char === 'a' && this.tab === 2) this.form = { title: '新增目录：read|write <完整路径> · Enter 授权并记住', value: '', submit: value => { const match = /^(read|write)\s+(.+)$/.exec(value); if (match) { this.close(); this.grant(match[2]!, match[1] as 'read' | 'write') } else this.error = '请填写 read 或 write 与目录路径' } }
    }
    const count = this.entries().length
    if (key.name === 'up') this.selected = Math.max(0, this.selected - 1)
    if (key.name === 'down') this.selected = Math.min(Math.max(0, count - 1), this.selected + 1)
    if (key.name === 'return') { this.detail = this.entries()[this.selected]; this.searching = false; this.confirm = ''; this.offset = 0 }
    return true
  }
  render(width: number, height: number): string[] {
    const theme = this.theme(), view = this.view()
    const pairs: [string, string][] = this.form ? [['Enter', '提交'], ['Esc', '取消']] : this.detail ? [['↑↓', '滚动'], ...(this.detail.rule?.source === 'session' ? [['d', '移除']] as [string, string][] : []), ...(this.detail.command || this.removing ? [['Enter', this.removing ? '确认移除' : '确认']] as [string, string][] : []), ['Esc', '返回']] : [['←→', '页签'], ['/', '搜索'], ['Enter', '详情'], ...(this.tab === 1 ? [['a', '新增'], ['t', '测试']] as [string, string][] : this.tab === 2 ? [['a', '新增']] as [string, string][] : []), ['Esc', '返回']]
    const footer = frameHintRows(pairs, width, theme)
    const top = panelHeader('权限', ['模式', '规则', '目录', '授信'], this.tab, width, theme)
    if (height >= 18) top.push(frameLine('', width, theme))
    top.push(frameLine(color(`当前权限：${view.modeLabel}`, theme.secondary), width, theme))
    if (!this.detail && !this.form && height >= 18) {
      const descriptions = ['选择工具执行方式；确认后保存为用户默认。', '管理允许与拒绝规则。deny 始终优先。', '管理已记住的工作区外读写授权。', '项目授信允许加载本地安全配置与 hooks。']
      top.push(frameLine(color(descriptions[this.tab]!, theme.muted), width, theme), frameLine('', width, theme))
      if (this.tab === 1 || this.tab === 2 || this.searching || this.query) top.push(...panelSearch(this.query, this.searching, '/ 搜索规则或路径', width, theme), frameLine('', width, theme))
    } else if (this.searching || this.query) top.push(frameLine(`搜索：${this.query}▏`, width, theme))
    const budget = Math.max(1, height - top.length - footer.length)
    let body: string[]
    if (this.form) body = wrapReadingText(`${this.form.title}\n❯ ${this.form.value}\n${this.error}`, Math.max(1, width - 4)).slice(-budget)
    else if (this.detail) {
      const pinned = wrapReadingText(`${this.detail.command?.includes('unattended') ? '输入 confirm：' + (this.confirm || '▏') : this.removing ? '确认移除本会话规则？Enter 确认' : ''}${this.error ? '\n' + this.error : ''}`, Math.max(1, width - 4)).filter(Boolean).slice(-budget)
      const rows = wrapReadingText(this.detail.text, Math.max(1, width - 4)), space = Math.max(0, budget - pinned.length)
      this.offset = Math.min(this.offset, Math.max(0, rows.length - space)); body = [...rows.slice(this.offset, this.offset + space), ...pinned]
    }
    else { const entries = this.entries(); const start = Math.max(0, Math.min(this.selected - budget + 1, entries.length - budget)); body = entries.slice(start, start + budget).map((row, i) => numberedChoice(row.label, start + i, start + i === this.selected, theme)); if (!body.length) body = [this.query ? '没有匹配结果；Esc 清除搜索' : this.tab === 2 ? '无已记住目录；a 添加授权' : '无规则；a 新增会话规则，t 测试'] }
    const gap = top.length + body.length + footer.length < height ? [frameLine('', width, theme)] : []
    return [...top, ...body.map(row => frameLine(row, width, theme)), ...gap, ...footer].slice(0, height)
  }
}
