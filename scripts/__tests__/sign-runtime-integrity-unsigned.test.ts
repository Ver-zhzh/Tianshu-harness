import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { generateKeyPairSync } from 'node:crypto'

const script = fileURLToPath(new URL('../../desktop/scripts/sign-runtime-integrity.js', import.meta.url))
const options = { skip: !existsSync(script) && 'CLI 仓库不包含桌面签名脚本' }
function check(encoded: string, unsigned?: string) {
  return spawnSync(process.execPath, [script, '--check-only'], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, RIVET_RELEASE_KEY_PKCS8: encoded, RIVET_ALLOW_UNSIGNED_RUNTIME: unsigned ?? '' },
  })
}

for (const unsigned of ['', '1']) test(`release preflight rejects a missing signing key (unsigned=${unsigned || 'unset'})`, options, () => {
  const result = check('', unsigned)
  assert.equal(result.status, 1, 'never produce a release package that the strict launcher cannot start')
  assert.match(result.stderr, /缺少 RIVET_RELEASE_KEY_PKCS8/)
  assert.match(result.stderr, /tauri:dev/)
})

test('release preflight rejects whitespace keys before staging or compilation', options, () => {
  const result = check(' \n\t')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /缺少 RIVET_RELEASE_KEY_PKCS8/)
})

test('release preflight never echoes malformed key input', options, () => {
  const synthetic = 'SYNTHETIC_INVALID_SIGNING_INPUT'
  const result = check(synthetic)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /格式错误/)
  assert.ok(!result.stderr.includes(synthetic))
})

test('release preflight checks the actual embedded public key, not just self-consistent signatures', options, () => {
  const { privateKey } = generateKeyPairSync('ed25519')
  const result = check(privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /与应用内置公钥不匹配/)
})
