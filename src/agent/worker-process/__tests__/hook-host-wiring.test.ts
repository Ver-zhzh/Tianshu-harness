import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runWorkerSessionOop } from '../parent.js'
import { ExternalHookHost } from '../../../hooks/external-hook-host.js'
import { PromptEngine } from '../../../prompt/engine.js'
import { ToolRegistry } from '../../../tools/registry.js'
import type { WorkerSessionConfig } from '../../worker-session.js'

process.env.RIVET_TRUST_PROJECT = '1'
test('worker process hook requests consume the parent-owned host at the real dispatch line', { skip: process.platform === 'win32', timeout: 10_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'rivet-worker-hook-wire-'))
  const host = new ExternalHookHost()
  let registrations = 0
  try {
    await mkdir(join(cwd, '.rivet'))
    await writeFile(join(cwd, 'hook.sh'), '#!/bin/sh\necho "$RIVET_SESSION_ID"\n')
    await chmod(join(cwd, 'hook.sh'), 0o755)
    await writeFile(join(cwd, '.rivet/hooks.json'), JSON.stringify({ hooks: [{ event: 'preTurn', script: 'hook.sh' }] }))
    const child = join(cwd, 'fixture.cjs')
    await writeFile(child, `
const {createInterface}=require('node:readline');
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
const request=(id,op,extra={})=>send({t:'hook-request',id,op,runtimeId:'remote',...extra});
createInterface({input:process.stdin}).on('line',line=>{const msg=JSON.parse(line);
 if(msg.t==='init')request('register','register');
 if(msg.t!=='hook-response')return;
 if(msg.id==='register')request('begin','begin',{runId:'run'});
 if(msg.id==='begin')request('execute','execute',{runId:'run',budgetMs:1000,context:{event:'preTurn',cwd:'/forged',sessionId:'forged'}});
 if(msg.id==='execute'){send({t:'result',run:{result:{workOrderId:'hook-worker',status:'passed',summary:JSON.stringify(msg.value),findings:[],artifacts:[],changedFiles:[],risks:[],nextActions:[],evidenceStatus:'verified'},transcript:{text:'',thinking:'',toolUses:[],toolResults:[],repairAttempts:0,errors:[]},usage:{input_tokens:0,output_tokens:0},messages:[],turnCount:0}});process.stdout.end(()=>process.exit(0))}
});`)
    const config = { client: {} as WorkerSessionConfig['client'], cwd, sessionNonce: 'nonce', order: { id: 'hook-worker', objective: 'fixture', profile: 'code_scout', allowedTools: [], budget: { maxTurns: 1, timeoutMs: 5_000 } },
      promptEngine: new PromptEngine({ model: 'fixture', maxTokens: 32, staticCtx: { tools: [] }, volatileCtx: { cwd } }),
      toolRegistry: new ToolRegistry(), maxTurns: 1, contextWindow: 64000, compact: { enabled: false, model: 'fixture' },
      runtimeDecision: { model: 'fixture', contextWindow: 64000, maxTokens: 32, isWrite: false },
      externalHookHost: { createRuntime(binding: import('../../../hooks/external-hook-types.js').HookRuntimeBinding) { registrations++; return host.createRuntime(binding) }, shutdown: () => host.shutdown(), forceExit: () => host.forceExit() },
    } as unknown as WorkerSessionConfig
    const run = await runWorkerSessionOop(config, { getMemoryBlock: () => undefined, entryOverride: { execArgs: [], script: child }, stallMsOverride: 4_000 })
    assert.equal(registrations, 1)
    const result = JSON.parse(run.result.summary)
    assert.equal(result.status, 'completed')
    assert.match(result.results[0].output, /^worker-hook-worker-nonce$/)
    assert.notEqual(result.results[0].output, 'forged')
  } finally { await host.shutdown(); await rm(cwd, { recursive: true, force: true }) }
})
