#!/usr/bin/env node
// compose-release-body.mjs — 把安装前置段落与版本 changelog 组合成 GitHub Release body。
//
// 用法：
//   node scripts/releases/compose-release-body.mjs --version 3.30.0
//   node scripts/releases/compose-release-body.mjs --version 3.30.0 --changelog docs/releases/v3.30.0.md --out release/body.md
//   node scripts/releases/compose "# 标题\n正文" | gh release edit v3.30.0 --notes-file -
//
// 行为：
//   1. 读取 docs/releases/install-preamble.md（唯一源；相对链接重写为 GitHub 绝对 URL）
//   2. 把模板中的 <版本> 占位符替换为实际版本号（产物名如 Tianshu_<版本>_aarch64.dmg）
//   3. 组合「安装段落 + 分隔 + changelog 正文」写入 --out（默认 stdout）
//   4. 校验：changelog 缺失时大声失败（fail-closed），不产出无安装段落的 body
//
// 组合后的 body 直接用于：
//   gh release edit vX.Y.Z --notes-file release/body.md
// 或发布收尾时人工粘贴。

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
const REPO_URL = 'https://github.com/huiliyi37/Tianshu-harness'
const DEFAULT_PREAMBLE = resolve(REPO_ROOT, 'docs', 'releases', 'install-preamble.md')

function fail(msg) {
  throw new Error(`compose-release-body: ${msg}`)
}

function args(argv) {
  const out = {}
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--version') out.version = argv[++i]
    else if (a === '--preamble') out.preamble = argv[++i]
    else if (a === '--changelog') out.changelog = argv[++i]
    else if (a === '--out') out.out = argv[++i]
    else if (a === '--repo') out.repo = argv[++i]
    else if (a === '--prepend-to') out.prependTo = argv[++i] // 现有 body 文件：前插模式
    else fail(`未知参数：${a}（支持 --version --preamble --changelog --out --repo --prepend-to）`)
  }
  return out
}

/** 把 preamble 里的相对链接重写为 GitHub 绝对 URL（release 页面上相对链接会 404）。 */
function rewriteLinks(md, repoUrl) {
  return md.replace(/\]\((\.\.\/[^)]+)\)/g, (_m, relPath) => {
    // ../guides/installation.md → <repo>/blob/main/docs/guides/installation.md
    const docsRel = relPath.replace('../', '')
    return `](${repoUrl}/blob/main/docs/${docsRel})`
  })
}

/** 占位符注入：<版本> → 实际版本号（无版本号时保留原文，dry-run 可读）。 */
function injectVersion(md, version) {
  return version ? md.replaceAll('<版本>', version) : md
}

export function composeBody({ preamble, changelog, version, repoUrl = REPO_URL }) {
  if (!preamble || !preamble.trim()) fail('install-preamble 为空或缺失——release body 必须带安装段落（fail-closed）')
  const linksFixed = rewriteLinks(injectVersion(preamble.trim(), version), repoUrl)
  if (!changelog || !changelog.trim()) {
    // changelog 可缺省（发布草稿期），但 preamble 必须在
    return `${linksFixed}\n`
  }
  return `${linksFixed}\n\n---\n\n${changelog.trim()}\n`
}

/** 修复已发布 release：preamble 前插到现有 body 之前，不覆盖人工精选的正文。
 *  已含安装段落（旧版前插过）时幂等返回原文，避免重复前插。 */
export function prependPreamble({ preamble, existingBody, version, repoUrl = REPO_URL }) {
  if (!preamble || !preamble.trim()) fail('install-preamble 为空或缺失（fail-closed）')
  if (!existingBody || !existingBody.trim()) fail('existingBody 为空——前插需要现有 body')
  const linksFixed = rewriteLinks(injectVersion(preamble.trim(), version), repoUrl)
  if (existingBody.trim().startsWith(linksFixed.split('\n')[0])) return existingBody // 幂等：已前插过（首行标题命中）
  return `${linksFixed}\n\n---\n\n${existingBody.trim()}\n`
}

function main() {
  try {
    const opt = args(process.argv)
    if (opt.version && !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(opt.version)) fail(`--version 格式非法：${opt.version}（期望 X.Y.Z）`)
    const preamblePath = opt.preamble ?? DEFAULT_PREAMBLE
    if (!existsSync(preamblePath)) fail(`preamble 文件不存在：${preamblePath}`)
    const preamble = readFileSync(preamblePath, 'utf8')
    const changelogPath = opt.changelog ?? (opt.version ? resolve(REPO_ROOT, 'docs', 'releases', `v${opt.version}.md`) : undefined)
    let changelog
    if (changelogPath && existsSync(changelogPath)) changelog = readFileSync(changelogPath, 'utf8')
    else if (opt.changelog) fail(`changelog 文件不存在：${opt.changelog}`)
    // 默认路径不存在时不失败——draft 阶段可能还没有 changelog，只装 preamble
    let body
    if (opt.prependTo) {
      if (!existsSync(opt.prependTo)) fail(`--prepend-to 文件不存在：${opt.prependTo}`)
      body = prependPreamble({ preamble, existingBody: readFileSync(opt.prependTo, 'utf8'), version: opt.version, repoUrl: opt.repo })
    } else {
      body = composeBody({ preamble, changelog, version: opt.version, repoUrl: opt.repo })
    }
    if (opt.out) {
      writeFileSync(opt.out, body)
      console.log(`✓ composed body → ${opt.out}（${body.length} chars；preamble${changelog ? ' + changelog' : ' only'}）`)
    } else {
      process.stdout.write(body)
    }
  } catch (err) {
    console.error(`✗ ${err.message}`)
    process.exit(1)
  }
}

// 直接执行时才跑 main；被 import 时不自动跑
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()

export { rewriteLinks, injectVersion }
