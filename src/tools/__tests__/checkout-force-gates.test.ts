import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir, devNull } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { GIT_CLEAR_RE, GIT_CHECKOUT_CLEAR_RE } from '../destructive-patterns.js'
import { createDestructiveGateState } from '../destructive-gate.js'
import { matchesDangerousBash, assessToolRisk } from '../../agent/approval-risk.js'

const destructive = [
  'git checkout -f .', 'git checkout --force .', 'git checkout -qf .', 'git checkout -fq .',
  'git checkout -q --f .', 'git checkout -q --fo .', 'git checkout -q --for .', 'git checkout -q --forc .',
  'git checkout -q --force .', 'git checkout -q -f .', 'git checkout HEAD -f -- file.txt',
  'git checkout HEAD --force', 'git checkout -q HEAD -- file.txt',
  'git -C "my repo" checkout -q --force .',
  'git checkout --conflict diff3 -qf .', 'git checkout -b feature -f',
  'git checkout -fqbfeature', 'git checkout --orphan newbranch -f',
  'git checkout "--force" .', "git checkout '-qf' .",
  'git checkout --progress -f .; echo done', '(git checkout -q -f .)',
  // 裸路径形态（无 -- / -f）同样是破坏性清场：git 把不匹配 ref 的参数当 pathspec
  // 检出，丢弃工作区改动，与 `checkout -- .` 同义（2026-10-16 审查发现，PR #485 遗漏面）。
  'git checkout .', 'git checkout -q .', 'git checkout HEAD .',
  'git checkout ./src/foo.ts', 'git checkout ../lib/x.ts',
  'git checkout src/', 'git checkout .env', 'git checkout *.ts',
  "git checkout '.'", 'git checkout "./file.txt"',
  'git checkout "./file with spaces.txt"', "git checkout 'dir name/'",
  "git checkout '*.ts'", "git checkout '../lib/file.txt'",
  'git checkout HEAD "./file.txt"', 'git checkout -q "src/"',
]
for (const command of destructive) {
  test(`all checkout gates detect: ${command}`, () => {
    assert.equal(GIT_CHECKOUT_CLEAR_RE.test(command), true)
    assert.equal(GIT_CLEAR_RE.test(command), true)
    assert.equal(matchesDangerousBash(command), true)
    assert.equal(assessToolRisk('bash', { command }).level, 'high')
    const gate = createDestructiveGateState()
    gate.noteVerification('failed')
    assert.equal(gate.evaluate('bash', { command }).block, true)
    assert.equal(gate.evaluate('bash', { command }).block, true, 'retry never authorizes; only trusted approve() grants (f3dfbd8cf)')
  })
}

const benign = [
  'git checkout main', 'git checkout -b feature', 'git checkout -bfeature',
  'git checkout --orphan newbranch', 'git checkout --track origin/main', 'git checkout --help',
  'git checkout --progress main', 'git checkout --no-force main',
  'git checkout -b force', 'git checkout -bf', 'git checkout -b feature-force',
  "git checkout --orphan '-f'", 'git checkout --pathspec-from-file "-f"',
  'git checkout --conflict -f', 'git checkout -U 5', 'git checkout -U5f',
  'git checkout main; echo -f', 'git checkout main && echo --force',
  'git checkout main | cat -f', 'git checkout main\necho --force',
  'git checkout "branch; -f inside"',
  'git checkout -f.', 'git checkout --force.', 'git checkout -qf.',
  // 含路径分隔符但整词是合法 ref 名（git check-ref-format 允许）——歧义面，
  // 无法在正则层与分支切换消歧，保持精确不拦（避免误伤 `checkout feature/x`）。
  'git checkout feature/x', 'git checkout origin/main',
  // commit-ish 不是 ref 名；~ 和 ^ 是版本语法，不能据此判作路径清场。
  'git checkout HEAD~1', 'git checkout HEAD^', 'git checkout HEAD^2',
  'git checkout HEAD~1^', 'git checkout HEAD^{commit}',
  'git checkout --detach HEAD~1', 'git checkout "HEAD~1"', "git checkout 'HEAD^'",
]
for (const command of benign) {
  test(`checkout flags do not include values or other commands: ${command}`, () => {
    assert.equal(GIT_CHECKOUT_CLEAR_RE.test(command), false)
    assert.equal(GIT_CLEAR_RE.test(command), false)
    assert.equal(matchesDangerousBash(command), false)
    const gate = createDestructiveGateState()
    gate.noteVerification('failed')
    assert.equal(gate.evaluate('bash', { command }).block, false)
  })
}

test('raw checkout matching preserves quoted words; the normalized approval view stays conservative', () => {
  const command = 'git checkout --pathspec-from-file "file with -f inside"'
  assert.equal(GIT_CHECKOUT_CLEAR_RE.test(command), false)
  assert.equal(GIT_CLEAR_RE.test(command), false)
  // The existing approval normalization strips quotes. Its extra approval is
  // deliberate here; do not weaken that view to make a benign fixture pass.
  assert.equal(matchesDangerousBash(command), true)
})

test('bash manual approval consumes the checkout rule even without rtk rewriting', async () => {
  const { BASH_TOOL, __setRtkExecForTests } = await import('../bash.js')
  __setRtkExecForTests(() => { throw new Error('rtk unavailable') })
  try {
    for (const command of destructive) {
      assert.equal(BASH_TOOL.requiresApproval!({ toolUseId: command, cwd: '/repo', input: { command } }), true, command)
    }
    for (const command of ['git checkout main', 'git checkout --orphan feature', 'git checkout --help',
      'git checkout HEAD~1', 'git checkout HEAD^', 'git checkout --detach HEAD~1']) {
      assert.equal(BASH_TOOL.requiresApproval!({ toolUseId: command, cwd: '/repo', input: { command } }), false, command)
    }
  } finally {
    __setRtkExecForTests(undefined)
  }
})

test('legal force argument orders really discard only synthetic fixture changes', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'checkout-force-gates-'))
  const hooks = join(cwd, 'no-hooks')
  mkdirSync(hooks)
  const git = (args: string[]) => spawnSync('git', ['-c', `core.hooksPath=${hooks}`, ...args], {
    cwd, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull },
  })
  const run = (args: string[]) => {
    const result = git(args)
    assert.equal(result.status, 0, result.stderr)
  }
  try {
    run(['init', '-q', '-b', 'main'])
    writeFileSync(join(cwd, 'file.txt'), 'committed fixture\n')
    writeFileSync(join(cwd, 'file with spaces.txt'), 'committed fixture\n')
    run(['add', 'file.txt', 'file with spaces.txt'])
    run(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'])
    run(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'second fixture'])
    // 两个提交中的文件相同：版本切换成功且保留本地改动，不能当作路径覆盖。
    for (const args of [['main~1'], ['main^'], ['--detach', 'main~1']]) {
      writeFileSync(join(cwd, 'file.txt'), 'uncommitted fixture\n')
      run(['checkout', ...args])
      assert.equal(git(['rev-parse', 'HEAD']).stdout.trim(), git(['rev-parse', 'main~1']).stdout.trim())
      assert.equal(readFileSync(join(cwd, 'file.txt'), 'utf8'), 'uncommitted fixture\n')
      const command = `git checkout ${args.join(' ')}`
      const gate = createDestructiveGateState()
      gate.noteVerification('failed')
      assert.equal(gate.evaluate('bash', { command }).block, false)
      assert.equal(matchesDangerousBash(command), false)
    }
    for (const args of [
      ['-f', '.'], ['--force', '.'], ['-qf', '.'], ['-fq', '.'],
      ['-q', '--f', '.'], ['-q', '--fo', '.'], ['-q', '--for', '.'], ['-q', '--forc', '.'],
      ['-q', '--force', '.'], ['-q', '-f', '.'], ['HEAD', '-f', '--', 'file.txt'],
    ]) {
      writeFileSync(join(cwd, 'file.txt'), 'uncommitted fixture\n')
      run(['checkout', ...args])
      assert.equal(readFileSync(join(cwd, 'file.txt'), 'utf8'), 'committed fixture\n')
      const gate = createDestructiveGateState()
      gate.noteVerification('failed')
      const command = `git checkout ${args.join(' ')}`
      assert.equal(gate.evaluate('bash', { command }).block, true)
      assert.equal(matchesDangerousBash(command), true)
    }
    // 裸路径形态在真实 git 里同样丢弃工作区改动（与 `checkout -- .` 同义的 ground truth）。
    for (const args of [['.'], ['-q', '.'], ['./file.txt']]) {
      writeFileSync(join(cwd, 'file.txt'), 'uncommitted fixture\n')
      run(['checkout', ...args])
      assert.equal(readFileSync(join(cwd, 'file.txt'), 'utf8'), 'committed fixture\n', `git checkout ${args.join(' ')}`)
      const gate = createDestructiveGateState()
      gate.noteVerification('failed')
      const command = `git checkout ${args.join(' ')}`
      assert.equal(gate.evaluate('bash', { command }).block, true)
      assert.equal(matchesDangerousBash(command), true)
    }
    // shell 引号只负责分词，传给 Git 的参数仍是同一个 pathspec。
    for (const [command, path] of [
      ["git checkout '.'", '.'],
      ['git checkout "./file.txt"', './file.txt'],
      ['git checkout "./file with spaces.txt"', './file with spaces.txt'],
    ] as const) {
      const file = path.includes('spaces') ? 'file with spaces.txt' : 'file.txt'
      writeFileSync(join(cwd, file), 'uncommitted fixture\n')
      run(['checkout', path])
      assert.equal(readFileSync(join(cwd, file), 'utf8'), 'committed fixture\n', command)
      const gate = createDestructiveGateState()
      gate.noteVerification('failed')
      assert.equal(gate.evaluate('bash', { command }).block, true, command)
      assert.equal(matchesDangerousBash(command), true, command)
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
