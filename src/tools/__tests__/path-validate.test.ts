import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, linkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { validatePath, validatePathSafe } from '../path-validate.js'
import { withWorkspaceRoots } from '../workspace-context.js'
import { grantPath, _resetGrantsForTest } from '../path-grants.js'

describe('validatePath', () => {
  it('allows files within cwd', () => {
    const result = validatePath('/home/user/project', 'src/file.ts')
    assert.equal(result, resolvePath('/home/user/project', 'src/file.ts'))
  })

  it('allows cwd itself', () => {
    const result = validatePath('/home/user/project', '.')
    assert.equal(result, resolvePath('/home/user/project', '.'))
  })

  it('rejects parent directory traversal', () => {
    assert.throws(
      () => validatePath('/home/user/project', '../../etc/passwd'),
      /Path outside project directory/,
    )
  })

  it('rejects sibling directory with common prefix', () => {
    assert.throws(
      () => validatePath('/home/user/app', '../app-backup/secrets'),
      /Path outside project directory/,
    )
  })

  it('rejects absolute path outside cwd', () => {
    assert.throws(
      () => validatePath('/home/user/project', '/etc/passwd'),
      /Path outside project directory/,
    )
  })

  it('normalizes path with double slashes', () => {
    const result = validatePath('/home/user/project', 'src//file.ts')
    assert.equal(result, resolvePath('/home/user/project', 'src//file.ts'))
  })

  it('rejects path that resolves outside via symlink-like traversal', () => {
    assert.throws(
      () => validatePath('/home/user/project', 'src/../../../etc/shadow'),
      /Path outside project directory/,
    )
  })

  it('allows deeply nested files within cwd', () => {
    const result = validatePath('/home/user/project', 'a/b/c/d/e/file.ts')
    assert.equal(result, resolvePath('/home/user/project', 'a/b/c/d/e/file.ts'))
  })
})

describe('validatePathSafe', () => {
  it('returns ok for valid paths', () => {
    const result = validatePathSafe('/home/user/project', 'src/file.ts')
    assert.deepEqual(result, { ok: true, path: resolvePath('/home/user/project', 'src/file.ts') })
  })

  it('returns error for traversal', () => {
    const result = validatePathSafe('/home/user/project', '../etc/passwd')
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /outside project directory/)
  })
})

describe('validatePathSafe with out-of-workspace grants', () => {
  beforeEach(() => _resetGrantsForTest())

  it('allows an out-of-workspace path once a read grant covers it', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-cwd-'))
    const external = mkdtempSync(join(tmpdir(), 'rivet-ext-'))
    try {
      // Without a grant: rejected.
      const before = validatePathSafe(cwd, join(external, 'data.json'), 'read')
      assert.equal(before.ok, false)

      grantPath(external, 'read')
      const after = validatePathSafe(cwd, join(external, 'data.json'), 'read')
      assert.equal(after.ok, true)

      // A read grant must NOT satisfy a write op.
      const write = validatePathSafe(cwd, join(external, 'data.json'), 'write')
      assert.equal(write.ok, false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(external, { recursive: true, force: true })
    }
  })

  it('allows an out-of-workspace write once a write grant covers it', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-cwd-'))
    const external = mkdtempSync(join(tmpdir(), 'rivet-ext-'))
    try {
      grantPath(external, 'write')
      const w = validatePathSafe(cwd, join(external, 'out.zip'), 'write')
      assert.equal(w.ok, true)
      const r = validatePathSafe(cwd, join(external, 'out.zip'), 'read')
      assert.equal(r.ok, true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(external, { recursive: true, force: true })
    }
  })

  it('upgraded error hints at request_path_access', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-cwd-'))
    try {
      const r = validatePathSafe(cwd, '/etc/hosts', 'read')
      assert.equal(r.ok, false)
      if (!r.ok) assert.match(r.error, /request_path_access/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('validatePathSafe — sensitive file hard gate across path forms (M3)', () => {
  beforeEach(() => _resetGrantsForTest())

  function makeCwd(): string {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-sens-'))
    mkdirSync(join(cwd, 'scripts'), { recursive: true })
    return cwd
  }

  it('blocks .env inside the workspace', () => {
    const cwd = makeCwd()
    try {
      const r = validatePathSafe(cwd, '.env', 'read')
      assert.equal(r.ok, false)
      if (!r.ok) assert.match(r.error, /Sensitive file blocked/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('blocks NTFS stream forms of an existing .env (::$DATA reads the main stream on Win32)', () => {
    const cwd = makeCwd()
    try {
      writeFileSync(join(cwd, '.env'), 'SECRET=1\n')
      for (const p of ['.env::$DATA', '.ENV::$data', join('scripts', '..', '.env::$DATA')]) {
        const r = validatePathSafe(cwd, p, 'read')
        assert.equal(r.ok, false, p)
        if (!r.ok) assert.match(r.error, /Sensitive file blocked/)
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('blocks scripts/../.env — whitelist is evaluated on the canonicalized form, not the raw prefix', () => {
    const cwd = makeCwd()
    try {
      const r = validatePathSafe(cwd, join('scripts', '..', '.env'), 'read')
      assert.equal(r.ok, false)
      if (!r.ok) assert.match(r.error, /Sensitive file blocked/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('blocks trailing-slash / trailing-dot / case variants', () => {
    const cwd = makeCwd()
    try {
      for (const p of ['.env/', '.env.', '.ENV', join('config', '.Env.Local')]) {
        const r = validatePathSafe(cwd, p, 'read')
        assert.equal(r.ok, false, `${p} must be blocked`)
        if (!r.ok) assert.match(r.error, /Sensitive file blocked/)
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('blocks the realpath form when the raw name is obfuscated (existing file, resolved name is sensitive)', () => {
    const cwd = makeCwd()
    try {
      // 真实存在的伪装文件：裸名不带敏感后缀，但 realpath/resolve 后的规范名是 .env 变体。
      // 8.3 短名（CREDEN~1.JSON）在同一机制下收敛——realpath 展开后过敏感检测。
      writeFileSync(join(cwd, '.env.local'), 'X=1')
      const r = validatePathSafe(cwd, join(cwd, '.ENV.LOCAL'), 'read')
      assert.equal(r.ok, false)
      if (!r.ok) assert.match(r.error, /Sensitive file blocked/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('blocks Windows 8.3 short names (ENV~1 / CREDEN~1.JSO) of existing sensitive files', (t) => {
    const cwd = makeCwd()
    try {
      writeFileSync(join(cwd, '.env'), 'SECRET=1\n')
      writeFileSync(join(cwd, 'credentials.json'), '{}')
      if (!existsSync(join(cwd, 'ENV~1'))) { t.skip('volume does not generate 8.3 short names'); return }
      for (const p of ['ENV~1', 'env~1', 'CREDEN~1.JSO', join('scripts', '..', 'ENV~1')]) {
        const r = validatePathSafe(cwd, p, 'read')
        assert.equal(r.ok, false, p)
        if (!r.ok) assert.match(r.error, /Sensitive file blocked/)
      }
      const ok = validatePathSafe(cwd, 'README.md', 'read')
      assert.equal(ok.ok, true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('still allows whitelisted fixture/script paths (canonical form keeps the whitelist)', () => {
    const cwd = makeCwd()
    try {
      writeFileSync(join(cwd, 'scripts', 'gen-creds.ts'), 'x')
      const r = validatePathSafe(cwd, join('scripts', '..', 'scripts', 'gen-creds.ts'), 'read')
      assert.equal(r.ok, true, 'canonicalized scripts/ path stays whitelisted')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('sensitive check wins over the out-of-workspace error (fail-closed ordering kept)', () => {
    const cwd = makeCwd()
    try {
      const r = validatePathSafe(cwd, join('..', '.env'), 'read')
      assert.equal(r.ok, false)
      if (!r.ok) assert.match(r.error, /Sensitive file blocked/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('returns the original-cwd-based resolved path for clean files (contract unchanged)', () => {
    const cwd = makeCwd()
    try {
      const r = validatePathSafe(cwd, join('src', 'a.ts'), 'read')
      assert.deepEqual(r, { ok: true, path: join(cwd, 'src', 'a.ts') })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('validatePathSafe — hardlink gate (fail-closed)', () => {
  beforeEach(() => _resetGrantsForTest())

  function makeCwd(): string {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-hardlink-'))
    mkdirSync(join(cwd, 'proj'), { recursive: true })
    return cwd
  }

  it('blocks a hardlink inside cwd pointing at a file outside it (read + write)', () => {
    const cwd = makeCwd()
    const outside = mkdtempSync(join(tmpdir(), 'rivet-hardlink-out-'))
    try {
      const target = join(outside, 'secret.txt')
      writeFileSync(target, 'SECRET')
      const link = join(cwd, 'proj', 'notes.txt')
      linkSync(target, link)
      for (const mode of ['read', 'write'] as const) {
        const r = validatePathSafe(cwd, join('proj', 'notes.txt'), mode)
        assert.equal(r.ok, false, `mode=${mode}`)
        if (!r.ok) assert.match(r.error, /Hardlink blocked/)
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('blocks a hardlink even when all links look workspace-local', () => {
    const cwd = makeCwd()
    try {
      const a = join(cwd, 'proj', 'a.txt')
      writeFileSync(a, 'x')
      linkSync(a, join(cwd, 'proj', 'b.txt'))
      const r = validatePathSafe(cwd, join('proj', 'b.txt'), 'read')
      assert.equal(r.ok, false)
      if (!r.ok) assert.match(r.error, /Hardlink blocked/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('still allows normal single-link files and not-yet-existing paths', () => {
    const cwd = makeCwd()
    try {
      writeFileSync(join(cwd, 'proj', 'real.txt'), 'x')
      const okFile = validatePathSafe(cwd, join('proj', 'real.txt'), 'write')
      assert.equal(okFile.ok, true)
      const okNew = validatePathSafe(cwd, join('proj', 'new-file.txt'), 'write')
      assert.equal(okNew.ok, true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  for (const access of ['grant', 'workspace-root'] as const) {
    it(`blocks hardlinks in an additional ${access} without losing the ungranted-path hint`, () => {
      const cwd = makeCwd()
      const outside = mkdtempSync(join(tmpdir(), 'rivet-hardlink-extra-'))
      const vault = mkdtempSync(join(tmpdir(), 'rivet-hardlink-vault-'))
      try {
        const target = join(vault, 'fixture.txt')
        writeFileSync(target, 'SYNTHETIC_FIXTURE')
        const alias = join(outside, 'notes.txt')
        linkSync(target, alias)
        const denied = validatePathSafe(cwd, alias, 'read')
        assert.equal(denied.ok, false)
        if (!denied.ok) assert.match(denied.error, /request_path_access/)
        if (access === 'grant') grantPath(outside, 'write', { cwd })
        for (const mode of ['read', 'write'] as const) {
          const check = () => validatePathSafe(cwd, alias, mode)
          const result = access === 'workspace-root' ? withWorkspaceRoots([cwd, outside], check) : check()
          assert.equal(result.ok, false, mode)
          if (!result.ok) assert.match(result.error, /Hardlink blocked/)
        }
      } finally {
        _resetGrantsForTest()
        for (const dir of [cwd, outside, vault]) rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  it('does not trip on directories (subdir nlink > 1 is normal)', () => {
    const cwd = makeCwd()
    try {
      const r = validatePathSafe(cwd, 'proj', 'read')
      assert.equal(r.ok, true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
