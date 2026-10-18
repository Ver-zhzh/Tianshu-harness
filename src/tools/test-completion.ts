import { nodeCompletionOutput } from './test-node-output.js'
import { parseTestSelection } from './test-selection.js'
import { validScopeCoverage } from './test-scope-validation.js'
import { workspaceIdentity } from './test-completion-identity.js'
import { prepareFrameworkCompletion } from './test-framework-completion.js'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { realpathSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { TestCompletionCoverage } from './types.js'
import { classifyVerificationCommand, shellWord, verificationArgv } from './verification-command.js'
import { unwrapVerification } from './verification-invocation.js'
import { isFilesystemMetadata } from '../utils/file-metadata.js'
import { getResolvedEnv } from './resolved-env.js'

const ENV = 'RIVET_TEST_COMPLETION_RUN'
interface Binding { runId: string; dir: string; root: string }
interface Receipt { runId: string; batchId: string; cwd: string; complete: boolean; success: boolean; totals?: TestCompletionCoverage['totals']; files: TestCompletionCoverage['files'] }


function reporter(binding: Binding, batchId: string, cwd: string): string {
  const filename = join(binding.dir, batchId + '.mjs')
  // Node owns both per-file and final summary events. Console text is never evidence.
  const source = `import {writeFileSync,renameSync} from 'node:fs';
import {relative,resolve} from 'node:path';
const binding=${JSON.stringify({ ...binding, batchId, cwd })};
export default async function*(events){
 try{writeFileSync(binding.dir+'/'+binding.batchId+'.owner',String(process.pid),{flag:'wx'})}catch{for await(const event of events)yield '';return}
 process.on('uncaughtExceptionMonitor',()=>writeFileSync(binding.dir+'/'+binding.batchId+'.output-error','output_error'));
 const files=[]; let complete=false,success=false,totals;
 for await(const event of events){
  if(event.type==='test:summary'){
   const d=event.data,c=d.counts;
   if(d.file){
    const path=relative(binding.root,resolve(binding.cwd,d.file)).replaceAll('\\\\','/');
    files.push({path,outcome:d.success&&c.failed===0&&c.cancelled===0?(c.passed>0?'passed':'incomplete'):'failed',tests:c.tests,skipped:c.skipped,cancelled:c.cancelled});
   }else{ complete=true; success=d.success&&c.failed===0&&c.cancelled===0; totals={tests:c.tests,passed:c.passed,failed:c.failed,skipped:c.skipped,cancelled:c.cancelled,todo:c.todo}; }
  }
  yield '';
 }
 const path=binding.dir+'/'+binding.batchId+'.json';
 writeFileSync(path+'.partial',JSON.stringify({...binding,complete,success,totals,files}));renameSync(path+'.partial',path);
}`
  writeFileSync(filename, source, { mode: 0o600 })
  // Windows ESM requires file URLs. Keep Unicode literal for the strict argv parser.
  return process.platform === 'win32' ? decodeURI(pathToFileURL(filename).href) : filename
}

/** Called only at the existing guarded Node spawn. No NODE_OPTIONS or new execution path. */
export function completionBatch(args: string[], cwd: string, env: NodeJS.ProcessEnv): { args: string[]; env: NodeJS.ProcessEnv; finish: (success: boolean) => void } {
  const cleanEnv = { ...env }
  delete cleanEnv.NODE_TEST_CONTEXT
  delete cleanEnv[ENV] // A test which spawns its own runner must not join its parent's proof.
  const noop = { args, env: cleanEnv, finish: (_success: boolean) => {} }
  if (!env[ENV] || !args.includes('--test') || args.some(a => a.startsWith('--test-reporter') || a === '--test-force-exit' || a.startsWith('--test-name-pattern') || a.startsWith('--test-skip-pattern'))) return noop
  try {
    const binding = JSON.parse(env[ENV]) as Binding
    const batchId = randomUUID()
    const start = { runId: binding.runId, batchId, cwd: realpathSync(cwd), args }
    writeFileSync(join(binding.dir, batchId + '.start'), JSON.stringify(start), { flag: 'wx' })
    const url = reporter(binding, batchId, realpathSync(cwd))
    return {
      args: ['--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=' + url, '--test-reporter-destination=' + join(binding.dir, batchId + '.sink'), ...args],
      env: cleanEnv,
      finish: success => writeFileSync(join(binding.dir, batchId + '.end'), JSON.stringify({ ...start, success })),
    }
  } catch { return noop }
}

/** Package runner seals all batches only after its existing loop completes. */
export function sealCompletionRun(expectedBatches: number, completedBatches: number, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const binding = JSON.parse(env[ENV] ?? '') as Binding
    writeFileSync(join(binding.dir, 'seal.json'), JSON.stringify({ runId: binding.runId, expectedBatches, completedBatches }))
  } catch { /* No active capture, or unavailable evidence: never manufacture success. */ }
}

export interface CompletionCapture {
  preparationError?: string
  command: string
  env: NodeJS.ProcessEnv
  read(exitCode: number): TestCompletionCoverage | undefined
  dispose(): void
}

export function prepareCompletionCapture(command: string, cwd: string, shellKind: 'bash' | 'sh' | 'powershell' | 'cmd' = 'bash', repositoryRoot?: string, deadline?: number): CompletionCapture | undefined {
  const unwrapped = unwrapVerification(command, cwd, shellKind === 'bash' || shellKind === 'sh')
  if (!unwrapped) return undefined
  cwd = unwrapped.cwd
  const invocation = classifyVerificationCommand(unwrapped.command, cwd)
  if (invocation.runner === 'vitest' || invocation.runner === 'jest') return prepareFrameworkCompletion(unwrapped, invocation, shellKind, repositoryRoot, deadline)
  if ((!invocation.nodeTest && !invocation.batchRunner) || invocation.filtered) return undefined
  if (/--test-(?:name-pattern|skip-pattern|only|force-exit)/.test(getResolvedEnv(cwd).NODE_OPTIONS ?? '')) return undefined
  if ((invocation.resolvedArgv ?? invocation.argv).includes('--test-force-exit')) return undefined
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim()
    if (repositoryRoot) repositoryRoot = realpathSync(repositoryRoot)
    const before = workspaceIdentity(root)
    if (!before) return undefined
    const binding: Binding = { runId: randomUUID(), dir: mkdtempSync(join(tmpdir(), 'rivet-completion-')), root: resolve(root) }
    const env: NodeJS.ProcessEnv = { [ENV]: JSON.stringify(binding), NODE_TEST_CONTEXT: undefined }
    let actualCommand = unwrapped.command
    let directFinish: ((success: boolean) => void) | undefined
    if (invocation.nodeTest) {
      const index = invocation.runnerIndex
      const args = invocation.resolvedArgv ? invocation.resolvedArgv.slice(1) : invocation.argv.slice(index + 1)
      const stripOutputs: string[] = []
      for (let i = 0; i < args.length; i++) { if (/^--test-reporter(?:-destination)?(?:=|$)/.test(args[i]!)) { if (!args[i]!.includes('=')) i++; continue }; stripOutputs.push(args[i]!) }
      const batch = completionBatch(stripOutputs, cwd, env)
      const options = nodeCompletionOutput(args, getResolvedEnv(cwd).NODE_OPTIONS ?? '', batch.args[2]!.slice('--test-reporter='.length), batch.args[3]!.slice('--test-reporter-destination='.length))
      if (!options) { rmSync(binding.dir, { recursive: true, force: true }); return undefined }
      directFinish = batch.finish
      Object.assign(env, batch.env, { NODE_OPTIONS: options })
      delete env[ENV]
    }
    if (shellKind === 'powershell' && directFinish) actualCommand = '& ' + actualCommand
    if (shellKind === 'cmd') actualCommand = (verificationArgv(actualCommand) ?? []).map((word, index) => index === 0 && /^[A-Za-z0-9_.-]+$/.test(word) ? word : '"' + word.replaceAll('"', '\\"') + '"').join(' ')
    actualCommand = unwrapped.wrap(actualCommand)
    return {
      command: actualCommand,
      env,
      read(exitCode) {
        try {
          directFinish?.(exitCode === 0)
          const names = readdirSync(binding.dir).filter(n => !isFilesystemMetadata(n) && n.endsWith('.start'))
          let executionComplete = names.length > 0, success = true
          const workspaceChanged = before !== workspaceIdentity(root)
          if (!directFinish) {
            try {
              const seal = JSON.parse(readFileSync(join(binding.dir, 'seal.json'), 'utf8')) as { runId: string; expectedBatches: number; completedBatches: number }
              executionComplete &&= seal.runId === binding.runId && seal.expectedBatches === names.length && seal.completedBatches === names.length
            } catch { executionComplete = false }
          }
          const files: TestCompletionCoverage['files'] = []
          const totals = { tests: 0, passed: 0, failed: 0, skipped: 0, cancelled: 0, todo: 0 }
          for (const name of names) {
            try {
              const batchId = name.slice(0, -6)
              const start = JSON.parse(readFileSync(join(binding.dir, name), 'utf8')) as { runId: string; cwd: string; batchId: string; args: string[] }
              const end = JSON.parse(readFileSync(join(binding.dir, batchId + '.end'), 'utf8')) as typeof start & { success: boolean }
              const receipt = JSON.parse(readFileSync(join(binding.dir, batchId + '.json'), 'utf8')) as Receipt
              const bound = start.runId === binding.runId && end.runId === binding.runId && receipt.runId === binding.runId
                && start.batchId === receipt.batchId && end.batchId === start.batchId && start.cwd === receipt.cwd && end.cwd === start.cwd
              if (!bound) { executionComplete = false; continue }
              executionComplete &&= receipt.complete && !!receipt.totals
              if (readdirSync(binding.dir).includes(batchId + '.output-error')) executionComplete = false
              success &&= end.success && receipt.success
              if (receipt.totals) for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += receipt.totals[key]
              const selected = classifyVerificationCommand(['node', ...start.args].map(shellWord).join(' ')).targets
              for (const target of (parseTestSelection(start.args).shard?.total ?? 1) > 1 ? [] : selected) {
                if (/[*?[]/.test(target)) continue
                const path = resolve(start.cwd, target)
                if (!receipt.files.some(file => realpathSync(resolve(binding.root, file.path)) === realpathSync(path))) executionComplete = false
              }
              for (const file of receipt.files) {
                if (!file.path || file.path.startsWith('../') || file.path.startsWith('/') || files.some(f => f.path === file.path)) { executionComplete = false; continue }
                files.push(file)
              }
            } catch { executionComplete = false }
          }
          return { version: 2, runId: binding.runId, runner: 'node-test', cwd: resolve(cwd), repositoryRoot: repositoryRoot ?? binding.root, executionRoot: binding.root, executionComplete, workspaceChanged, totals, complete: executionComplete && !workspaceChanged && (exitCode === 0 ? success : exitCode > 0 && files.some(file => file.outcome === 'failed')), filtered: false, files }
        } catch {
          return { version: 2, runId: binding.runId, runner: 'node-test', cwd: resolve(cwd), repositoryRoot: repositoryRoot ?? binding.root, executionRoot: binding.root, executionComplete: false, workspaceChanged: before !== workspaceIdentity(root), complete: false, filtered: false, files: [] }
        }
      },
      dispose() { rmSync(binding.dir, { recursive: true, force: true }) },
    }
  } catch { return undefined }
}

/** Validate persisted producer facts before they can satisfy an obligation. */
export function readCompletionCoverage(value: unknown): TestCompletionCoverage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const c = value as TestCompletionCoverage
  if (![1, 2, 3].includes(c.version) || !['node-test', 'vitest', 'jest'].includes(c.runner) || c.version === 1 && c.runner !== 'node-test' || typeof c.runId !== 'string' || !c.runId || typeof c.cwd !== 'string' || typeof c.repositoryRoot !== 'string'
    || typeof c.complete !== 'boolean' || typeof c.filtered !== 'boolean' || !Array.isArray(c.files)) return undefined
  if (!c.files.every(f => f && typeof f.path === 'string' && !!f.path && !/[\x00]|^[A-Za-z]:/.test(f.path) && !f.path.startsWith('/') && !f.path.split(/[\\/]/).includes('..')
    && (f.project === undefined || typeof f.project === 'string' && f.project.length <= 1024 && !/[\x00\r\n]/.test(f.project))
    && ['passed', 'failed', 'incomplete'].includes(f.outcome) && [f.tests, f.skipped, f.cancelled].every(n => Number.isInteger(n) && n >= 0) && f.skipped + f.cancelled <= f.tests)) return undefined
  if (c.executionComplete !== undefined && typeof c.executionComplete !== 'boolean' || c.workspaceChanged !== undefined && typeof c.workspaceChanged !== 'boolean'
    || c.executionRoot !== undefined && typeof c.executionRoot !== 'string'
    || c.totals && !['tests', 'passed', 'failed', 'skipped', 'cancelled', 'todo'].every(key => Number.isInteger(c.totals![key as keyof typeof c.totals]) && c.totals![key as keyof typeof c.totals] >= 0)) return undefined
  if (c.version >= 2 && c.complete && (c.executionComplete !== true || c.workspaceChanged !== false || !c.totals || !c.files.length && c.version !== 3)) return undefined
  if (new Set(c.files.map(file => JSON.stringify([file.path, file.project ?? '']))).size !== c.files.length) return undefined
  if (c.totals && (c.totals.passed + c.totals.failed + c.totals.skipped + c.totals.cancelled !== c.totals.tests || c.totals.todo > c.totals.skipped)) return undefined
  if (c.version === 3 && !validScopeCoverage(c)) return undefined
  return c
}
