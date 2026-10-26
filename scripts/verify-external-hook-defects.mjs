import { mkdtemp, mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolve, dirname, join, extname } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
await mkdir(join(root, '.test-tmp'), { recursive: true })
const temporary = await mkdtemp(join(root, '.test-tmp', 'external-hook-defects-'))
const graph = [
  'src/hooks/external-hook-host.ts', 'src/hooks/external-hook-types.ts', 'src/hooks/user-hooks-runner.ts',
  'src/hooks/hook-process.ts', 'src/hooks/hooks-config.ts', 'src/hooks/windows-hook-process.ts',
  'src/hooks/hook-host-rpc.ts', 'src/hooks/hook-job-launcher.ts', 'src/hooks/hook-frames.ts',
  'src/agent/hooks/user-hooks-bridge.ts', 'src/agent/runtime-hooks.ts', 'src/agent/worker-process/parent.ts',
  'src/hooks/__tests__/external-hook-host.test.ts', 'src/agent/__tests__/external-hook-lifecycle.test.ts',
  'src/agent/worker-process/__tests__/hook-host-wiring.test.ts', 'src/server/session-manager.ts', 'src/server/archive-worktree.ts',
  'src/server/__tests__/session-archive-worktree.test.ts', 'scripts/cli-hook-runtime.mjs',
  'scripts/__tests__/cli-hook-runtime.test.ts',
]
const cases = [
  { name: 'spawnSync blocks the 30ms outer budget', file: 'src/hooks/hook-process.ts',
    mutate: source => `import { spawnSync } from 'node:child_process'\n${source.replace("  if (process.platform === 'win32')", "  spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500)'])\n  if (process.platform === 'win32')")}`,
    test: 'src/agent/__tests__/external-hook-lifecycle.test.ts', pattern: '30ms outer budget' },
  { name: 'parent cancellation is not forwarded', file: 'src/agent/hooks/user-hooks-bridge.ts',
    mutate: source => source.replace('signal: ctx?.signal,', 'signal: undefined,'),
    test: 'src/agent/__tests__/external-hook-lifecycle.test.ts', pattern: 'parent abort reaches' },
  { name: 'group budget is ignored', file: 'src/hooks/external-hook-host.ts',
    mutate: source => source.replace('const budget = options.budgetMs && options.budgetMs > 0 ? options.budgetMs : 10_000', 'const budget = 10_000').replace('Math.min(options.deadlineAt ?? Infinity, enqueued + budget)', 'enqueued + budget'),
    test: 'src/hooks/__tests__/external-hook-host.test.ts', pattern: 'group deadline frees' },
  { name: 'directory and concurrency leases released before reaping', file: 'src/hooks/external-hook-host.ts',
    mutate: source => source.replace("if (!job.running || !job.processes.length) this.finishCleanup(job, 'exited')", "if (true) this.finishCleanup(job, 'exited')"),
    test: 'src/hooks/__tests__/external-hook-host.test.ts', pattern: 'superseding a run reaps' },
  { name: 'direct child exit incorrectly confirms descendant cleanup', file: 'src/hooks/hook-process.ts',
    mutate: source => source.replace('if (!alive && closed)', 'if (closed)'),
    test: 'src/hooks/__tests__/external-hook-host.test.ts', pattern: 'parent exit does not release' },
  { name: 'postSession rereads the live run instead of its snapshot', file: 'src/agent/hooks/user-hooks-bridge.ts',
    mutate: source => source.replace('return scoped => execute(deps, input, scoped)', 'return scoped => execute(deps, capture(deps, phase), scoped)'),
    test: 'src/agent/__tests__/external-hook-lifecycle.test.ts', pattern: 'postSession captures' },
  { name: 'worker dispatch loses the shared host', file: 'src/agent/worker-process/parent.ts',
    mutate: source => source.replace('new HookRpcServer(config.externalHookHost,', 'new HookRpcServer(undefined,'),
    test: 'src/agent/worker-process/__tests__/hook-host-wiring.test.ts', pattern: 'worker process hook requests' },
  { name: 'onError bypasses host tracking and its group budget', file: 'src/agent/hooks/user-hooks-bridge.ts',
    mutate: source => `import { runHooksForEvent } from '../../hooks/user-hooks-runner.js'\n${source.replace('const pending = execute(deps, input)', 'const pending = runHooksForEvent(deps.cwd, input.context, input.plugins).then(() => {})')}`,
    test: 'src/agent/__tests__/external-hook-lifecycle.test.ts', pattern: 'onError has a tracked budget' },
  { name: 'archive removes the worktree before external hook retirement', file: 'src/server/session-manager.ts',
    mutate: source => source.replace('const branchKept = hookDrain ? false : cleanup()', 'const branchKept = cleanup()'),
    test: 'src/server/__tests__/session-archive-worktree.test.ts', pattern: 'archive waits for external hook cleanup; confirmed=true' },
  { name: 'CLI helper checksum gate removed', file: 'scripts/cli-hook-runtime.mjs',
    mutate: source => source.replace("entry.sha256 !== createHash('sha256').update(bytes).digest('hex')", 'false'),
    test: 'scripts/__tests__/cli-hook-runtime.test.ts', pattern: 'CLI hook staging' },
]

async function actualPath(base, specifier) {
  let path = resolve(dirname(base), specifier)
  if (extname(path) === '.js') {
    const candidate = path.slice(0, -3) + '.ts'
    try { await access(candidate); path = candidate } catch { /* Actual .js module. */ }
  }
  return path
}
async function rewrite(source, original, paths) {
  const matches = [...source.matchAll(/((?:from|import)\s*(?:\(\s*)?['"])(\.[^'"]+)(['"])/g)]
  for (const match of matches.reverse()) {
    const dependency = await actualPath(original, match[2])
    const replacement = match[1] + pathToFileURL(paths.get(dependency) ?? dependency).href + match[3]
    source = source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length)
  }
  return source
}
async function run(file, pattern) {
  return new Promise(resolveRun => {
    const command = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-timeout=20000', '--test-name-pattern', pattern, file], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let output = ''
    command.stdout.on('data', chunk => { output += chunk }); command.stderr.on('data', chunk => { output += chunk })
    const timeout = setTimeout(() => command.kill('SIGKILL'), 30_000)
    command.on('close', (code, signal) => { clearTimeout(timeout); resolveRun({ code, signal, output }) })
  })
}
const report = []
try {
  for (let index = 0; index < cases.length; index++) {
    const item = cases[index], folder = join(temporary, String(index))
    const paths = new Map(graph.map(file => [resolve(root, file), join(folder, file)]))
    let changed = false
    for (const file of graph) {
      let source = await readFile(join(root, file), 'utf8')
      if (file === item.file) { const mutated = item.mutate(source); changed = mutated !== source; source = mutated }
      const destination = paths.get(resolve(root, file))
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, await rewrite(source, resolve(root, file), paths))
    }
    if (!changed) throw new Error(`Mutation anchor missing: ${item.name}`)
    const result = await run(paths.get(resolve(root, item.test)), item.pattern)
    await writeFile(join(folder, 'test-output.txt'), result.output)
    const red = result.code !== 0 && !result.signal && /AssertionError|ERR_ASSERTION/.test(result.output)
    report.push({ name: item.name, red, code: result.code, log: join(folder, 'test-output.txt') })
    process.stdout.write(`${red ? 'RED' : 'FAILED TO DETECT'} ${item.name}\n`)
    if (!red) throw new Error(`Regression test did not detect restored defect: ${item.name}`)
  }
  await writeFile(join(temporary, 'report.json'), JSON.stringify(report, null, 2))
  process.stdout.write(JSON.stringify({ restoredDefectsDetected: report.length, output: temporary }) + '\n')
} catch (error) {
  await writeFile(join(temporary, 'report.json'), JSON.stringify(report, null, 2))
  throw error
}
