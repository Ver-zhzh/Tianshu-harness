import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createDestructiveGateState } from '../destructive-gate.js'
import { GIT_CLEAR_RE } from '../destructive-patterns.js'
import { matchesDangerousBash } from '../../agent/approval-risk.js'

test('PR #494: clean force forms agree across the execution gate and approval', () => {
  const blocked = [
    'git clean -fd', 'git clean -fdx', 'git clean -xdf', 'git clean -d -f',
    'git clean -f -d', 'git clean --force', 'git clean -d --force', 'git clean --force -d',
    'git clean -q -d -f', 'cd x;git clean -d -f', 'git -C repo clean --force',
    'git clean "-f"', "git clean '-df'", 'git clean --fo', 'git clean -e ignored --force',
    'git clean -e "-f" --force', 'git clean -qfe ignored',
  ]
  const safe = [
    'git clean -dn', 'git clean -d', 'git clean -n', 'git clean --dry-run',
    'git clean -e "*.log" -d', 'git clean -- -foo', 'git clean "--" "-f"',
    'git clean -e -foo', 'git clean --exclude "-f"', 'git clean -qe -f',
    'git clean -efoo', 'git clean --exclude=-f', 'git clean -d; echo -f',
    'git clean -d\necho --force', 'git clean -d && echo -f', 'git clean -d | echo -f',
  ]
  for (const [commands, expected] of [[blocked, true], [safe, false]] as const) {
    for (const command of commands) {
      const gate = createDestructiveGateState()
      gate.noteVerification('failed')
      assert.equal(GIT_CLEAR_RE.test(command), expected, `pattern: ${command}`)
      assert.equal(gate.evaluate('bash', { command }).block, expected, `gate: ${command}`)
      assert.equal(matchesDangerousBash(command), expected, `approval: ${command}`)
      if (expected) assert.equal(gate.evaluate('bash', { command }).block, true, 'model retry never authorizes')
    }
  }
  assert.equal(GIT_CLEAR_RE.test('git checkout -q --force .'), true, 'keep local checkout fix')
})

describe('destructive-gate trusted authorization', () => {
  test('resends, tool count and successful verification cannot self-authorize', () => {
    const gate = createDestructiveGateState()
    for (const status of ['failed', 'blocked', 'passed'] as const) {
      gate.noteVerification(status)
      for (let i = 0; i < 5; i++) { gate.noteToolExecuted(); assert.equal(gate.evaluate('bash', { command: 'git checkout HEAD -- a.ts' }).block, true) }
    }
    assert.equal(gate.evaluate('bash', { command: 'git status' }).block, false)
    assert.equal(gate.evaluate('deliver_task', {}).block, false)
  })
  test('unknown verification is described as unknown', () => {
    const decision = createDestructiveGateState().evaluate('bash', { command: 'git stash' })
    assert.ok(decision.block)
    assert.match(decision.message, /unknown/); assert.doesNotMatch(decision.message, /测试刚失败|原样重发.*放行/)
  })
})

describe('GIT_CLEAR_RE 共享正则(迁移回归)', () => {
  test('匹配清场类,排除只读/恢复类', () => {
    for (const cmd of ['git stash', 'git reset --hard', 'git checkout -- .', 'git restore .', 'git clean -fd']) {
      assert.equal(GIT_CLEAR_RE.test(cmd), true, `should match: ${cmd}`)
    }
    for (const cmd of ['git stash pop', 'git stash list', 'git stash show', 'git stash apply', 'git diff', 'git log']) {
      assert.equal(GIT_CLEAR_RE.test(cmd), false, `should NOT match: ${cmd}`)
    }
  })

  // 收编公开仓 PR #410：git 与子命令之间的全局参数（-C/-c/--no-pager/--git-dir…）。
  // 值型旗标的分隔与紧贴形态（`-C dir` ≡ `-Cdir`、`--git-dir x` ≡ `--git-dir=x`）
  // 与引号值（`-C "my repo"`）语义相同，必须同判；只读形态不得误伤。
  test('全局参数形态（含紧贴与引号值）同口径', () => {
    for (const cmd of [
      'git -C repo reset --hard',
      'git --no-pager reset --hard HEAD',
      'git -c core.pager=cat clean -fd',
      'git --git-dir .git stash',
      'git --work-tree . reset --hard',
      'git --git-dir=.git stash',
      'cd x&&git reset --hard',
      'cd x;git clean -fd',
      '(git stash)',
      'git restore a.ts',
      'git -C a -C b stash',
      'git -C/tmp reset --hard',
      'git -cfoo.bar=baz clean -fd',
      'git -C "my repo" stash',
    ]) {
      assert.equal(GIT_CLEAR_RE.test(cmd), true, `should match: ${cmd}`)
    }
    for (const cmd of [
      'git stash list',
      'git --no-pager status',
      'git -C repo status',
      'git -C docs log --oneline -5',
      'git clean -dn',
      'echo digit reset --hard',
    ]) {
      assert.equal(GIT_CLEAR_RE.test(cmd), false, `should NOT match: ${cmd}`)
    }
  })
})


test('172–174 replay: identical targets share an action identity, only user authorization grants it', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'clear-gate-')), file = join(cwd, 'a.ts')
  try {
    writeFileSync(file, 'const a = 1')
    const gate = createDestructiveGateState()
    const commands = ["git checkout HEAD -- a.ts\npython3 - <<'PY'\nprint('one')\nPY", "git checkout HEAD -- ./a.ts\npython3 - <<'PY'\nprint('two')\nPY"]
    const first = gate.evaluate('bash', { command: commands[0] }, cwd), second = gate.evaluate('bash', { command: commands[1] }, cwd)
    assert.ok(first.block && second.block); assert.deepEqual(first.actions, second.actions)
    assert.equal(gate.evaluate('bash', { command: commands[1] }, cwd).block, true)
    gate.approve('bash', { command: commands[1] }, cwd)
    assert.equal(gate.evaluate('bash', { command: commands[0] }, cwd).block, false)
    assert.equal(gate.evaluate('bash', { command: commands[0] + '\ngit clean -fd' }, cwd).block, true)
    gate.approve('bash', { command: 'git checkout HEAD -- *.ts' }, cwd)
    assert.equal(gate.evaluate('bash', { command: 'git checkout HEAD -- *.ts' }, cwd).block, true, 'glob targets are never reusable file-version grants')
    gate.approve('bash', { command: 'cd other; git checkout HEAD -- a.ts' }, cwd)
    assert.equal(gate.evaluate('bash', { command: 'cd other; git checkout HEAD -- a.ts' }, cwd).block, true, 'unknown shell cwd is never a reusable grant')
    writeFileSync(file, 'peer content')
    assert.equal(gate.evaluate('bash', { command: commands[1] }, cwd).block, true)
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})
