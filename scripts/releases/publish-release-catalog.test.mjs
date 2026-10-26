import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { delimiter, dirname, join } from 'node:path'

// scripts/releases/ -> 仓库根
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = 'scripts/releases/publish-release-catalog.sh'
const manifest = JSON.parse(readFileSync(join(root, 'latest.json'), 'utf8'))
const manifestAssets = Object.values(manifest.platforms).map(platform => new URL(platform.url).pathname.split('/').pop())
const quotedAssets = manifestAssets.map(name => "'" + name.replaceAll("'", "'\\''") + "'").join(' ')

function resolveBash() {
  if (process.platform !== 'win32') return 'bash'
  const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe'
  if (existsSync(gitBash)) return gitBash
  const localBash = join(process.env.LOCALAPPDATA || '', 'Programs\\Git\\bin\\bash.exe')
  if (existsSync(localBash)) return localBash
  return 'bash'
}
const BASH = resolveBash()

const run = (args = [], env) => {
  assert.ok(!args.includes('--publish'), '通用 runner 只允许 dry-run；发布链必须在临时仓库全 stub')
  return spawnSync(BASH, [SCRIPT, ...args], { cwd: root, encoding: 'utf8', env: env ?? process.env, windowsHide: true })
}

/** 造假的 gh/git 隔离前置网络；发布写路径另有临时仓库测试。 */
function withStubGh(body, gitBody = `if [ "$1" = ls-remote ]; then printf 'fixture\\trefs/tags/fixture\\n'; fi`) {
  const dir = mkdtempSync(join(tmpdir(), 'prc-stub-'))
  for (const [name, script] of [['gh', body], ['git', gitBody]]) {
    const file = join(dir, name)
    writeFileSync(file, `#!/usr/bin/env bash\n${script}\n`)
    try { chmodSync(file, 0o755) } catch {}
  }
  return { website: dir.replace(/\\/g, '/'), env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` }, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// release 存在、isDraft 可配、资产齐（含 latest.json 三平台引用的文件名）。
const stubGh = isDraft => `
if [ "$1" = release ] && [ "$2" = view ]; then
  case "$*" in
    *--json\\ isDraft*) echo ${isDraft} ;;
    *--json\\ assets*) printf '%s\\n' ${quotedAssets} ;;
  esac
  exit 0
fi
exit 0
`

test('publish-release-catalog.sh 语法正确', () => {
  const r = spawnSync(BASH, ['-n', SCRIPT], { cwd: root, encoding: 'utf8', windowsHide: true })
  assert.equal(r.status, 0, r.stderr)
})

test('未知参数以退出码 2 拒绝（不静默吞掉）', () => {
  const r = run(['--nope'])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /未知参数/)
})

test('候选版本不得借稳定版收口脚本绕过受控晋升', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prc-candidate-'))
  try {
    mkdirSync(join(dir, 'scripts/releases'), { recursive: true })
    copyFileSync(join(root, SCRIPT), join(dir, SCRIPT))
    copyFileSync(join(root, 'latest.json'), join(dir, 'latest.json'))
    writeFileSync(join(dir, 'update-control.json'), JSON.stringify({ stable: { version: '0.0.0' } }))
    const result = spawnSync(BASH, [SCRIPT], { cwd: dir, encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /受控稳定版.*stage.*promote/)
    assert.ok(!result.stdout.includes('前置检查'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// 核心安全不变量：dry run 是纯读——不得上传 OSS、不得生成/提交 catalog、不得发布。
// 用各下游步骤自身的输出指纹当探针（dry-run 的计划文本刻意不含这些串）：
//   upload-update-to-oss.sh -> "==> 同步"
//   generate-catalog.mjs    -> "Validated v"
//   publish-routing.mjs     -> "Published v"
test('默认 dry-run 不执行任何写或对外步骤', () => {
  const s = withStubGh(stubGh('false'))
  try {
    const r = run(['--website', s.website], s.env)
    assert.equal(r.status, 0, r.stderr)
    assert.ok(!r.stdout.includes('==> 同步'), 'dry-run 不得运行 upload-update-to-oss.sh')
    assert.ok(!r.stdout.includes('Validated v'), 'dry-run 不得运行 generate-catalog.mjs')
    assert.ok(!r.stdout.includes('Published v'), 'dry-run 不得运行 publish-routing.mjs')
  } finally { s.cleanup() }
})

test('前置不齐必须 fail-closed，不得进入 DRY RUN 或发布步骤', () => {
  const s = withStubGh(stubGh('false'))
  try {
    const r = run(['--website', join(s.website, 'missing')], s.env)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /✗/)
    assert.ok(!r.stdout.includes('DRY RUN'))
  } finally { s.cleanup() }
})

// draft release 不会被 releases/latest 解析——catalog 传上去客户端也读不到，必须拦下。
test('release 仍是 draft 时 fail-closed', () => {
  const s = withStubGh(stubGh('true'))
  try {
    const r = run(['--website', s.website], s.env)
    assert.notEqual(r.status, 0, 'draft release 应被拦截')
    assert.match(r.stderr, /draft/)
    assert.ok(!r.stdout.includes('DRY RUN'), 'draft 不得放行到发布流程')
  } finally { s.cleanup() }
})

// 前置全过（stub 假装 release 已发布、资产齐）时，dry-run 应停在 DRY RUN 且零副作用。
test('前置全过时停在 DRY RUN 且不触发任何写/对外步骤', () => {
  const s = withStubGh(stubGh('false'))
  try {
    const r = run(['--website', s.website], s.env)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /DRY RUN/)
    assert.match(r.stdout, /--metadata-only/)
    assert.ok(!r.stdout.includes('==> 同步'))
    assert.ok(!r.stdout.includes('Validated v'))
    assert.ok(!r.stdout.includes('Published v'))
  } finally { s.cleanup() }
})

test('显式 --skip-atomgit 在任何发布步骤前 fail-closed', () => {
  const s = withStubGh(stubGh('false'))
  try {
    const r = run(['--website', s.website, '--skip-atomgit'], s.env)
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /--skip-atomgit 不允许/)
    assert.ok(!r.stdout.includes('DRY RUN'))
    assert.ok(!r.stdout.includes('1/6 OSS'))
  } finally { s.cleanup() }
})

test('AtomGit 缺 tag 时 dry-run 也 fail-closed，不得自动降级', () => {
  const s = withStubGh(stubGh('false'), 'exit 0')
  try {
    const r = run(['--website', s.website], s.env)
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /AtomGit 仓库没有 v.* tag/)
    assert.ok(!r.stdout.includes('DRY RUN'))
    assert.ok(!r.stdout.includes('1/6 OSS'))
  } finally { s.cleanup() }
})

test('AtomGit tag 探测失败不得被当成缺 tag 后自动跳过', () => {
  const s = withStubGh(stubGh('false'), 'exit 23')
  try {
    const r = run(['--website', s.website], s.env)
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /AtomGit tag 探测失败/)
    assert.ok(!r.stdout.includes('DRY RUN'))
    assert.ok(!r.stdout.includes('1/6 OSS'))
  } finally { s.cleanup() }
})

test('临时仓库完整模拟：三平台后才发布 AtomGit metadata，再进入 routing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prc-full-'))
  const copy = (source, target) => { mkdirSync(dirname(target), { recursive: true }); copyFileSync(source, target) }
  const log = join(dir, 'calls.log')
  try {
    copy(join(root, SCRIPT), join(dir, SCRIPT))
    copy(join(root, 'scripts/releases/release-notes.mjs'), join(dir, 'scripts/releases/release-notes.mjs'))
    copy(join(root, 'latest.json'), join(dir, 'latest.json'))
    copy(join(root, 'update-control.json'), join(dir, 'update-control.json'))
    copy(join(root, `docs/releases/summaries/${manifest.version}.json`), join(dir, `docs/releases/summaries/${manifest.version}.json`))
    for (const name of ['generate-catalog.mjs', 'publish-atomgit.mjs', 'publish-routing.mjs']) {
      writeFileSync(join(dir, 'scripts/releases', name), `import { appendFileSync } from 'node:fs'\nappendFileSync(process.env.RELEASE_TEST_LOG, ${JSON.stringify(name)} + ' ' + process.argv.slice(2).join(' ') + '\\n')\n`)
    }
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(join(dir, 'scripts/upload-update-to-oss.sh'), `#!/usr/bin/env bash\nprintf 'upload-update-to-oss.sh %s\\n' "$*" >> "$RELEASE_TEST_LOG"\n`)
    const bin = join(dir, 'bin'); mkdirSync(bin)
    const commands = {
      gh: stubGh('false'),
      git: `if [ "$1" = ls-remote ]; then printf 'fixture\\trefs/tags/fixture\\n'; fi`,
      curl: `printf '{"version":"%s"}\\n' "$RELEASE_TEST_VERSION"`,
    }
    for (const [name, body] of Object.entries(commands)) {
      const file = join(bin, name); writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`)
      try { chmodSync(file, 0o755) } catch {}
    }
    const result = spawnSync(BASH, [SCRIPT, '--publish', '--no-commit', '--website', dir], { cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, RELEASE_TEST_LOG: log, RELEASE_TEST_VERSION: manifest.version } })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /OSS-pin/, 'wrapper 后置检查必须覆盖版本固定 OSS catalog')
    const calls = readFileSync(log, 'utf8').trim().split('\n')
    const packageCalls = calls.filter(line => line.startsWith('publish-atomgit.mjs') && line.includes('--assets-only'))
    assert.equal(packageCalls.length, Object.keys(manifest.platforms).length)
    const regenerate = calls.findIndex(line => line.startsWith('generate-catalog.mjs') && line.includes('--atomgit'))
    const metadata = calls.findIndex(line => line.startsWith('publish-atomgit.mjs') && line.includes('--metadata-only'))
    const routing = calls.findIndex(line => line.startsWith('publish-routing.mjs'))
    assert.ok(packageCalls.every((_, index) => calls.indexOf(packageCalls[index]) < regenerate))
    assert.ok(regenerate >= 0 && regenerate < metadata, calls.join('\n'))
    assert.ok(metadata < routing, 'AtomGit 固定版本元数据必须先于 routing')
    assert.match(calls[metadata], /--catalog release-catalog\.json --assets release --publish/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
