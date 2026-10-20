import type { ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import assert from 'node:assert/strict'
import { verdict } from './experiment-protocol.js'

/** Public operation driver only; all assertions stay in the parent controller. */
export const SYNTHETIC_DRIVER = `import {createInterface} from 'node:readline';
import {createService} from '../src/service.mjs';import {replay} from '../src/state.mjs';
import {join} from 'node:path';const services=new Map();
console.log('@experiment-rpc '+JSON.stringify({ready:true}));
for await(const line of createInterface({input:process.stdin})){
 let q;try{q=JSON.parse(line);let value;
 if(q.op==='open'){services.set(q.id,createService(join(process.cwd(),'.tmp',q.dir),q.namespace));value=true;}
 else if(q.op==='replay')value=Object.fromEntries(replay(q.events));
 else if(q.op==='call')value=services.get(q.id)[q.method](...q.args);
 else throw new Error('unknown operation');
 console.log('@experiment-rpc '+JSON.stringify({request:q.request,value}));
 }catch(e){console.log('@experiment-rpc '+JSON.stringify({request:q?.request,error:String(e.message)}));}
}
`
export async function gradeSynthetic(start: () => Promise<ChildProcess>, stop: (child: ChildProcess) => void) {
  const child = await start(), pending = new Map<number, { yes: (x: any) => void; no: (e: Error) => void }>()
  let index = 0, readyResolve!: () => void
  const ready = new Promise<void>(r => { readyResolve = r })
  const lines = createInterface({ input: child.stdout! })
  lines.on('line', line => {
    if (!line.startsWith('@experiment-rpc ')) return
    try { const row = JSON.parse(line.slice(16)); if (row.ready) readyResolve(); const p = pending.get(row.request); if (p) { pending.delete(row.request); if (row.error) p.no(new Error(row.error)); else p.yes(row.value) } } catch { /* candidate output is not trusted evidence */ }
  })
  child.stderr?.resume()
  child.once('close', () => { for (const p of pending.values()) p.no(new Error('RPC child exited')); pending.clear() })
  const call = async (q: any) => {
    const request = ++index
    return new Promise<any>((yes, no) => {
      const t = setTimeout(() => { pending.delete(request); no(new Error('RPC operation deadline')) }, 1500)
      pending.set(request, { yes: v => { clearTimeout(t); yes(v) }, no: e => { clearTimeout(t); no(e) } })
      child.stdin!.write(JSON.stringify({ ...q, request }) + '\n')
    })
  }
  const open = (id: string, dir: string, namespace = 'a') => call({ op: 'open', id, dir, namespace })
  const run = (id: string, method: string, ...args: any[]) => call({ op: 'call', id, method, args })
  const replay = (events: any[]) => call({ op: 'replay', events })
  const queued = { type: 'queued', jobId: 'x', payload: {} }, started = { type: 'started', jobId: 'x', attempt: 1, token: 'one' }
  const cases: Record<string, (d: string) => Promise<void>> = {
    'normal-success': async d => { await open('s', d); await run('s', 'enqueue', 'x', {}); const r = await run('s', 'start', 'x'); assert.equal((await run('s', 'finish', 'x', r.token, true, 4)).accepted, true); assert.equal((await run('s', 'get', 'x')).result, 4) },
    'wrong-token': async d => { await open('s', d); await run('s', 'enqueue', 'x', {}); await run('s', 'start', 'x'); assert.equal((await run('s', 'finish', 'x', 'foreign', true, 4)).accepted, false); assert.equal((await run('s', 'get', 'x')).status, 'running') },
    'late-retry-result': async d => { await open('s', d); await run('s', 'enqueue', 'x', {}); const r = await run('s', 'start', 'x'); await run('s', 'finish', 'x', r.token, false, 0); const t = await run('s', 'start', 'x'); assert.notEqual(r.token, t.token); await run('s', 'finish', 'x', t.token, false, 1); assert.equal((await run('s', 'finish', 'x', r.token, true, 9)).accepted, false); assert.equal((await run('s', 'get', 'x')).result, 1) },
    'cancelled-result': async d => { await open('s', d); await run('s', 'enqueue', 'x', {}); const r = await run('s', 'start', 'x'); await run('s', 'cancel', 'x'); assert.equal((await run('s', 'finish', 'x', r.token, true, 9)).accepted, false); await open('s', d); assert.equal((await run('s', 'get', 'x')).status, 'cancelled') },
    'duplicate-result': async d => { await open('s', d); await run('s', 'enqueue', 'x', {}); const r = await run('s', 'start', 'x'); await run('s', 'finish', 'x', r.token, true, 1); const n = (await run('s', 'events')).length; assert.equal((await run('s', 'finish', 'x', r.token, true, 9)).accepted, false); assert.equal((await run('s', 'events')).length, n); assert.equal((await run('s', 'get', 'x')).result, 1) },
    'restart-token': async d => { await open('s', d); await run('s', 'enqueue', 'x', {}); const r = await run('s', 'start', 'x'); await run('s', 'finish', 'x', r.token, false, 0); await open('s', d); const t = await run('s', 'start', 'x'); assert.notEqual(t.token, r.token); assert.equal((await run('s', 'finish', 'x', r.token, true, 9)).accepted, false); assert.equal((await run('s', 'get', 'x')).status, 'running') },
    'namespace-isolation': async d => { await open('s', d); await open('b', d, 'b'); await run('s', 'enqueue', 'x', { owner: 'a' }); await run('b', 'enqueue', 'x', { owner: 'b' }); await run('s', 'start', 'x'); await open('b', d, 'b'); assert.equal((await run('b', 'get', 'x')).status, 'queued'); assert.equal((await run('b', 'get', 'x')).payload.owner, 'b') },
    'replay-stale': async () => { const state = await replay([queued, started, { type: 'finished', jobId: 'x', token: 'one', ok: false, result: 0 }, { ...started, attempt: 2, token: 'two' }, { type: 'finished', jobId: 'x', token: 'one', ok: true, result: 9 }]); assert.equal(state.x.status, 'running') },
    'legacy-journal-replay': async () => { const state = await replay([queued, started, { type: 'finished', jobId: 'x', token: 'one', ok: true, result: 7 }]); assert.equal(state.x.result, 7) },
    'safe-namespace-path': async d => { await open('s', d, '../other'); await run('s', 'enqueue', 'x', {}); await open('s', d, '../other'); assert.ok(await run('s', 'get', 'x')); await open('s', d, 'other'); assert.equal(await run('s', 'get', 'x'), null) },
    'repeated-restarts': async d => { await open('s', d); await run('s', 'enqueue', 'x', {}); const tokens: string[] = []; for (let i = 0; i < 5; i++) { await open('s', d); const r = await run('s', 'start', 'x'); assert.ok(!tokens.includes(r.token)); tokens.push(r.token); await run('s', 'finish', 'x', r.token, false, i) }; assert.equal((await run('s', 'get', 'x')).attempt, 5) },
    'rejected-not-durable': async d => { await open('s', d); await run('s', 'enqueue', 'x', {}); await run('s', 'start', 'x'); const n = (await run('s', 'events')).length; await run('s', 'finish', 'x', 'foreign', true, 9); assert.equal((await run('s', 'events')).length, n); await open('s', d); assert.equal((await run('s', 'get', 'x')).status, 'running') },
  }
  const results = []
  try {
    let t: ReturnType<typeof setTimeout>
    try { await Promise.race([ready, new Promise((_, no) => { t = setTimeout(() => no(new Error('RPC startup deadline')), 2000) })]) } finally { clearTimeout(t!) }
    for (const [id, fn] of Object.entries(cases)) {
      try { await fn('grade-' + id); results.push(verdict(id, true, {})) }
      catch (e) { results.push(verdict(id, e instanceof assert.AssertionError ? false : null, { error: e instanceof Error ? e.message.slice(0, 300) : 'unknown' }, e instanceof assert.AssertionError ? 'candidate' : 'unknown')) }
    }
  } catch (e) { for (const id of Object.keys(cases)) results.push(verdict(id, null, { error: String(e) }, 'harness')) }
  finally { lines.close(); stop(child); child.stdin?.destroy() }
  return results
}
