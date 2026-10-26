import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { READ_CONCURRENCY, clampReadConcurrency } from '../read-concurrency.js'
import { configSchema } from '../schema.js'

const here = dirname(fileURLToPath(import.meta.url))
const configRoot = join(here, '..')
const agentRoot = join(here, '..', '..', 'agent')

test('clamp 收敛非法输入并保持合法值', () => {
  assert.equal(clampReadConcurrency(undefined), READ_CONCURRENCY.default)
  assert.equal(clampReadConcurrency(Number.NaN), READ_CONCURRENCY.default)
  assert.equal(clampReadConcurrency(Number.POSITIVE_INFINITY), READ_CONCURRENCY.default)
  assert.equal(clampReadConcurrency(0), READ_CONCURRENCY.min)
  assert.equal(clampReadConcurrency(-3), READ_CONCURRENCY.min)
  assert.equal(clampReadConcurrency(2.7), 2)
  assert.equal(clampReadConcurrency(READ_CONCURRENCY.min), READ_CONCURRENCY.min)
  assert.equal(clampReadConcurrency(READ_CONCURRENCY.max), READ_CONCURRENCY.max)
  assert.equal(clampReadConcurrency(READ_CONCURRENCY.max + 1), READ_CONCURRENCY.max)
})

// R4（优化版）：原计划要求手工把常量改成 8 再改回，用来证明 schema 与调度器同源。
// 改成注入边界后不需要改任何文件：边界若被写死，这两条立刻红。
test('clamp 的边界完全来自常量，没有内嵌字面量', () => {
  const widened = { ...READ_CONCURRENCY, max: 8 }
  assert.equal(clampReadConcurrency(8, widened), 8, '放宽上限后 clamp 必须跟随，而不是仍封顶 4')
  assert.equal(clampReadConcurrency(9, widened), 8)
  assert.equal(clampReadConcurrency(READ_CONCURRENCY.max, widened), 4, '同一输入在不同边界下结果不同，说明边界真的被读取')

  const narrowed = { min: 2, max: 3, default: 2 }
  assert.equal(clampReadConcurrency(1, narrowed), 2)
  assert.equal(clampReadConcurrency(4, narrowed), 3)
  assert.equal(clampReadConcurrency(undefined, narrowed), 2)
})

test('配置校验的上下限与常量同源，越界在加载期被拒绝', () => {
  const tools = configSchema.shape.tools
  const accepts = (value: number) => tools.safeParse({ readConcurrency: value }).success
  assert.equal(accepts(READ_CONCURRENCY.min), true)
  assert.equal(accepts(READ_CONCURRENCY.max), true)
  assert.equal(accepts(READ_CONCURRENCY.min - 1), false, '低于下限必须被拒绝，而不是由调度器静默抬高')
  assert.equal(accepts(READ_CONCURRENCY.max + 1), false, '高于上限必须被拒绝，而不是由调度器静默封顶')
})

test('默认值与 schema 允许区间一致，且默认值本身合法', () => {
  assert.ok(READ_CONCURRENCY.default >= READ_CONCURRENCY.min && READ_CONCURRENCY.default <= READ_CONCURRENCY.max)
  assert.equal(configSchema.shape.tools.safeParse({ readConcurrency: READ_CONCURRENCY.default }).success, true)
})

test('schema 与调度器都从常量取值，没有第二份上下限表达', () => {
  const schemaLine = readFileSync(join(configRoot, 'schema.ts'), 'utf8')
    .split('\n').find(line => line.includes('readConcurrency: z.number()'))
  assert.ok(schemaLine, 'schema 里必须存在 readConcurrency 的数值校验')
  assert.match(schemaLine!, /READ_CONCURRENCY\.min/)
  assert.match(schemaLine!, /READ_CONCURRENCY\.max/)
  assert.doesNotMatch(schemaLine!, /[.(]\s*\d/, '校验边界不得出现数字字面量')

  const batch = readFileSync(join(agentRoot, 'prepared-tool-batch.ts'), 'utf8')
  assert.match(batch, /const limit = clampReadConcurrency\(concurrency\)/, '调度器必须直接使用共享的收敛函数')
  assert.doesNotMatch(batch, /Math\.min\(\s*\d/, '调度器不得保有自己的上下限（如 Math.min(4, …)）；剩余任务裁剪不受此限')
})

test('消费点不再各自写默认值', () => {
  const offenders: string[] = []
  const scan = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) { scan(path); continue }
      if (!entry.name.endsWith('.ts')) continue
      if (/readConcurrency\s*\?\?\s*\d/.test(readFileSync(path, 'utf8'))) offenders.push(`${path}: readConcurrency ?? <字面量>`)
    }
  }
  for (const root of [agentRoot, configRoot]) scan(root)
  assert.deepEqual(offenders, [], '默认值只能来自 READ_CONCURRENCY.default')
})
