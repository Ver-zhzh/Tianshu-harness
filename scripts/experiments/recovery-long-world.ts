import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, rmSync, lstatSync, readlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { FILES } from './recovery-long-fixture.js'
import { contract, describe, resolveCapability, capabilityFailure, CapabilityError, CapabilityEnvironmentError, allocatePorts, assertPortsAvailable, TEST_SERVER_HELPER, CAPABILITY_PROBE } from './experiment-capabilities.js'
import { observation, checkEvidence, nodeTestCounts, type Stage } from './experiment-protocol.js'
import { gradeSynthetic, SYNTHETIC_DRIVER } from './experiment-synthetic-grade.js'
import type { ToolDefinition } from '../../src/api/types.js'

export const sha = (v: unknown): string => createHash('sha256').update(typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v)).digest('hex')
export class LongWorld {
  readonly root = realpathSync(mkdtempSync(join(tmpdir(), 'rivet-long-world-')))
  readonly privateRoot = realpathSync(mkdtempSync(join(tmpdir(), 'rivet-long-grader-')))
  readonly events: any[] = []
  private tools!: Record<string, import('../../src/tools/types.js').Tool>
  readonly initialHashes: Record<string, string>
  readonly capabilities: ReturnType<typeof contract>
  constructor(files = FILES, generated: string[] = [], childProcesses = false, publicDriver = SYNTHETIC_DRIVER) {
    files = { ...files, 'support/test-server.mjs': TEST_SERVER_HELPER, 'support/capability-probe.mjs': CAPABILITY_PROBE, 'scripts/api-driver.mjs': publicDriver }
    this.capabilities = contract(files, generated, childProcesses)
    for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(this.root, path)), { recursive: true }); writeFileSync(join(this.root, path), text) }
    mkdirSync(join(this.root, '.tmp')); mkdirSync(join(this.root, '.home'))
    this.initialHashes = this.hashes()
  }
  async ensurePorts(): Promise<void> { if (!this.capabilities.loopbackPorts.length) this.capabilities.loopbackPorts = await allocatePorts() }
  async initialize(): Promise<void> {
    await this.ensurePorts()
    const [{ READ_FILE_TOOL }, { EDIT_FILE_TOOL }, { WRITE_FILE_TOOL }] = await Promise.all([
      import('../../src/tools/read-file.js'), import('../../src/tools/edit.js'), import('../../src/tools/write-file.js'),
    ])
    this.tools = { read_file: READ_FILE_TOOL, edit_file: EDIT_FILE_TOOL, write_file: WRITE_FILE_TOOL }
  }
  definitions(): ToolDefinition[] {
    return [
      { name: 'list_files', description: 'List declared project files/directories, including read-only generated files. ' + describe(this.capabilities), input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
      ...Object.values(this.tools).map(t => ({ ...t.definition, description: t.definition.description + ' ' + describe(this.capabilities) })),
      { name: 'run_checks', description: 'Run the existing smoke suite and original reproduction, or added test files. Real isolated Node process. Assigned loopback ports are available using support/test-server.mjs; no external network or installs. No arguments runs both original commands. Results are bound to current source bytes.', input_schema: { type: 'object', properties: { test_file: { type: 'string', description: 'Optional project-relative test/*.test.mjs you added. Omit for original smoke + reproduction.' } } } },
    ]
  }
  files(): string[] {
    const walk = (dir: string): string[] => readdirSync(join(this.root, dir), { withFileTypes: true }).flatMap(e => !dir && (!this.capabilities.readable.includes(e.name) || this.capabilities.generated.includes(e.name)) ? [] : e.isDirectory() && !e.isSymbolicLink() ? walk(join(dir, e.name)) : [join(dir, e.name).replaceAll('\\', '/')])
    return walk('').sort()
  }
  hashes(): Record<string, string> { return Object.fromEntries(this.files().map(p => [p, sha(lstatSync(join(this.root, p)).isSymbolicLink() ? 'symlink:' + readlinkSync(join(this.root, p)) : readFileSync(join(this.root, p), 'utf8'))])) }
  sourceHash(): string { return sha(Object.entries(this.hashes()).filter(([p]) => p.startsWith('src/') || p.startsWith('test/'))) }
  artifact(path: string): string {
    const absolute = join(this.root, path), stat = lstatSync(absolute)
    if (stat.isSymbolicLink()) return JSON.stringify({ kind: 'symlink', target: readlinkSync(absolute) })
    resolveCapability(this.root, path, 'read', this.capabilities)
    if (stat.size > 5 * 1024 * 1024) return JSON.stringify({ kind: 'artifact-size-limit', bytes: stat.size })
    return readFileSync(absolute, 'utf8')
  }
  protected launchCandidate(args: string[], signal?: AbortSignal): ChildProcess {
    if (process.platform !== 'darwin') throw new Error('Verified macOS sandbox required; no bare fallback')
    const quote = (s: string) => JSON.stringify(realpathSync(s)), node = realpathSync(process.execPath)
    const network = this.capabilities.loopbackPorts.map(p => `(allow network-inbound (local ip "localhost:${p}"))(allow network-outbound (remote ip "localhost:${p}"))`).join('')
    const profile = `(version 1)(allow default)(deny network*)${network}(deny file-write*)(allow file-write* (subpath ${quote(this.root)}) (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr"))(deny file-read* (subpath "/Users"))(deny file-read* (subpath ${quote(this.privateRoot)}))(allow file-read* (subpath ${quote(this.root)}) (subpath ${quote(dirname(node))}))`
    const permissions = ['--permission', '--allow-fs-read=' + this.root, '--allow-fs-write=' + this.root]
    const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, node, ...permissions, ...args], {
      cwd: this.root, detached: true, env: { PATH: '/usr/bin:/bin', HOME: join(this.root, '.home'), TMPDIR: join(this.root, '.tmp'),
        ...Object.fromEntries(this.capabilities.loopbackPorts.map((p, i) => ['EXPERIMENT_PORT_' + (i + 1), String(p)])) }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    const stop = () => this.stopCandidate(child)
    signal?.addEventListener('abort', stop, { once: true }); child.once('close', () => signal?.removeEventListener('abort', stop)); if (signal?.aborted) stop()
    return child
  }
  protected stopCandidate(child: ChildProcess) { try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
  async process(args: string[], signal?: AbortSignal): Promise<{ exit: number | null; output: string; timedOut: boolean }> {
    await this.ensurePorts(); signal?.throwIfAborted()
    await assertPortsAvailable(this.capabilities.loopbackPorts)
    const child = this.launchCandidate(args, signal)
    return new Promise(resolveProcess => {
      let output = '', timedOut = false
      const timeout = setTimeout(() => { timedOut = true; this.stopCandidate(child) }, 15_000)
      const chunk = (data: Buffer) => { output += String(data); if (output.length > 250_000) { timedOut = true; output = output.slice(0, 250_000); this.stopCandidate(child) } }
      child.stdout!.on('data', chunk); child.stderr!.on('data', chunk)
      child.on('error', error => { output += error.name })
      child.on('close', exit => { clearTimeout(timeout); resolveProcess({ exit, output, timedOut }) })
    })
  }
  protected protectedUnchanged() {
    const hashes = this.hashes()
    return Object.entries(this.initialHashes).filter(([p]) => !p.startsWith('src/')).every(([p, h]) => hashes[p] === h)
  }
  protected probeProcess(args: string[]) { return this.process(args) }
  async preflight(): Promise<any> {
    await this.ensurePorts()
    const external = join(this.privateRoot, 'external-fixture.txt'); writeFileSync(external, 'fixture')
    const probe = await this.probeProcess(['support/capability-probe.mjs', external, ...(this.capabilities.childProcesses ? ['--children'] : [])])
    let parsed: any
    try { parsed = JSON.parse(probe.output.trim().split('\n').at(-1)!) } catch { /* not qualified */ }
    return { passed: probe.exit === 0 && !probe.timedOut && parsed && Object.values(parsed).every(v => v === true) && readFileSync(external, 'utf8') === 'fixture', origin: 'harness', probe, parsed, capabilities: this.capabilities }
  }
  async checks(testFile?: string, signal?: AbortSignal): Promise<any> {
    const before = this.sourceHash(), runs: Stage[] = []
    const commands = testFile ? [['--test', '--test-isolation=none', testFile]] : [['--test', '--test-isolation=none', 'test/smoke.test.mjs'], ['scripts/reproduce.mjs']]
    for (const command of commands) {
      signal?.throwIfAborted(); const result = await this.process(command, signal)
      runs.push({ id: command.includes('--test') ? 'tests' : 'reproduction', required: true, executed: true, origin: 'candidate', command, ...result,
        ...(command.includes('--test') ? { tests: nodeTestCounts(result.output) } : {}) })
    }
    return checkEvidence(before, this.sourceHash(), this.protectedUnchanged(), runs)
  }
  async grade(): Promise<any> {
    const results = await gradeSynthetic(async () => { await this.ensurePorts(); return this.launchCandidate(['scripts/api-driver.mjs']) }, c => this.stopCandidate(c))
    const protectedUnchanged = this.protectedUnchanged(), passed = protectedUnchanged && results.every(r => r.verdict === 'pass')
    return { exit: passed ? 0 : 1, parsed: { results }, protectedUnchanged, hashes: this.hashes(), passed }
  }
  protected modelCheck(check: any) {
    return { ...check, runs: check.runs.map((r: Stage) => ({ ...r, output: r.output.replace(/\(node:\d+\) \[PERM0002\][^\n]*\n(?:\(Use \x60node --trace-warnings[^\n]*\n)?/g, '') })) }
  }
  async execute(name: string, input: Record<string, any>, signal?: AbortSignal): Promise<any> {
    signal?.throwIfAborted()
    const hash = this.sourceHash()
    let result: any
    try {
      if (name === 'list_files') {
        const selected = resolveCapability(this.root, input.path ?? '', 'list', this.capabilities)
        const entries: string[] = []
        const walk = (dir: string) => {
          for (const e of readdirSync(join(this.root, dir), { withFileTypes: true })) {
            const p = join(dir, e.name).replaceAll('\\', '/')
            try { resolveCapability(this.root, p, 'list', this.capabilities) } catch { continue }
            entries.push(p + (e.isDirectory() ? '/' : e.isSymbolicLink() ? ' [symlink]' : ''))
            if (e.isDirectory() && !e.isSymbolicLink()) walk(p)
          }
        }
        if (selected.directory) walk(selected.path); else entries.push(selected.path)
        result = { content: entries.join('\n') }
      } else if (name === 'run_checks') {
        if (input.test_file !== undefined) {
          const p = resolveCapability(this.root, input.test_file, 'read', this.capabilities)
          if (!p.path.startsWith('test/') || !p.path.endsWith('.test.mjs')) throw new CapabilityError('invalid_test_path', 'Select a test/*.test.mjs file, including Unicode or spaces if needed.')
          input = { ...input, test_file: p.path }
        }
        const check = await this.checks(input.test_file, signal)
        const obs = observation(check.protectedUnchanged ? 'candidate' : 'policy', check.passed ? 'checks_passed' : 'checks_not_passed', true, 'checks', hash, 'Inspect the executed stages; unexecuted/skipped stages are not verification.')
        result = { content: JSON.stringify({ ...this.modelCheck(check), observation: obs }), isError: !check.passed, check, observation: obs }
      } else if (this.tools[name]) {
        const mode = name === 'read_file' ? 'read' : 'write'
        const paths = Array.isArray(input.file_paths) ? input.file_paths : [input.file_path]
        if (!paths.length || paths.length > 20 || name !== 'read_file' && paths.length !== 1) throw new CapabilityError('invalid_path_batch', 'Supply 1..20 read paths, or one write path.')
        const resolved = paths.map(p => resolveCapability(this.root, p, mode, this.capabilities))
        const normalized = Array.isArray(input.file_paths) ? { ...input, file_paths: resolved.map(p => p.absolute) } : { ...input, file_path: resolved[0]!.absolute }
        result = await this.tools[name]!.execute({ input: normalized, cwd: this.root, sessionId: 'long-pilot', toolUseId: String(this.events.length), signal } as any)
        result.observation = observation(result.isError ? 'unknown' : 'candidate', result.isError ? 'tool_error' : 'tool_completed', true, name, hash)
      } else throw new CapabilityError('unsupported_tool', 'Use one of the declared tools.')
    } catch (error) {
      if (signal?.aborted) throw error
      if (error instanceof CapabilityError) result = capabilityFailure(error, hash)
      else {
        const obs = error instanceof CapabilityEnvironmentError ? observation('harness', error.code, false, name, hash, 'Stop and repeat environment qualification in a new experiment.') : observation('unknown', 'execution_unresolved', true, name, hash)
        result = { isError: true, content: JSON.stringify({ message: error instanceof Error ? error.message : 'unknown', observation: obs }), observation: obs }
      }
    }
    this.events.push({ at: new Date().toISOString(), name, input, result, sourceHash: this.sourceHash() }); return result
  }
  close(): void { rmSync(this.root, { recursive: true, force: true }); rmSync(this.privateRoot, { recursive: true, force: true }) }
}
