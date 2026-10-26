import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * P2-3 邻居提示 A/B（RIVET_NEIGHBOR_HINT，默认关）：
 * read_file 结果尾附「结构邻居: a.ts, b.ts」（出边 top-3、未读过的、≤100 字符），
 * 默认关——env 未开/无 provider/无出边/全已读时零字节差异。
 */
describe('neighbor hint (P2-3)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'neighbor-hint-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'a.ts'), 'const a = 1\n', 'utf-8')
    writeFileSync(join(dir, 'src', 'b.ts'), 'const b = 2\n', 'utf-8')
    writeFileSync(join(dir, 'src', 'c.ts'), 'const c = 3\n', 'utf-8')
  })

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  })

  it('默认关——provider 已设但 env 未开，输出零字节差异', async () => {
    const { READ_FILE_TOOL, setNeighborHintProvider } = await import('../read-file.js')
    setNeighborHintProvider(() => [join(dir, 'src', 'b.ts')])
    try {
      const result = await READ_FILE_TOOL.execute({ input: { file_path: 'src/a.ts' }, toolUseId: 'test', cwd: dir, sessionId: 'hint-off' })
      assert.ok(!result.isError)
      assert.doesNotMatch(result.content, /结构邻居/, 'env 未开时不得附提示行')
      assert.match(result.content, /const a = 1/)
    } finally {
      setNeighborHintProvider(undefined)
    }
  })

  it('RIVET_NEIGHBOR_HINT=1 时附「结构邻居」top-3（未读过的、相对路径）', async () => {
    const { READ_FILE_TOOL, setNeighborHintProvider, __resetReadHistoryForTests } = await import('../read-file.js')
    __resetReadHistoryForTests()
    process.env['RIVET_NEIGHBOR_HINT'] = '1'
    setNeighborHintProvider((_cwd, _canonical) => [
      join(dir, 'src', 'b.ts'),
      join(dir, 'src', 'c.ts'),
      join(dir, 'src', 'a.ts'), // 自身也在出边里——但应被已读过滤（本次正是读 a.ts）
    ])
    try {
      const result = await READ_FILE_TOOL.execute({ input: { file_path: 'src/a.ts' }, toolUseId: 'test', cwd: dir, sessionId: 'hint-on' })
      assert.ok(!result.isError)
      assert.match(result.content, /结构邻居: src\/b\.ts, src\/c\.ts/, '已读（本次读的 a.ts）必须被过滤，只列未读出的出边')
      // 21a49c50d 起 read_file 结果尾带「文件回执：src/a.ts; …」——断言收窄到提示行本身。
      const hintLine = result.content.split('\n').find(l => l.includes('结构邻居')) ?? ''
      assert.doesNotMatch(hintLine, /src\/a\.ts/, '提示不得包含当前正在读的文件')
    } finally {
      delete process.env['RIVET_NEIGHBOR_HINT']
      setNeighborHintProvider(undefined)
      __resetReadHistoryForTests()
    }
  })

  it('已读过滤——之前读过的出边不进入提示', async () => {
    const { READ_FILE_TOOL, setNeighborHintProvider, __resetReadHistoryForTests } = await import('../read-file.js')
    __resetReadHistoryForTests()
    process.env['RIVET_NEIGHBOR_HINT'] = '1'
    setNeighborHintProvider(() => [join(dir, 'src', 'b.ts'), join(dir, 'src', 'c.ts')])
    try {
      // 先读 b.ts（记入 fileReadHistory）
      const first = await READ_FILE_TOOL.execute({ input: { file_path: 'src/b.ts' }, toolUseId: 't1', cwd: dir, sessionId: 'hint-read' })
      assert.ok(!first.isError)
      // 再读 a.ts：b.ts 已读应被过滤，只留 c.ts
      const second = await READ_FILE_TOOL.execute({ input: { file_path: 'src/a.ts' }, toolUseId: 't2', cwd: dir, sessionId: 'hint-read' })
      assert.ok(!second.isError)
      assert.match(second.content, /结构邻居: src\/c\.ts/)
      assert.doesNotMatch(second.content, /src\/b\.ts, src\/c\.ts/, 'b.ts 已读不得再提示')
    } finally {
      delete process.env['RIVET_NEIGHBOR_HINT']
      setNeighborHintProvider(undefined)
      __resetReadHistoryForTests()
    }
  })

  it('provider 未设或抛错 → 不附行且 read_file 正常返回', async () => {
    const { READ_FILE_TOOL, setNeighborHintProvider } = await import('../read-file.js')
    process.env['RIVET_NEIGHBOR_HINT'] = '1'
    setNeighborHintProvider(() => { throw new Error('db exploded') })
    try {
      const result = await READ_FILE_TOOL.execute({ input: { file_path: 'src/a.ts' }, toolUseId: 'test', cwd: dir, sessionId: 'hint-err' })
      assert.ok(!result.isError, 'provider 抛错不得让 read_file 失败')
      assert.match(result.content, /const a = 1/)
      assert.doesNotMatch(result.content, /结构邻居/)
      setNeighborHintProvider(undefined)
      const plain = await READ_FILE_TOOL.execute({ input: { file_path: 'src/a.ts' }, toolUseId: 'test2', cwd: dir, sessionId: 'hint-none' })
      assert.doesNotMatch(plain.content, /结构邻居/, 'provider 未设时不附行')
    } finally {
      delete process.env['RIVET_NEIGHBOR_HINT']
      setNeighborHintProvider(undefined)
    }
  })
})
