import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { verifyCliHookRuntime } from './cli-hook-runtime.mjs'

await verifyCliHookRuntime(process.cwd())
const temporary = await mkdtemp(join(tmpdir(), 'rivet-cli-hook-install-'))
try {
  // npm's executable is a script on Windows; invoke the current npm CLI with Node.
  const npmCli = process.env.npm_execpath
  const runNpm = args => npmCli ? execFileSync(process.execPath, [npmCli, ...args], { encoding: 'utf8', windowsHide: true })
    : execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' })
  const packOutput = runNpm(['pack', '--json', '--pack-destination', temporary])
  const packed = JSON.parse(packOutput.slice(packOutput.lastIndexOf('\n[') + 1))[0]
  runNpm(['install', '--prefix', temporary, '--ignore-scripts', '--no-audit', '--no-fund', join(temporary, packed.filename)])
  const root = join(temporary, 'node_modules', 'tianshu-harness')
  await verifyCliHookRuntime(root)
  const manifest = JSON.parse(await readFile(join(root, 'dist', 'hook-runtime', 'manifest.json'), 'utf8'))
  if (process.platform === 'win32') {
    const helper = join(root, 'dist', 'hook-runtime', manifest.files[process.arch].path)
    const capability = JSON.parse(execFileSync(helper, ['--hook-capabilities'], { encoding: 'utf8', windowsHide: true }))
    if (capability.hookProtocol !== 1) throw new Error('Installed helper is incompatible')
  }
  process.stdout.write('Installed CLI hook runtime verified\n')
} finally { await rm(temporary, { recursive: true, force: true }) }
