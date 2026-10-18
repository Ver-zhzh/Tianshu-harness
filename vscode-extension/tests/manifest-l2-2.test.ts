import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// L2-2 键位与菜单系统级的 manifest 结构性断言（与 chat-manifest.test.ts 同模式）：
//  - inlineEdit 主键位 = ctrl+k / mac cmd+k，when=editorTextFocus——扩展键位权重最高
//    （ExternalExtension=400）且编辑器上下文无单段竞争者，按下即执行不等 chord
//    （机制链见计划锚点：keybindingsRegistry / keybindingResolver）。
//  - 「天枢」子菜单挂 editor/title 与 editor/title/context（fork 单窗格经 api: 前缀镜像）。
//  - 命令面板前缀由 category 统一（title 不再手工写 "天枢: "）。

interface CommandContribution {
  command: string
  title: string
  category?: string
  icon?: string
}

interface KeybindingContribution {
  command: string
  key?: string
  mac?: string
  when?: string
}

interface SubmenuContribution {
  id: string
  label: string
}

interface MenuItemRef {
  command?: string
  submenu?: string
  when?: string
  group?: string
}

interface ExtensionManifest {
  contributes: {
    commands?: CommandContribution[]
    keybindings?: KeybindingContribution[]
    submenus?: SubmenuContribution[]
    menus?: Record<string, MenuItemRef[]>
  }
}

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as ExtensionManifest

const commands = manifest.contributes.commands ?? []
const menus = manifest.contributes.menus ?? {}

test('inlineEdit 主键位对齐 Cursor：ctrl+k / mac cmd+k，editorTextFocus', () => {
  const kb = manifest.contributes.keybindings ?? []
  assert.equal(kb.length, 1)
  const [k] = kb
  assert.equal(k?.command, 'tianshu.inlineEdit')
  assert.equal(k?.key, 'ctrl+k')
  assert.equal(k?.mac, 'cmd+k')
  assert.equal(k?.when, 'editorTextFocus')
})

test('「天枢」子菜单声明并挂到编辑器标题栏与标签页菜单', () => {
  const subs = manifest.contributes.submenus ?? []
  assert.deepEqual(subs.map((s) => s.id), ['tianshu.actions'])
  const title = menus['editor/title'] ?? []
  assert.ok(title.some((m) => m.submenu === 'tianshu.actions'), 'editor/title 应挂子菜单')
  const titleCtx = menus['editor/title/context'] ?? []
  assert.ok(titleCtx.some((m) => m.submenu === 'tianshu.actions'), 'editor/title/context 应挂子菜单')
})

test('子菜单内容：发送到聊天 + 行内编辑（group 有序）', () => {
  const items = menus['tianshu.actions'] ?? []
  assert.deepEqual(items.map((m) => m.command), ['tianshu.sendSelection', 'tianshu.inlineEdit'])
  assert.ok(items.every((m) => typeof m.group === 'string' && m.group.length > 0))
})

test('命令面板前缀统一：全量 category=天枢，title 无手工前缀', () => {
  assert.ok(commands.length >= 11)
  for (const c of commands) {
    assert.equal(c.category, '天枢', `${c.command} 缺 category`)
    assert.ok(!c.title.startsWith('天枢:'), `${c.command} title 残留手工前缀`)
  }
})

test('既有菜单面不回退：editor/context 两项、view/title 两项、scm/title 既有 git 项保持', () => {
  assert.equal((menus['editor/context'] ?? []).length, 2)
  assert.equal((menus['view/title'] ?? []).length, 2)
  // L2-5 起 scm/title 增 tianshu 两项（见 manifest-l2-5.test.ts）；此处核既有 git 项不回退
  const scmTitle = menus['scm/title'] ?? []
  assert.ok(
    scmTitle.some((m) => m.command === 'tianshu.generateCommitMessage' && m.when === 'scmProvider == git'),
    'generateCommitMessage（scmProvider == git）应保持',
  )
})
