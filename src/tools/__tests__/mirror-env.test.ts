import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildMirrorEnv, buildGitMirrorEnv, resolveGithubMirrorId, mirrorFailureHint, GITHUB_MIRRORS, formatMirrorStatus } from '../mirror-env.js'
import type { MirrorsConfig } from '../../config/schema.js'

describe('mirror-env', () => {
  const base: MirrorsConfig = {
    enabled: false,
    preset: 'default',
    github: 'default',
    npm: 'default',
    pypi: 'default',
    go: 'default',
    rust: 'default',
    autoFallback: true,
    fallbackMemoryMinutes: 10,
    fallbackTimeoutSec: 60,
  }

  describe('buildMirrorEnv', () => {
    it('returns empty env when disabled', () => {
      const env = buildMirrorEnv(base)
      assert.deepEqual(env, {})
    })

    it('injects china preset env vars', () => {
      const env = buildMirrorEnv({ ...base, enabled: true, preset: 'china' })
      assert.equal(env.npm_config_registry, 'https://registry.npmmirror.com')
      assert.equal(env.YARN_REGISTRY, 'https://registry.npmmirror.com')
      assert.equal(env.PNPM_REGISTRY, 'https://registry.npmmirror.com')
      assert.equal(env.PIP_INDEX_URL, 'https://pypi.tuna.tsinghua.edu.cn/simple')
      assert.equal(env.PIP_TRUSTED_HOST, 'pypi.tuna.tsinghua.edu.cn')
      assert.equal(env.GOPROXY, 'https://goproxy.cn,direct')
      assert.equal(env.RUSTUP_DIST_SERVER, 'https://mirrors.tuna.tsinghua.edu.cn/rustup')
      assert.equal(env.RUSTUP_UPDATE_ROOT, 'https://mirrors.tuna.tsinghua.edu.cn/rustup/rustup')
    })

    it('respects per-ecosystem overrides', () => {
      const env = buildMirrorEnv({
        ...base,
        enabled: true,
        preset: 'china',
        npm: 'huawei',
        pypi: 'aliyun',
        go: 'aliyun',
        rust: 'ustc',
      })
      assert.equal(env.npm_config_registry, 'https://repo.huaweicloud.com/repository/npm/')
      assert.equal(env.PIP_INDEX_URL, 'https://mirrors.aliyun.com/pypi/simple/')
      assert.equal(env.PIP_TRUSTED_HOST, 'mirrors.aliyun.com')
      assert.equal(env.GOPROXY, 'https://mirrors.aliyun.com/goproxy/,direct')
      assert.equal(env.RUSTUP_DIST_SERVER, 'https://mirrors.ustc.edu.cn/rust-static')
      assert.equal(env.RUSTUP_UPDATE_ROOT, 'https://mirrors.ustc.edu.cn/rust-static/rustup')
    })

    it('default preset with explicit mirrors still works', () => {
      const env = buildMirrorEnv({
        ...base,
        enabled: true,
        preset: 'default',
        npm: 'taobao',
      })
      assert.equal(env.npm_config_registry, 'https://registry.npmmirror.com')
      assert.equal(env.PIP_INDEX_URL, undefined)
    })
  })

  // ── issue #524: git 层改用 GIT_CONFIG_* env 注入 insteadOf/pushInsteadOf，
  // 不再改写命令文本——.git/config 永远存原始 github 地址，push 永走原站。
  describe('git insteadOf env injection', () => {
    it('injects insteadOf + pushInsteadOf via GIT_CONFIG_COUNT env (china preset → ghproxy)', () => {
      const env = buildMirrorEnv({ ...base, enabled: true, preset: 'china' })
      assert.equal(env.GIT_CONFIG_COUNT, '2')
      // fetch/clone/pull → mirror prefix (proxy keeps full github URL intact)
      assert.equal(env.GIT_CONFIG_KEY_0, 'url.https://ghproxy.net/https://github.com/.insteadOf')
      assert.equal(env.GIT_CONFIG_VALUE_0, 'https://github.com/')
      // push → original github (mirror is read-only; identity mapping overrides insteadOf)
      assert.equal(env.GIT_CONFIG_KEY_1, 'url.https://github.com/.pushInsteadOf')
      assert.equal(env.GIT_CONFIG_VALUE_1, 'https://github.com/')
    })

    it('gitcode mirror uses direct-path insteadOf', () => {
      const env = buildMirrorEnv({ ...base, enabled: true, github: 'gitcode' })
      assert.equal(env.GIT_CONFIG_KEY_0, 'url.https://gitcode.com/.insteadOf')
      assert.equal(env.GIT_CONFIG_VALUE_0, 'https://github.com/')
      assert.equal(env.GIT_CONFIG_KEY_1, 'url.https://github.com/.pushInsteadOf')
    })

    it('no git env when mirror disabled or github=default (no preset)', () => {
      const off = buildMirrorEnv({ ...base, enabled: true })
      assert.equal(off.GIT_CONFIG_COUNT, undefined)
      const presetChinaGithubDefault = buildMirrorEnv({ ...base, enabled: true, preset: 'china', github: 'default' })
      // china preset resolves github → ghproxy even with 'default' (preset semantics)
      assert.equal(presetChinaGithubDefault.GIT_CONFIG_COUNT, '2')
    })

    it('legacy dead mirrors (kkgithub/fastgit) fail open: no git env, no throw', () => {
      // Schema enum keeps legacy values for persisted-config compatibility; the
      // mirror table drops them, so resolution returns undefined → direct github.
      const kk = buildMirrorEnv({ ...base, enabled: true, github: 'kkgithub' })
      assert.equal(kk.GIT_CONFIG_COUNT, undefined)
      const fg = buildMirrorEnv({ ...base, enabled: true, github: 'fastgit' })
      assert.equal(fg.GIT_CONFIG_COUNT, undefined)
      assert.equal(resolveGithubMirrorId({ ...base, enabled: true, github: 'kkgithub' }), undefined)
    })

    it('GITHUB_MIRRORS table only contains verified-alive mirrors', () => {
      // issue #524: gh_mirror prefix 403s, kkgithub TLS-dead, fastgit defunct.
      assert.deepEqual(Object.keys(GITHUB_MIRRORS).sort(), ['ghproxy', 'gitcode'])
    })
  })

  // ── issue #524 遗留污染：曾把 remote URL 持久化写成死镜像地址的仓库，
  // 失败输出必须给出精确还原指引。
  describe('mirrorFailureHint', () => {
    it('detects legacy gh_mirror pollution and emits exact restore command', () => {
      const stderr = "remote: <CH.00905403> The project you were looking for could not be found.\nfatal: unable to access 'https://gitcode.com/gh_mirror/foo/bar.git/': The requested URL returned error: 403"
      const hint = mirrorFailureHint(stderr)
      assert.ok(hint, 'should produce a hint')
      assert.ok(hint.includes('git remote set-url origin https://github.com/foo/bar.git'), 'hint must contain the exact restore command')
      assert.ok(hint.includes('镜像'))
    })

    it('handles .git-less pollution URLs', () => {
      const hint = mirrorFailureHint("fatal: unable to access 'https://gitcode.com/gh_mirror/a/b/': 403")
      assert.ok(hint?.includes('git remote set-url origin https://github.com/a/b.git'))
    })

    it('no hint for ordinary github failures', () => {
      assert.equal(mirrorFailureHint("fatal: unable to access 'https://github.com/foo/bar.git/': 403"), undefined)
      assert.equal(mirrorFailureHint('connection timed out'), undefined)
    })

    it('no hint for empty stderr', () => {
      assert.equal(mirrorFailureHint(''), undefined)
    })
  })

  describe('formatMirrorStatus', () => {
    it('reports disabled', () => {
      const text = formatMirrorStatus(base)
      assert.ok(text.includes('disabled'))
    })

    it('lists effective mirrors when enabled', () => {
      const text = formatMirrorStatus({ ...base, enabled: true, preset: 'china' })
      assert.ok(text.includes('enabled'))
      assert.ok(text.includes('ghproxy'))
      assert.ok(text.includes('registry.npmmirror.com'))
    })
  })
})
