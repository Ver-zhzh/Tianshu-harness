import type { MirrorsConfig } from '../config/schema.js'

/**
 * When autoFallback is enabled, inject git early-fail env vars so that
 * `git clone https://github.com/...` commands abort quickly on slow
 * connections (instead of hanging for 2 minutes). This lets the user see
 * the error and manually try a mirror.
 */
export function gitCloneEarlyFailEnv(command: string, config: MirrorsConfig): Record<string, string> {
  if (config.autoFallback === false) return {}
  if (!/\bgit\b.*\bclone\b.*github\.com/.test(command)) return {}
  return {
    GIT_HTTP_LOW_SPEED_LIMIT: '1000',
    GIT_HTTP_LOW_SPEED_TIME: '15',
  }
}

export type MirrorEcosystem = 'npm' | 'pypi' | 'go' | 'rust' | 'github'

export type GithubMirrorId = NonNullable<MirrorsConfig['github']>
export type NpmMirrorId = NonNullable<MirrorsConfig['npm']>
export type PypiMirrorId = NonNullable<MirrorsConfig['pypi']>
export type GoMirrorId = NonNullable<MirrorsConfig['go']>
export type RustMirrorId = NonNullable<MirrorsConfig['rust']>

export interface GithubMirror {
  id: GithubMirrorId
  name: string
  /** URL template with `{repo}` placeholder, e.g. `https://kkgithub.com/{repo}`. */
  template: string
}

/**
 * Verified-alive GitHub git mirrors ONLY (issue #524, 2026-10-20 probes).
 * Dropped dead entries — do NOT re-add without re-probing `git ls-remote`:
 * - `gitcode.com/gh_mirror/{repo}` prefix: 403 for every repo (incl. facebook/react)
 * - kkgithub.com: TLS cert no longer covers the host (SSL mismatch)
 * - hub.fastgit.xyz: defunct (connection timeout)
 * Legacy ids stay in the schema enum for persisted-config compatibility and
 * resolve to undefined here → fail-open direct github.
 */
export const GITHUB_MIRRORS: Partial<Record<Exclude<GithubMirrorId, 'default'>, GithubMirror>> = {
  ghproxy: { id: 'ghproxy', name: 'ghproxy 前缀代理', template: 'https://ghproxy.net/https://github.com/{repo}' },
  gitcode: { id: 'gitcode', name: 'GitCode（仅已收录仓库）', template: 'https://gitcode.com/{repo}' },
}

export const NPM_MIRRORS: Record<Exclude<NpmMirrorId, 'default'>, string> = {
  taobao: 'https://registry.npmmirror.com',
  tencent: 'https://mirrors.cloud.tencent.com/npm/',
  huawei: 'https://repo.huaweicloud.com/repository/npm/',
}

export const PYPI_MIRRORS: Record<Exclude<PypiMirrorId, 'default'>, { url: string; trustedHost: string }> = {
  tsinghua: { url: 'https://pypi.tuna.tsinghua.edu.cn/simple', trustedHost: 'pypi.tuna.tsinghua.edu.cn' },
  aliyun: { url: 'https://mirrors.aliyun.com/pypi/simple/', trustedHost: 'mirrors.aliyun.com' },
  tencent: { url: 'https://mirrors.cloud.tencent.com/pypi/simple/', trustedHost: 'mirrors.cloud.tencent.com' },
}

export const GO_MIRRORS: Record<Exclude<GoMirrorId, 'default'>, string> = {
  goproxy_cn: 'https://goproxy.cn,direct',
  aliyun: 'https://mirrors.aliyun.com/goproxy/,direct',
}

export const RUST_MIRRORS: Record<Exclude<RustMirrorId, 'default'>, { dist: string; update: string }> = {
  tsinghua: {
    dist: 'https://mirrors.tuna.tsinghua.edu.cn/rustup',
    update: 'https://mirrors.tuna.tsinghua.edu.cn/rustup/rustup',
  },
  tuna: {
    dist: 'https://mirrors.tuna.tsinghua.edu.cn/rustup',
    update: 'https://mirrors.tuna.tsinghua.edu.cn/rustup/rustup',
  },
  ustc: {
    dist: 'https://mirrors.ustc.edu.cn/rust-static',
    update: 'https://mirrors.ustc.edu.cn/rust-static/rustup',
  },
}

/** Preset defaults when `preset: 'china'` and an ecosystem is set to 'default'. */
const CHINA_PRESET: Omit<Required<MirrorsConfig>, 'enabled'> = {
  preset: 'china',
  github: 'ghproxy',
  npm: 'taobao',
  pypi: 'tsinghua',
  go: 'goproxy_cn',
  rust: 'tsinghua',
  autoFallback: true,
  fallbackMemoryMinutes: 10,
  fallbackTimeoutSec: 60,
}

function resolveWithPreset(
  value: string,
  preset: MirrorsConfig['preset'],
  presetValue: string,
): string | undefined {
  if (value !== 'default') return value
  if (preset === 'china') return presetValue
  return undefined
}

/** Build environment variables to inject into bash executions for enabled mirrors. */
export function buildMirrorEnv(config: MirrorsConfig): Record<string, string> {
  if (!config.enabled) return {}

  const env: Record<string, string> = {}

  const npmId = resolveWithPreset(config.npm, config.preset, CHINA_PRESET.npm) as Exclude<NpmMirrorId, 'default'> | undefined
  if (npmId) {
    const url = NPM_MIRRORS[npmId]
    env.npm_config_registry = url
    env.YARN_REGISTRY = url
    env.PNPM_REGISTRY = url
  }

  const pypiId = resolveWithPreset(config.pypi, config.preset, CHINA_PRESET.pypi) as Exclude<PypiMirrorId, 'default'> | undefined
  if (pypiId) {
    const mirror = PYPI_MIRRORS[pypiId]
    env.PIP_INDEX_URL = mirror.url
    env.PIP_TRUSTED_HOST = mirror.trustedHost
  }

  const goId = resolveWithPreset(config.go, config.preset, CHINA_PRESET.go) as Exclude<GoMirrorId, 'default'> | undefined
  if (goId) {
    env.GOPROXY = GO_MIRRORS[goId]
  }

  const rustId = resolveWithPreset(config.rust, config.preset, CHINA_PRESET.rust) as Exclude<RustMirrorId, 'default'> | undefined
  if (rustId) {
    const mirror = RUST_MIRRORS[rustId]
    env.RUSTUP_DIST_SERVER = mirror.dist
    env.RUSTUP_UPDATE_ROOT = mirror.update
  }

  // Git URL rewriting (issue #524): fold buildGitMirrorEnv in so every
  // consumer of buildMirrorEnv (bash foreground/background, monitor spawn)
  // gets consistent insteadOf behavior without remembering to compose it.
  Object.assign(env, buildGitMirrorEnv(config))

  return env
}

/** Resolve the effective GitHub mirror id, applying preset defaults.
 * Returns undefined for legacy dead mirrors (kkgithub/fastgit) → fail-open
 * direct github. */
export function resolveGithubMirrorId(config: MirrorsConfig): Exclude<GithubMirrorId, 'default'> | undefined {
  if (!config.enabled) return undefined
  const id = resolveWithPreset(config.github, config.preset, CHINA_PRESET.github) as Exclude<GithubMirrorId, 'default'> | undefined
  return id && GITHUB_MIRRORS[id] ? id : undefined
}

/**
 * Git URL-rewrite env for the bash tool (issue #524).
 *
 * Replaces the old blind text substitution (rewriteGitHubUrls, removed):
 * injecting `url.<mirror>.insteadOf=github.com` + `url.github.pushInsteadOf=
 * github.com` via GIT_CONFIG_* env vars means —
 * - clone/fetch/pull transparently go through the mirror;
 * - push goes to the ORIGINAL github.com (identity pushInsteadOf wins over
 *   insteadOf; verified by probe 2026-10-20);
 * - `.git/config` always stores the original URL — no persistent pollution,
 *   disabling the switch fully restores prior behavior;
 * - command text (echo/remote add/curl args) is never touched.
 *
 * Prefix-proxy templates keep the full github URL in the target (`…/https://
 * github.com/{repo}`), so the insteadOf key embeds the github prefix and the
 * {repo} suffix carries over — probe-verified against a local bare-repo pair.
 */
export function buildGitMirrorEnv(config: MirrorsConfig): Record<string, string> {
  const mirrorId = resolveGithubMirrorId(config)
  if (!mirrorId) return {}
  const mirror = GITHUB_MIRRORS[mirrorId]
  if (!mirror) return {}
  // template = <mirror-prefix>{repo}; insteadOf key = prefix with {repo} dropped
  const mirrorBase = mirror.template.replace('/{repo}', '/')
  return {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: `url.${mirrorBase}.insteadOf`,
    GIT_CONFIG_VALUE_0: 'https://github.com/',
    GIT_CONFIG_KEY_1: 'url.https://github.com/.pushInsteadOf',
    GIT_CONFIG_VALUE_1: 'https://github.com/',
  }
}

/**
 * Recovery hint for repos already polluted by the pre-#524 URL rewriter,
 * which persisted dead `gitcode.com/gh_mirror/<owner>/<repo>` remotes into
 * .git/config. Detected from git failure stderr; returns undefined otherwise.
 */
export function mirrorFailureHint(stderr: string): string | undefined {
  const m = stderr.match(/gitcode\.com\/gh_mirror\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?['"\s]/)
  if (!m) return undefined
  return [
    `检测到已被旧版镜像改写污染的 remote 地址（${m[1]}）。旧版「用国内源下载」曾把 github.com 地址改写为不可用的 gitcode.com/gh_mirror 并持久化进 .git/config（issue #524），已修复。`,
    `还原：git remote set-url origin https://github.com/${m[1]}.git`,
  ].join('\n')
}

/** Human-readable summary of the effective mirror settings. */
export function formatMirrorStatus(config: MirrorsConfig): string {
  const lines: string[] = []
  lines.push(`Mirror mode: ${config.enabled ? 'enabled' : 'disabled'}`)
  if (config.enabled) {
    lines.push(`Preset: ${config.preset}`)
    const github = resolveGithubMirrorId(config)
    const githubMirror = github ? GITHUB_MIRRORS[github] : undefined
    lines.push(`GitHub mirror: ${githubMirror ? githubMirror.name : '(none)'}`)
    const npm = resolveWithPreset(config.npm, config.preset, CHINA_PRESET.npm) as Exclude<NpmMirrorId, 'default'> | undefined
    lines.push(`npm mirror: ${npm ? NPM_MIRRORS[npm] : '(none)'}`)
    const pypi = resolveWithPreset(config.pypi, config.preset, CHINA_PRESET.pypi) as Exclude<PypiMirrorId, 'default'> | undefined
    lines.push(`PyPI mirror: ${pypi ? PYPI_MIRRORS[pypi].url : '(none)'}`)
    const go = resolveWithPreset(config.go, config.preset, CHINA_PRESET.go) as Exclude<GoMirrorId, 'default'> | undefined
    lines.push(`Go proxy: ${go ? GO_MIRRORS[go] : '(none)'}`)
    const rust = resolveWithPreset(config.rust, config.preset, CHINA_PRESET.rust) as Exclude<RustMirrorId, 'default'> | undefined
    lines.push(`Rust mirror: ${rust ? RUST_MIRRORS[rust].dist : '(none)'}`)
  }
  return lines.join('\n')
}
