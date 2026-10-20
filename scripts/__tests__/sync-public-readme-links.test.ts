import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 公开仓 README 死链守卫。
 *
 * docs/ 自 2026-08-02 起整树冻结（工作树 rsync 无法区分本地/公开文档），只有
 * DOCS_WHITELIST 与三个目录级例外会进公开仓。README 引用了不在同步范围的文档，
 * dev 侧一切正常，只有 sync 之后公开仓才 404——问题暴露得太晚。
 *
 * 实账：PR #527 的新版 README 引入 docs/stars/genesis-stele.en.md 与
 * docs/README.md；英文参考 docs/reference/cli-reference.en.md 与
 * docs/guides/mobile-guide.md 同样被引用却从没进过白名单。四篇都会死链。
 *
 * 判据：README.{md,en.md,ja.md,ko.md} 里以 docs/ 开头的引用，必须命中
 * ① DOCS_WHITELIST 条目，或 ② 目录级同步前缀。新增公开文档时忘了登记，
 * 本用例直接红——把「同步之后才发现」提前到「提交之前」。
 */

const repoRoot = join(import.meta.dirname, '..', '..')
const SCRIPT_PATH = join(repoRoot, 'scripts', 'sync-to-public.sh')
const READMES = ['README.md', 'README.en.md', 'README.ja.md', 'README.ko.md']

/** 脚本里用 rsync 整目录铺的路径：命中前缀即视为已覆盖 */
const DIR_LEVEL = [
  'docs/brand/assets/', // banner / 截图 / 二维码 / README 配图
  'docs/skills/optional/', // 可选 skill 目录
  'docs/releases/', // 发布记录（GitHub Release 正文链接目标）
]

function parseWhitelist(script: string): Set<string> {
  const block = script.match(/DOCS_WHITELIST=\(([\s\S]*?)\)\n/)
  assert.ok(block, 'sync-to-public.sh 中找不到 DOCS_WHITELIST 数组')
  return new Set([...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]))
}

/** 提取 markdown 链接与 HTML href/src 里的 docs/ 引用（去锚点） */
function docsRefs(file: string): Set<string> {
  const source = readFileSync(join(repoRoot, file), 'utf8')
  const refs = new Set<string>()
  for (const m of source.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (m[1].startsWith('docs/')) refs.add(m[1].split('#')[0])
  }
  for (const m of source.matchAll(/(?:href|src)="([^"]+)"/g)) {
    if (m[1].startsWith('docs/')) refs.add(m[1].split('#')[0])
  }
  return refs
}

function covered(ref: string, whitelist: Set<string>): boolean {
  if (whitelist.has(ref)) return true
  return DIR_LEVEL.some((dir) => ref === dir || ref.startsWith(dir))
}

describe('公开仓 README 死链守卫', () => {
  const script = readFileSync(SCRIPT_PATH, 'utf8')
  const whitelist = parseWhitelist(script)

  it('DOCS_WHITELIST 可解析且非空', () => {
    assert.ok(whitelist.size > 0, '白名单解析结果为空——脚本结构可能变了')
  })

  for (const readme of READMES) {
    it(`${readme} 引用的 docs 文档都在同步范围内`, () => {
      const missing = [...docsRefs(readme)].filter((ref) => !covered(ref, whitelist)).sort()
      assert.deepEqual(
        missing,
        [],
        `${readme} 引用了不会同步到公开仓的文档（公开仓会 404）：\n` +
          missing.map((p) => `  - ${p}`).join('\n') +
          '\n修法：在 scripts/sync-to-public.sh 的 DOCS_WHITELIST 里加一行，' +
          '或确认该路径已被目录级同步覆盖。',
      )
    })
  }
})
