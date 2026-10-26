#!/usr/bin/env bash
# publish-release-catalog.sh — 已受控稳定版的发布补全；新版本必须走 stage→promote
#
# 为什么存在：桌面端 3.29.0 起更新走「release catalog」路由（desktop/src-tauri/src/
# update_routing.rs）。catalog 由 generate-catalog.mjs 生成、由 publish-routing.mjs
# 发布——两步都是手动的，历史上漏过：3.29.1 的 catalog 生成并提交进了仓库，却从未
# 发布到线上（OSS / Tianshu-harness release 双 404），于是客户端 catalog 拉取失败、
# 静默降级为 GitHub-only，国内源整体失效。本脚本把「发布后收口」固化为一步，并在
# 动手前后做前置/后置对账，防再漏。
#
# 国内分流有三条源（catalog 的 sources）：github / oss / atomgit。
#   - github：始终在列（发布链路自带）
#   - oss   ：由二进制上传步骤提供，catalog 里恒为 verified:false，只作手动备份。
#   - atomgit：强制步骤；tag 必须已镜像，上传/已存在附件均做匿名全包 + 精确 Range 验证，
#             随后以 --metadata-only 发布版本固定的 latest.json 与原始 catalog 字节。
#
# 用法：
#   bash scripts/releases/publish-release-catalog.sh            # 默认 dry run：只做前置检查（纯读，无写/对外动作）
#   bash scripts/releases/publish-release-catalog.sh --publish  # 真发布（对外、不可逆：OSS 覆盖 + release --clobber）
#
# 选项：
#   --publish              执行对外发布（upload-to-oss + atomgit + publish-routing --publish + 线上验证）
#   --skip-oss             跳过 upload-update-to-oss.sh（OSS 二进制/legacy manifest 已单独传过）
#   --skip-atomgit         拒绝执行：稳定发布不得关闭必需的 AtomGit 源
#   --no-commit            generate-catalog 后不自动提交 release-catalog.json
#   --website DIR          覆盖 website checkout 路径（默认 ../tianshu-website）
#
# 前置（脚本逐条校验，缺一即 fail-closed 退出）：
#   1. latest.json 的 version = 待发布版本
#   2. docs/releases/summaries/<ver>.json 存在且通过 validateReleaseNotes
#      （generate-catalog 靠它生成 releaseNotesUrl；缺了会继承旧版本路径 → 校验失败）
#   3. GitHub release v<ver> 已建且**非 draft**，manifest 引用的每个平台资产都在
#      （draft 不被 releases/latest 解析 → catalog 传上去客户端也读不到）
#   4. website checkout 存在（publish-routing --website 需要）
#   5. AtomGit tag 探测成功且 v<ver> 已镜像；缺 tag 或探测失败都不会自动降级跳过
set -euo pipefail
cd "$(dirname "$0")/../.."

PUBLISH=0; SKIP_OSS=0; SKIP_ATOMGIT=0; NO_COMMIT=0; WEBSITE="../tianshu-website"
while [ $# -gt 0 ]; do
  case "$1" in
    --publish)              PUBLISH=1; shift ;;
    --skip-oss)             SKIP_OSS=1; shift ;;
    --skip-atomgit)         SKIP_ATOMGIT=1; shift ;;
    --no-commit)            NO_COMMIT=1; shift ;;
    --website)              WEBSITE="${2:-}"; shift 2 ;;
    --website=*)            WEBSITE="${1#*=}"; shift ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

REPO="huiliyi37/Tianshu-harness"
ATOMGIT_GIT="https://atomgit.com/huiliyi37/Tianshu-harness.git"
fail() { echo "✗ $*" >&2; exit 1; }
step() { echo ""; echo "==> $*"; }
[ "$SKIP_ATOMGIT" != 1 ] || fail "--skip-atomgit 不允许用于稳定发布：必须完成 AtomGit 双源验证与元数据发布"

VER="$(node -p "require('./latest.json').version" 2>/dev/null || true)"
[ -n "$VER" ] || fail "读取不到 latest.json 的 version"
CONTROL_VERSION="$(node -p "require('./update-control.json').stable.version" 2>/dev/null || true)"
[ "$VER" = "$CONTROL_VERSION" ] || fail "v$VER 不是本地受控稳定版（当前 ${CONTROL_VERSION:-未知}）：候选版必须走 stage → promote，不能使用稳定版收口脚本"
echo "发布版本：v$VER"

PTOTAL=5

step "前置检查 1/${PTOTAL}：发布说明摘要"
SUM="docs/releases/summaries/${VER}.json"
[ -f "$SUM" ] || fail "缺少 $SUM —— generate-catalog 需要它生成 releaseNotesUrl（缺了会继承旧版本路径并校验失败）。先补该文件。"
node --input-type=module -e "
import { validateReleaseNotes } from './scripts/releases/release-notes.mjs';
import { readFileSync } from 'node:fs';
validateReleaseNotes(JSON.parse(readFileSync(process.argv[1],'utf8')), process.argv[2]);
" "$SUM" "$VER" || fail "$SUM 未通过 validateReleaseNotes"
echo "    $SUM ✓"

step "前置检查 2/${PTOTAL}：GitHub release 存在且已发布（非 draft）"
DRAFT="$(gh release view "v$VER" --repo "$REPO" --json isDraft --jq '.isDraft' 2>/dev/null || true)"
[ -n "$DRAFT" ] || fail "GitHub release v$VER 不存在或不可访问——generate-catalog 会报 metadata 404。先建 release 并传齐资产。"
[ "$DRAFT" = "false" ] || fail "GitHub release v$VER 仍是 draft（isDraft=${DRAFT}）——draft 不会被 releases/latest 解析，catalog 传上去客户端也读不到。先转正后重跑：gh release edit v$VER --repo $REPO --draft=false"
echo "    v$VER ✓（已发布）"

step "前置检查 3/${PTOTAL}：manifest 引用的资产齐备"
ASSETS="$(gh release view "v$VER" --repo "$REPO" --json assets --jq '.assets[].name' 2>/dev/null || true)"
[ -n "$ASSETS" ] || fail "拉不到 v$VER 的资产清单（gh 权限或网络）"
MISSING="$(printf '%s\n' "$ASSETS" | node -e "
const m = require('./latest.json');
const have = new Set(require('fs').readFileSync(0,'utf8').split('\n').map(s => s.trim()).filter(Boolean));
for (const p of Object.values(m.platforms)) { const f = p.url.split('/').pop(); if (!have.has(f)) console.log(f); }
")"
[ -z "$MISSING" ] || fail "release v$VER 缺少 manifest 引用的资产：$(echo "$MISSING" | tr '\n' ' ')"
echo "    资产齐备（$(printf '%s\n' "$ASSETS" | grep -c '^Tianshu_' || true) 个 Tianshu_* 对象）✓"

step "前置检查 4/${PTOTAL}：website checkout"
[ -d "$WEBSITE" ] || fail "website checkout 不存在：${WEBSITE}（publish-routing --website 需要）。用 --website 指定。"
echo "    $WEBSITE ✓"

step "前置检查 5/${PTOTAL}：AtomGit 已镜像 v$VER tag"
if ! HIT="$(GIT_TERMINAL_PROMPT=0 git ls-remote --tags "$ATOMGIT_GIT" "refs/tags/v$VER" 2>/dev/null)"; then
  fail "AtomGit tag 探测失败——不得跳过 AtomGit 或以 GitHub 单源继续发布"
fi
[ -n "$HIT" ] || fail "AtomGit 仓库没有 v$VER tag——先完成镜像；不得跳过 AtomGit 继续发布"
echo "    v$VER ✓"

# dry run 纯读：不写任何文件、不上传 OSS、不提交、不发布。写/对外动作全部留到 --publish。
if [ "$PUBLISH" != 1 ]; then
  echo ""
  echo "DRY RUN：前置检查全部通过，未执行任何写操作或对外请求。加 --publish 将依次执行："
  echo "    ① 同步二进制到 OSS 并刷新 legacy latest.json"
  echo "    ② 生成 release-catalog.json"
  echo "    ③ AtomGit 逐平台上传并匿名全包 + Range 验证"
  echo "    ④ AtomGit --metadata-only 发布 latest.json 与原始 release-catalog.json"
  echo "    ⑤ 提交 release-catalog.json"
  echo "    ⑥ 推送 catalog 到 GitHub release + 根/版本固定 OSS，并验证三条 URL"
  echo ""
  echo "确认后加 --publish 执行对外发布（不可逆）。"
  exit 0
fi

step "1/6 OSS 二进制 + legacy latest.json"
if [ "$SKIP_OSS" = 1 ]; then
  echo "    跳过（--skip-oss）"
else
  OSS_ASSET_DIR=release bash scripts/upload-update-to-oss.sh
fi

step "2/6 生成 release-catalog.json"
node scripts/releases/generate-catalog.mjs

step "3/6 AtomGit 上传（逐平台 + 匿名全包/Range 验证）"
# install 是网站手动下载用的，AtomGit 只承载 updater 包及其签名和 checksum。
PLATFORMS="$(node -e "console.log(Object.keys(require('./latest.json').platforms).join(' '))")"
for p in $PLATFORMS; do
  echo "    → ${p}"
  node scripts/releases/publish-atomgit.mjs --publish --platform "$p" --purpose update --assets-only
done
# 只有每个包实际通过匿名验证后，--atomgit 才会写入 verified:true, anonymous:true。
node scripts/releases/generate-catalog.mjs --atomgit

step "4/6 发布 AtomGit 固定版本元数据"
node scripts/releases/publish-atomgit.mjs --metadata-only --catalog release-catalog.json --assets release --publish

step "5/6 提交 release-catalog.json"
if [ "$NO_COMMIT" = 1 ]; then
  echo "    跳过（--no-commit）"
elif [ -n "$(git status --porcelain -- release-catalog.json)" ]; then
  git commit -m "chore(release): release-catalog v$VER" -- release-catalog.json
else
  echo "    无变化，跳过"
fi

step "6/6 发布 catalog 到 GitHub release + 根/版本固定 OSS"
node scripts/releases/publish-routing.mjs --publish --release-notes-reviewed --website "$WEBSITE"

step "后置验证：三条 catalog URL 应返回 v$VER"
# GitHub 新上传资产的公开端点有分钟级传播延迟（实测 ~90s 内 404，之后 200）；
# OSS 通常即时。无重试会把成功误报成失败、诱导重跑（重复上传 1.39GB）。
rc=0
check() {
  local url="$1" label="$2" got=FAIL attempt
  for attempt in 1 2 3 4 5 6; do
    got="$(curl -sSL -m 20 "$url" 2>/dev/null | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).version" 2>/dev/null || echo FAIL)"
    [ "$got" = "$VER" ] && break
    if [ "$attempt" -lt 6 ]; then echo "    … $label 未就绪（第 $attempt 次），30s 后重试"; sleep 30; fi
  done
  printf '    %-7s %s\n' "$label" "$got"
  [ "$got" = "$VER" ] || { echo "    ✗ $label 未返回 v$VER"; rc=1; }
}
check "https://tianshu-update.oss-cn-hangzhou.aliyuncs.com/tianshu/v$VER/release-catalog.json" "OSS-pin"
check "https://tianshu-update.oss-cn-hangzhou.aliyuncs.com/tianshu/release-catalog.json" "OSS"
check "https://github.com/$REPO/releases/latest/download/release-catalog.json" "GitHub"
[ "$rc" = 0 ] || fail "线上 catalog 校验未通过——检查 OSS/GitHub 权限与 CDN"
echo ""
echo "✅ v$VER 发布收口完成：国内源自更新路由已生效。"
