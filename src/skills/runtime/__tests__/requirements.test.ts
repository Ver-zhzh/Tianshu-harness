import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditRequirements } from '../requirements.js'

function pkg(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'skill-req-'))
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, ...name.split('/'))
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

describe('auditRequirements — 合法形态', () => {
  it('版本约束 / extras / 环境标记 / 哈希全要素', () => {
    const result = auditRequirements([
      'httpx>=0.27,<1',
      'uvicorn[standard]==0.30.0; python_version >= "3.10"',
      'hashed==1.0 \\',
      '    --hash=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \\',
      '    --hash=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      '# 注释行',
      '',
    ].join('\n'))
    assert.ok(result.ok)
    const [httpx, uvicorn, hashed] = result.audited.requirements
    assert.deepEqual(httpx, { name: 'httpx', extras: [], constraint: '>=0.27,<1', hashes: [], unpinned: true, origin: { file: '<requirements>', line: 1 } })
    assert.equal(uvicorn?.name, 'uvicorn')
    assert.deepEqual(uvicorn?.extras, ['standard'])
    assert.equal(uvicorn?.constraint, '==0.30.0')
    assert.equal(uvicorn?.marker, 'python_version >= "3.10"')
    assert.equal(uvicorn?.unpinned, false)
    assert.equal(hashed?.hashes.length, 2)
    assert.equal(hashed?.origin.line, 3)
  })

  it('unpinned 判定：无钉死 / ~= 范围 → true；==/=== 精确 → false', () => {
    const result = auditRequirements('a\nb~=1.0\nc==1.0\nd>=1.0,!=1.2\ne===1.0\n')
    assert.ok(result.ok)
    const byName = new Map(result.audited.requirements.map(r => [r.name, r.unpinned]))
    assert.deepEqual([...byName.entries()], [['a', true], ['b', true], ['c', false], ['d', true], ['e', false]])
  })

  it('normalized 确定性渲染（保持来源顺序；约束并入、标记保留）', () => {
    const result = auditRequirements('b==2 ; python_version >= "3.10"\na\n')
    assert.ok(result.ok)
    assert.equal(result.audited.normalized, 'b==2 ; python_version >= "3.10"\na\n')
  })
})

describe('auditRequirements — 拒绝矩阵（行号 + 替代建议）', () => {
  const rejects: Array<[string, string, RegExp, number]> = [
    ['editable -e', 'httpx\n-e ./local\n', /第 2 行.*editable.*改用包名/s, 2],
    ['editable --editable=', '--editable=./local\n', /editable/, 1],
    ['本地相对路径', './vendor/pkg\n', /不允许本地路径/, 1],
    ['上级目录路径', '../shared/pkg\n', /不允许本地路径/, 1],
    ['POSIX 绝对路径', '/opt/pkg\n', /不允许本地路径/, 1],
    ['Windows 盘符路径', 'C:/pkg\n', /不允许本地路径/, 1],
    ['包内子路径', 'vendor/pkg\n', /不允许本地路径/, 1],
    ['VCS URL', 'git+https://github.com/x/y.git\n', /VCS/, 1],
    ['裸 https URL', 'https://example.com/pkg.whl\n', /URL/, 1],
    ['file URL', 'file:///tmp/pkg\n', /URL/, 1],
    ['直接引用 pkg @ url', 'mypkg @ https://example.com/pkg.whl\n', /直接引用.*改用包名/s, 1],
    ['--index-url', '--index-url https://evil.example.com/simple\nhttpx\n', /--index-url.*mirrors\.pypi/s, 1],
    ['--extra-index-url', '--extra-index-url https://evil.example.com/simple\n', /--extra-index-url/, 1],
    ['--trusted-host', '--trusted-host evil.example.com\n', /--trusted-host/, 1],
    ['未知选项', '--pre\nhttpx\n', /不支持的选项/, 1],
    ['非法哈希算法', 'pkg==1.0 --hash=md5:abc\n', /非法哈希/, 1],
    ['孤儿哈希', '--hash=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', /必须跟随/, 1],
    ['坏约束字符', 'httpx$1.0\n', /版本约束/, 1],
    ['标记中藏索引选项', 'httpx ; python_version >= "3" --index-url https://evil.example/simple\n', /环境标记/, 1],
    ['空标记', 'httpx ;\n', /环境标记为空/, 1],
  ]
  for (const [name, source, pattern] of rejects) {
    it(name, () => {
      const result = auditRequirements(source)
      assert.ok(!result.ok, '应拒绝')
      assert.equal(result.errorCode, 'invalid_requirements')
      assert.match(result.message, pattern)
    })
  }

  it('行号定位到违规行而非全文首行', () => {
    const result = auditRequirements('httpx>=0.27\nuvicorn==0.30.0\n-e ./bad\n')
    assert.ok(!result.ok)
    assert.match(result.message, /第 3 行/)
  })
})

describe('auditRequirements — -r/-c 递归', () => {
  it('-r 合并安装项；includedFiles 记录引用', () => {
    const f = pkg({ 'requirements.txt': '-r more.txt\nhttpx\n', 'more.txt': 'uvicorn==0.30.0\n' })
    try {
      const result = auditRequirements(readSource(f.root, 'requirements.txt'), { packageRoot: f.root })
      assert.ok(result.ok)
      assert.deepEqual(result.audited.requirements.map(r => r.name), ['uvicorn', 'httpx'])
      assert.deepEqual(result.audited.includedFiles, ['more.txt'])
    } finally { f.cleanup() }
  })

  it('-c 保留真实约束文件，不将传递依赖约束降为注释', () => {
    const f = pkg({ 'requirements.txt': '-c constraints.txt\nhttpx\n', 'constraints.txt': 'httpx==0.27.2\nother==9.9\n' })
    try {
      const result = auditRequirements(readSource(f.root, 'requirements.txt'), { packageRoot: f.root })
      assert.ok(result.ok)
      assert.deepEqual(result.audited.constraints, { httpx: '==0.27.2', other: '==9.9' })
      assert.deepEqual(result.audited.constraintFiles, ['constraints.txt'])
      assert.equal(result.audited.normalized, '-c constraints.txt\nhttpx\n')
      assert.equal(result.audited.files['constraints.txt'], 'httpx==0.27.2\nother==9.9\n')
    } finally { f.cleanup() }
  })

  it('越界引用（../）拒绝', () => {
    const f = pkg({ 'requirements.txt': '-r ../outside.txt\n' })
    try {
      const result = auditRequirements(readSource(f.root, 'requirements.txt'), { packageRoot: f.root })
      assert.ok(!result.ok)
      assert.match(result.message, /越出技能包/)
    } finally { f.cleanup() }
  })

  it('符号链接逃逸拒绝', () => {
    const outside = mkdtempSync(join(tmpdir(), 'skill-req-outside-'))
    writeFileSync(join(outside, 'secret.txt'), 'evil==1.0\n')
    const f = pkg({ 'requirements.txt': '-r link.txt\n' })
    symlinkSync(join(outside, 'secret.txt'), join(f.root, 'link.txt'))
    try {
      const result = auditRequirements(readSource(f.root, 'requirements.txt'), { packageRoot: f.root })
      assert.ok(!result.ok)
      assert.match(result.message, /符号链接越出/)
    } finally { f.cleanup(); rmSync(outside, { recursive: true, force: true }) }
  })

  it('引用文件不存在拒绝', () => {
    const f = pkg({ 'requirements.txt': '-r missing.txt\n' })
    try {
      const result = auditRequirements(readSource(f.root, 'requirements.txt'), { packageRoot: f.root })
      assert.ok(!result.ok)
      assert.match(result.message, /不存在或不可读/)
    } finally { f.cleanup() }
  })

  it('递归深度上限（链式 -r 第 5 层拒绝）', () => {
    const files: Record<string, string> = { 'requirements.txt': '-r a.txt\n' }
    for (const [i, next] of [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e'], ['e', 'f']] as const) files[`${i}.txt`] = `-r ${next}.txt\n`
    files['f.txt'] = 'httpx\n'
    const f = pkg(files)
    try {
      const result = auditRequirements(readSource(f.root, 'requirements.txt'), { packageRoot: f.root })
      assert.ok(!result.ok)
      assert.match(result.message, /递归深度超过上限/)
    } finally { f.cleanup() }
  })

  it('引用文件数上限', () => {
    const files: Record<string, string> = { 'requirements.txt': Array.from({ length: 9 }, (_, i) => `-r f${i}.txt`).join('\n') + '\n' }
    for (let i = 0; i < 9; i++) files[`f${i}.txt`] = 'httpx\n'
    const f = pkg(files)
    try {
      const result = auditRequirements(readSource(f.root, 'requirements.txt'), { packageRoot: f.root })
      assert.ok(!result.ok)
      assert.match(result.message, /文件数超过上限/)
    } finally { f.cleanup() }
  })

  it('无 packageRoot 时 -r/-c 一律拒绝', () => {
    const result = auditRequirements('-r more.txt\n')
    assert.ok(!result.ok)
    assert.match(result.message, /仅目录型技能包支持/)
  })

  it('约束文件（-c）里不允许 -r 安装项引用', () => {
    const f = pkg({ 'requirements.txt': '-c constraints.txt\nhttpx\n', 'constraints.txt': '-r more.txt\n', 'more.txt': 'uvicorn\n' })
    try {
      const result = auditRequirements(readSource(f.root, 'requirements.txt'), { packageRoot: f.root })
      assert.ok(!result.ok)
      assert.match(result.message, /约束文件.*不允许 -r/)
    } finally { f.cleanup() }
  })
})

function readSource(root: string, name: string): string {
  return readFileSync(join(root, name), 'utf8')
}
