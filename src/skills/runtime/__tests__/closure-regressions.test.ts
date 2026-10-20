import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { detectPythonInterpreter } from '../interpreter.js'
import { auditRequirements } from '../requirements.js'
import { execProcess } from '../../../tools/process-exec.js'

it('pip receives the audited hashes and both direct/transitive constraints', async () => {
  const python = await detectPythonInterpreter()
  assert.ok(python.found, 'Python is required by this runtime integration suite')
  const root = mkdtempSync(join(tmpdir(), 'runtime-closure-'))
  try {
    writeFileSync(join(root, 'constraints.txt'), 'six<2\ntransitive==2\n')
    const result = auditRequirements('six>=1 --hash=sha256:abcd\n-c constraints.txt\n', { packageRoot: root })
    assert.ok(result.ok)
    const audited = result.audited as typeof result.audited & { files?: Record<string, string>; rootFile?: string }
    const out = join(root, 'audited')
    mkdirSync(out)
    for (const [name, content] of Object.entries(audited.files ?? { 'requirements.txt': audited.normalized })) {
      mkdirSync(dirname(join(out, name)), { recursive: true })
      writeFileSync(join(out, name), content)
    }
    const code = 'import sys,json\nfrom pip._internal.req.req_file import parse_requirements\nfrom pip._internal.network.session import PipSession\nprint(json.dumps([dict(req=r.requirement,constraint=r.constraint,options=r.options) for r in parse_requirements(sys.argv[1],session=PipSession())]))'
    const parsed = JSON.parse(execFileSync(python.path, ['-c', code, join(out, audited.rootFile ?? 'requirements.txt')], { encoding: 'utf8' }))
    assert.deepEqual(parsed[0].options.hashes, { sha256: ['abcd'] })
    assert.ok(parsed.some((r: any) => r.req === 'six<2' && r.constraint))
    assert.ok(parsed.some((r: any) => r.req === 'transitive==2' && r.constraint))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('a pre-aborted invocation never spawns', async () => {
  const controller = new AbortController()
  controller.abort()
  let spawned = false
  const result = await execProcess({ argv: ['unused'], abortSignal: controller.signal, spawn: (() => { spawned = true; throw new Error('must not spawn') }) as any })
  assert.equal(spawned, false)
  assert.equal(result.cancelled, true)
})

it('cancellation settles only after an ignoring child can no longer write', { timeout: 12_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-cancel-'))
  const controller = new AbortController()
  let ready!: () => void
  const started = new Promise<void>(resolve => { ready = resolve })
  try {
    const pending = execProcess({ argv: [process.execPath, '-e', 'const fs=require("fs");process.on("SIGTERM",()=>{});fs.writeFileSync(process.argv[1],"initial");setInterval(()=>fs.writeFileSync(process.argv[1],String(Date.now())),30);console.log("ready")', join(root, 'tick')], abortSignal: controller.signal, onStdout: () => ready() })
    await started
    controller.abort()
    const result = await pending
    assert.equal(result.cancelled, true)
    const atReturn = readFileSync(join(root, 'tick'), 'utf8')
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(readFileSync(join(root, 'tick'), 'utf8'), atReturn)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
