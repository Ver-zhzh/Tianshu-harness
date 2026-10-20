import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkRuntimeDeclarationPaths,
  parseRuntimeDeclaration,
  readRuntimeDeclaration,
  type RuntimeDeclaration,
} from '../declaration.js'

const FULL = `version: 1
python:
  requires: ">=3.10,<3.15"
  requirements: requirements.txt
  entries:
    calculate:
      script: scripts/calculate.py
      timeoutSeconds: 120
    summarize:
      script: scripts/summarize.py
`

const MINIMAL = `version: 1
python:
  entries:
    run:
      script: scripts/run.py
`

function dirSkill(files: Record<string, string>): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'skill-runtime-decl-'))
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, ...name.split('/'))
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('parseRuntimeDeclaration — 纯解析与字符串级路径校验', () => {
  it('合法全字段声明：requires/requirements/entries/timeoutSeconds 全部解析', () => {
    const result = parseRuntimeDeclaration(FULL)
    assert.ok(result.ok)
    assert.equal(result.declaration.version, 1)
    assert.equal(result.declaration.python.requires, '>=3.10,<3.15')
    assert.equal(result.declaration.python.requirements, 'requirements.txt')
    assert.deepEqual(result.declaration.python.entries['calculate'], { script: 'scripts/calculate.py', timeoutSeconds: 120 })
    assert.deepEqual(result.declaration.python.entries['summarize'], { script: 'scripts/summarize.py' })
  })

  it('最小声明：仅 entries，requires/requirements/timeoutSeconds 缺省', () => {
    const result = parseRuntimeDeclaration(MINIMAL)
    assert.ok(result.ok)
    assert.equal(result.declaration.python.requires, undefined)
    assert.equal(result.declaration.python.requirements, undefined)
    assert.equal(result.declaration.python.entries['run']?.timeoutSeconds, undefined)
  })

  it('未知声明版本：version: 2 → 明确错误', () => {
    const result = parseRuntimeDeclaration(FULL.replace('version: 1', 'version: 2'))
    assert.ok(!result.ok)
    assert.equal(result.errorCode, 'invalid_declaration')
    assert.match(result.message, /未知声明版本/)
  })

  it('version 缺失同样按未知版本拒绝', () => {
    const result = parseRuntimeDeclaration('python:\n  entries:\n    run:\n      script: scripts/run.py\n')
    assert.ok(!result.ok)
    assert.match(result.message, /未知声明版本/)
  })

  it('entry.script 必须是 .py 文件', () => {
    const result = parseRuntimeDeclaration(MINIMAL.replace('scripts/run.py', 'scripts/run.sh'))
    assert.ok(!result.ok)
    assert.match(result.message, /\.py/)
  })

  it('entry.script 拒绝 ../ 越界', () => {
    const result = parseRuntimeDeclaration(MINIMAL.replace('scripts/run.py', '../outside.py'))
    assert.ok(!result.ok)
    assert.match(result.message, /inside the skill package/)
  })

  it('entry.script 拒绝 POSIX 绝对路径', () => {
    const result = parseRuntimeDeclaration(MINIMAL.replace('scripts/run.py', '/etc/passwd.py'))
    assert.ok(!result.ok)
    assert.match(result.message, /inside the skill package/)
  })

  it('entry.script 拒绝 Windows 盘符与反斜杠路径', () => {
    for (const bad of ['C:\\\\tools\\\\run.py', 'scripts\\\\run.py']) {
      const result = parseRuntimeDeclaration(MINIMAL.replace('scripts/run.py', bad))
      assert.ok(!result.ok, bad)
    }
  })

  it('requirements 同样拒绝越界路径', () => {
    const result = parseRuntimeDeclaration(FULL.replace('requirements: requirements.txt', 'requirements: ../shared.txt'))
    assert.ok(!result.ok)
    assert.match(result.message, /inside the skill package/)
  })

  it('entries 缺失或为空映射 → 拒绝', () => {
    assert.ok(!parseRuntimeDeclaration('version: 1\npython:\n  requires: ">=3.10"\n').ok)
    assert.ok(!parseRuntimeDeclaration('version: 1\npython:\n  entries: {}\n').ok)
  })

  it('timeoutSeconds 必须为正数', () => {
    for (const bad of ['0', '-5', '"fast"']) {
      const result = parseRuntimeDeclaration(MINIMAL.replace('script: scripts/run.py', `script: scripts/run.py\n      timeoutSeconds: ${bad}`))
      assert.ok(!result.ok, bad)
    }
  })

  it('坏 YAML / 非映射顶层 → invalid_declaration 而非 throw', () => {
    assert.ok(!parseRuntimeDeclaration('version: 1\n  bad: [indent\n').ok)
    assert.ok(!parseRuntimeDeclaration('- just\n- a\n- list\n').ok)
    assert.ok(!parseRuntimeDeclaration('version: 1\npython: "not a mapping"\n').ok)
  })
})

describe('checkRuntimeDeclarationPaths — 文件系统级校验（存在性 + 符号链接逃逸）', () => {
  it('声明路径真实存在且留在包内 → 通过', () => {
    const { dir, cleanup } = dirSkill({ 'scripts/run.py': 'print(1)', 'requirements.txt': 'httpx\n' })
    try {
      const parsed = parseRuntimeDeclaration(FULL.replace(/scripts\/(calculate|summarize)\.py/g, 'scripts/run.py'))
      assert.ok(parsed.ok)
      const checked = checkRuntimeDeclarationPaths(dir, parsed.declaration)
      assert.ok(checked.ok)
    } finally { cleanup() }
  })

  it('声明路径不存在 → 拒绝', () => {
    const { dir, cleanup } = dirSkill({ 'scripts/run.py': 'print(1)' })
    try {
      const parsed = parseRuntimeDeclaration(MINIMAL)
      assert.ok(parsed.ok)
      const missing = parseRuntimeDeclaration(MINIMAL.replace('scripts/run.py', 'scripts/missing.py'))
      assert.ok(missing.ok)
      const checked = checkRuntimeDeclarationPaths(dir, (missing as { ok: true; declaration: RuntimeDeclaration }).declaration)
      assert.ok(!checked.ok)
      assert.match(checked.message, /not found/)
    } finally { cleanup() }
  })

  it('符号链接逃逸：scripts/evil.py 指向包外 → 拒绝', () => {
    const outside = mkdtempSync(join(tmpdir(), 'skill-runtime-outside-'))
    const { dir, cleanup } = dirSkill({ 'scripts/run.py': 'print(1)' })
    try {
      writeFileSync(join(outside, 'secret.py'), 'print("out")')
      symlinkSync(join(outside, 'secret.py'), join(dir, 'scripts', 'evil.py'))
      const parsed = parseRuntimeDeclaration(MINIMAL.replace('scripts/run.py', 'scripts/evil.py'))
      assert.ok(parsed.ok)
      const checked = checkRuntimeDeclarationPaths(dir, parsed.declaration)
      assert.ok(!checked.ok)
      assert.match(checked.message, /escapes skill package/)
    } finally { cleanup(); rmSync(outside, { recursive: true, force: true }) }
  })

  it('包内符号链接（realpath 仍在包内）→ 通过', () => {
    const { dir, cleanup } = dirSkill({ 'scripts/run.py': 'print(1)' })
    try {
      symlinkSync(join(dir, 'scripts', 'run.py'), join(dir, 'scripts', 'link.py'))
      const parsed = parseRuntimeDeclaration(MINIMAL.replace('scripts/run.py', 'scripts/link.py'))
      assert.ok(parsed.ok)
      assert.ok(checkRuntimeDeclarationPaths(dir, parsed.declaration).ok)
    } finally { cleanup() }
  })
})

describe('readRuntimeDeclaration — 加载层入口', () => {  it('无 runtime.yaml → undefined（旧技能零变化）', () => {
    const { dir, cleanup } = dirSkill({ 'SKILL.md': '---\nname: x\n---\nbody\n' })
    try {
      assert.equal(readRuntimeDeclaration(dir), undefined)
    } finally { cleanup() }
  })

  it('合法声明 → declaration；坏声明 → error（不 throw）', () => {
    const good = dirSkill({ 'runtime.yaml': MINIMAL, 'scripts/run.py': 'print(1)' })
    const bad = dirSkill({ 'runtime.yaml': 'version: 2\npython: {}\n' })
    try {
      const okMeta = readRuntimeDeclaration(good.dir)
      assert.ok(okMeta?.declaration)
      assert.equal(okMeta.error, undefined)
      const badMeta = readRuntimeDeclaration(bad.dir)
      assert.ok(badMeta?.error)
      assert.match(badMeta.error, /未知声明版本/)
      assert.equal(badMeta.declaration, undefined)
    } finally { good.cleanup(); bad.cleanup() }
  })

  it('声明引用的脚本缺失 → error 进入 metadata', () => {
    const { dir, cleanup } = dirSkill({ 'runtime.yaml': MINIMAL })
    try {
      const meta = readRuntimeDeclaration(dir)
      assert.ok(meta?.error)
      assert.match(meta.error, /not found/)
    } finally { cleanup() }
  })
})

describe('接线契约 — fingerprint 与加载层', () => {
  it('runtime.yaml 进入包文件集：声明变更 → fingerprint 变更', async () => {
    const { readPackage } = await import('../../skill-package.js')
    const skillFiles = { 'SKILL.md': '---\nname: calc\ndescription: d\n---\nbody\n', 'scripts/run.py': 'print(1)\n' }
    const a = dirSkill({ ...skillFiles, 'runtime.yaml': MINIMAL })
    const b = dirSkill({ ...skillFiles, 'runtime.yaml': MINIMAL.replace('script: scripts/run.py', 'script: scripts/run.py\n      timeoutSeconds: 60') })
    const bare = dirSkill(skillFiles)
    try {
      const pkgA = readPackage(a.dir), pkgB = readPackage(b.dir), pkgBare = readPackage(bare.dir)
      assert.ok(pkgA.files.some(f => f.path === 'runtime.yaml'))
      assert.notEqual(pkgA.fingerprint, pkgB.fingerprint)
      assert.equal(pkgA.definition.metadata?.runtime?.declaration?.python.entries['run']?.script, 'scripts/run.py')
      assert.equal(pkgBare.definition.metadata?.runtime, undefined)
    } finally { a.cleanup(); b.cleanup(); bare.cleanup() }
  })

  it('loadFromDirectory：目录型技能携带 runtime metadata；坏声明降级为 error', async () => {
    const { SkillRegistry } = await import('../../skill-loader.js')
    const root = mkdtempSync(join(tmpdir(), 'skill-runtime-loader-'))
    try {
      for (const [name, yaml] of [['good', MINIMAL], ['bad', 'version: 2\npython: {}\n']] as const) {
        const dir = join(root, name)
        mkdirSync(join(dir, 'scripts'), { recursive: true })
        writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\nbody\n`)
        writeFileSync(join(dir, 'runtime.yaml'), yaml)
        writeFileSync(join(dir, 'scripts', 'run.py'), 'print(1)\n')
      }
      const registry = new SkillRegistry()
      const { loaded, errors } = registry.loadFromDirectory(root)
      assert.deepEqual(errors, [])
      assert.ok(loaded.includes('good') && loaded.includes('bad'))
      assert.equal(registry.get('good')?.metadata?.runtime?.declaration?.python.entries['run']?.script, 'scripts/run.py')
      assert.match(registry.get('bad')?.metadata?.runtime?.error ?? '', /未知声明版本/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
