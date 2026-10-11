/**
 * serve-startup-report 的门禁：`--spawn` 子进程环境必须走白名单。
 *
 * 失效形态：脚本 `{ ...process.env }` 继承整张环境表——provider key 会被带进
 * 临时 sidecar，`--create-session-early` 的 probe prompt 就成了一次真实模型
 * 请求；RIVET_SESSION_DIR 等变量还会把会话目录指回真实工作区。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeDistClosure, extractDistStaticSpecifiers, serveSpawnEnv } from '../serve-startup-report.js'

test('serveSpawnEnv：临时 HOME/RIVET_HOME/缓存/token 覆盖，provider key 与会话目录不外泄', () => {
  const planted = {
    OPENAI_API_KEY: 'sk-leak',
    RIVET_SESSION_DIR: '/real/sessions',
    RIVET_SERVE_REPORT_LEAK: 'leak',
    // 伪造一个父 pid 哨兵：证明注入的是本进程真实 pid，不是继承值
    RIVET_PARENT_PID: '999999',
  }
  const saved: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(planted)) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
  try {
    const env = serveSpawnEnv('/tmp/report-home', '/tmp/report-rivet', '/tmp/report-cache', 'tok')
    assert.equal(env.HOME, '/tmp/report-home')
    assert.equal(env.RIVET_HOME, '/tmp/report-rivet')
    assert.equal(env.NODE_COMPILE_CACHE, '/tmp/report-cache')
    assert.equal(env.RIVET_SERVER_TOKEN, 'tok')
    assert.equal(env.OPENAI_API_KEY, undefined, 'provider key 不得继承')
    assert.equal(env.RIVET_SESSION_DIR, undefined, '真实会话目录变量不得继承')
    assert.equal(env.RIVET_SERVE_REPORT_LEAK, undefined, '未知环境变量不得继承')
    assert.equal(env.PATH, process.env.PATH, 'PATH 属于最小必需集，应保留')
    // 孤儿防线（2026-10-11 实测泄漏：无 watchdog 的 serve 在启动者死后永久残留，
    // 0.0.0.0:59396 孤儿即此形态）：serve 的 parent-watchdog 只认 RIVET_PARENT_PID，
    // 缺失即不装守护。验证脚本起的 serve 必须绑定到脚本进程的生命周期。
    assert.equal(env.RIVET_PARENT_PID, String(process.pid), '必须注入脚本自身 pid——serve watchdog 的孤儿防线')
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('dist 静态 specifier：紧凑（混淆）与常规形态都能解析，动态 import 不算', () => {
  const compact = 'import{a as b}from"./chunk-A.js";import"./chunk-B.js";export{a}from"./chunk-C.js";await import("./dyn.js")'
  assert.deepEqual(
    extractDistStaticSpecifiers(compact).sort(),
    ['./chunk-A.js', './chunk-B.js', './chunk-C.js'],
    '混淆产物 `import{...}from"..."` 必须被解析出来（此前会静默只报入口 1 个文件）',
  )
  const pretty = 'import { a } from "./chunk-A.js"\nimport "./chunk-B.js"\nexport * from "./chunk-C.js"\nawait import("./dyn.js")'
  assert.deepEqual(extractDistStaticSpecifiers(pretty).sort(), ['./chunk-A.js', './chunk-B.js', './chunk-C.js'])
})

test('analyzeDistClosure：紧凑 import 也能跟全闭包（静态 3 文件，动态 import 不算）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-closure-compact-'))
  try {
    writeFileSync(join(dir, 'entry.js'), 'import{a}from"./chunk-A.js";await import("./dyn.js")')
    writeFileSync(join(dir, 'chunk-A.js'), 'import"./chunk-B.js";')
    writeFileSync(join(dir, 'chunk-B.js'), 'export const x=1')
    writeFileSync(join(dir, 'dyn.js'), 'export const y=2')
    const closure = analyzeDistClosure(join(dir, 'entry.js'))
    assert.equal(closure.files.size, 3, '静态闭包应含 entry + chunk-A + chunk-B；dyn 是动态 import 不该计入')
    assert.ok(closure.files.has(join(dir, 'chunk-B.js')), 'chunk-B 应可达')
    assert.deepEqual(closure.why('chunk-B.js').map(p => p === '' ? 'entry.js' : p.split('/').pop()), ['entry.js', 'chunk-A.js', 'chunk-B.js'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test('dist 静态 specifier：紧凑且只引内置模块时不误报（守卫看过滤前全集）', () => {
  const builtinsOnly = 'import{createRequire as r}from"node:module";import{dirname}from"path";import{fileURLToPath}from"url";'
  assert.deepEqual(
    extractDistStaticSpecifiers(builtinsOnly).sort(),
    ['node:module', 'path', 'url'],
    '只引内置模块的紧凑 chunk 也必须被识别（混淆构建的公共辅助 chunk 长这样）',
  )
  const dir = mkdtempSync(join(tmpdir(), 'rivet-closure-builtins-'))
  try {
    writeFileSync(join(dir, 'chunk-helper.js'), builtinsOnly)
    const closure = analyzeDistClosure(join(dir, 'chunk-helper.js'))
    assert.equal(closure.files.size, 1, '仅内置导入时闭包只有自身，绝不能触发 fail-loud 守卫')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
