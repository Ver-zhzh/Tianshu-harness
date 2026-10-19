import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { startServer } from '../index.js'
import { buildHealthRoute } from '../health-route.js'
import { buildApprovalRoutes } from '../approval-routes.js'
import type { RuntimeSessionManager } from '../session-manager.js'
import { SseStream } from '../sse-stream.js'
import { commitScopedFiles } from '../../agent/scoped-git-commit.js'

test('real slow commit hook leaves readyz, approval reads and SSE responsive', { timeout: 20_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'long-task-health-'))
  const git = (args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
  git(['init', '-q']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.com'])
  writeFileSync(join(cwd, 'owned.txt'), 'base'); writeFileSync(join(cwd, 'other.txt'), 'base')
  git(['add', '--', 'owned.txt', 'other.txt']); git(['commit', '-qm', 'base'])
  writeFileSync(join(cwd, 'owned.txt'), 'change'); writeFileSync(join(cwd, 'other.txt'), 'other session')
  git(['add', '--', 'other.txt'])
  const staged = git(['diff', '--cached'])
  const hook = join(cwd, '.git/hooks/pre-commit')
  writeFileSync(hook, `#!/bin/sh\n"${process.execPath.replaceAll('"', '\\"')}" -e 'setTimeout(()=>{},1200)'\n`)
  chmodSync(hook, 0o755)
  const manager = {
    stats: () => ({ sessionCount: 1, runningCount: 1 }), getStorageHealth: () => undefined,
    getApprovalSnapshot: () => ({ approvals: [], lastSeq: 0 }), answerIntervention: () => false,
  } as unknown as RuntimeSessionManager
  const server = await startServer(0, {
    ...buildHealthRoute(manager, Date.now(), 'fixture', 'fixture'), ...buildApprovalRoutes(manager, 'fixture'),
    'GET /progress': (_body, _params, _headers, res) => {
      const stream = new SseStream(res!)
      const timer = setInterval(() => stream.send('heartbeat', {}), 50)
      res!.once('close', () => { clearInterval(timer); stream.close() })
      return { status: 200, handled: true }
    },
  }, 'fixture')
  const probe = new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    (async()=>{
      let failed=0,max=0,heartbeats=0;
      const headers={authorization:'Bearer fixture'};
      const stream=await fetch(workerData+'/progress',{headers});const reader=stream.body.getReader();
      const reading=(async()=>{try{while(true){const x=await reader.read();if(x.done)break;heartbeats++}}catch{}})();
      parentPort.postMessage('ready');
      for(let i=0;i<16;i++){
        const start=Date.now();
        try{for(const path of ['/readyz','/sessions/s/interventions']){const r=await fetch(workerData+path,{headers,signal:AbortSignal.timeout(350)});if(r.status!==200)failed++;await r.text()}}
        catch{failed++}max=Math.max(max,Date.now()-start);await new Promise(r=>setTimeout(r,100));
      }
      await reader.cancel();await reading;parentPort.postMessage({failed,max,heartbeats});
    })().catch(e=>{throw e});`, { eval: true, workerData: `http://127.0.0.1:${server.port}` })
  try {
    await new Promise<void>((resolve, reject) => { probe.once('message', () => resolve()); probe.once('error', reject) })
    const resultPromise = new Promise<{ failed: number; max: number; heartbeats: number }>((resolve, reject) => { probe.once('message', resolve); probe.once('error', reject) })
    const result = await commitScopedFiles({ cwd, files: ['owned.txt'], message: 'slow hook' })
    assert.equal(result.ok, true, result.output)
    const observation = await resultPromise
    assert.equal(observation.failed, 0, JSON.stringify(observation))
    assert.ok(observation.heartbeats >= 15, JSON.stringify(observation))
    assert.equal(git(['diff', '--cached']), staged)
    assert.equal(git(['show', '--format=', '--name-only', 'HEAD']).trim(), 'owned.txt')
  } finally {
    await probe.terminate()
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections() })
    rmSync(cwd, { recursive: true, force: true })
  }
})
