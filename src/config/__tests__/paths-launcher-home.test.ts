/**
 * 数据根解析的 launcher.json 回退（issue #525 问题二）。
 *
 * 桌面端把用户选的存储位置写在 `launcher.json`（Tauri app_config_dir 下），
 * CLI 却只认 `RIVET_HOME` 环境变量——于是终端里的 /logs 落到平台默认目录，
 * 26 个落点全部 exists=false（issue 实测）。这里锁三条不变量：
 *   1. launcher 路径与 Tauri `app_config_dir()` 同规则（跨平台）；
 *   2. 读取容错——缺失/损坏/空白一律视为未配置，不抛错；
 *   3. 优先级 RIVET_HOME > launcher.json > 平台默认。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launcherConfigPath, launcherRivetHome, pickRivetHome } from '../paths.js'

test('launcherConfigPath 复刻 Tauri app_config_dir 的跨平台规则', () => {
  // Windows：%APPDATA%\<identifier>\launcher.json
  const win = launcherConfigPath({ platform: 'win32', env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, home: 'C:\\Users\\x' })
  assert.ok(win.startsWith('C:\\Users\\x\\AppData\\Roaming'), `win 前缀: ${win}`)
  assert.ok(win.includes('app.tianshu.desktop'), `win identifier: ${win}`)
  assert.ok(win.endsWith('launcher.json'), `win 文件名: ${win}`)

  // Windows 缺 APPDATA 时回落 Roaming 目录，不得抛错
  const winBare = launcherConfigPath({ platform: 'win32', env: {}, home: 'C:\\Users\\x' })
  assert.ok(winBare.includes('Roaming'), `win 回落: ${winBare}`)
  assert.ok(winBare.includes('app.tianshu.desktop'))

  // macOS：~/Library/Application Support/<identifier>/launcher.json
  const mac = launcherConfigPath({ platform: 'darwin', env: {}, home: '/Users/x' })
  assert.equal(mac, join('/Users/x', 'Library', 'Application Support', 'app.tianshu.desktop', 'launcher.json'))

  // Linux：$XDG_CONFIG_HOME/<identifier>/launcher.json，未设则 ~/.config
  assert.equal(
    launcherConfigPath({ platform: 'linux', env: { XDG_CONFIG_HOME: '/cfg' }, home: '/home/x' }),
    join('/cfg', 'app.tianshu.desktop', 'launcher.json'),
  )
  assert.equal(
    launcherConfigPath({ platform: 'linux', env: {}, home: '/home/x' }),
    join('/home/x', '.config', 'app.tianshu.desktop', 'launcher.json'),
  )
})

test('launcherRivetHome 读取 rivetHome；缺失/损坏/空白一律 undefined（不抛错）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'launcher-home-'))
  try {
    const good = join(dir, 'good.json')
    writeFileSync(good, JSON.stringify({ rivetHome: '/data/custom', source: 'user-selected' }))
    assert.equal(launcherRivetHome({ launcherPath: good }), '/data/custom')

    const blank = join(dir, 'blank.json')
    writeFileSync(blank, JSON.stringify({ rivetHome: '   ' }))
    assert.equal(launcherRivetHome({ launcherPath: blank }), undefined, '空白路径不得当成有效数据根')

    const broken = join(dir, 'broken.json')
    writeFileSync(broken, '{not json')
    assert.equal(launcherRivetHome({ launcherPath: broken }), undefined, '损坏的配置退回平台默认，不阻断 CLI 启动')

    const wrongType = join(dir, 'wrong-type.json')
    writeFileSync(wrongType, JSON.stringify({ rivetHome: 42 }))
    assert.equal(launcherRivetHome({ launcherPath: wrongType }), undefined)

    assert.equal(launcherRivetHome({ launcherPath: join(dir, 'missing.json') }), undefined)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('pickRivetHome 优先级：RIVET_HOME > launcher.json > 平台默认', () => {
  assert.equal(pickRivetHome({ RIVET_HOME: '/env' }, '/launcher', '/default'), '/env')
  assert.equal(pickRivetHome({}, '/launcher', '/default'), '/launcher')
  assert.equal(pickRivetHome({}, undefined, '/default'), '/default')
  assert.equal(pickRivetHome({ RIVET_HOME: '   ' }, '/launcher', '/default'), '/launcher', '空白 RIVET_HOME 不算覆盖')
})
