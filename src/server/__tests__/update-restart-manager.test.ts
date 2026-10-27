import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeSessionManager, type ManagedAgent, type SessionPersistenceAdapter } from '../session-manager.js'
const persistence = (fail = false): SessionPersistenceAdapter => ({ saveRecord(){}, appendEvent(){}, loadAll:()=>[], flushThrough:async(_,seq)=>{if(fail)throw new Error('disk full');return seq},flushAllAsync:async()=>{},healthSnapshot:()=>({failedSessions:0,pendingEvents:0}) })
function manager(fail = false) { return new RuntimeSessionManager({defaultCwd:'/tmp/update-restart-test',createAgent:()=>({} as ManagedAgent),persistence:persistence(fail)}) }
test('real manager restart gate blocks run and delegate until cancellation',async()=>{const m=manager();try{const s=m.createSession();await m.prepareUpdateRestart(false,AbortSignal.timeout(5000));assert.equal(m.run(s.id,'must not start'),false);assert.equal((await m.delegate(s.id,{objective:'must not start'})).ok,false);assert.equal(m.isUpdateRestartPreparing(),true);m.cancelUpdateRestart();assert.equal(m.isUpdateRestartPreparing(),false)}finally{m.cancelUpdateRestart();await m.shutdownAll()}})
test('failed persistence unlocks real manager and never acknowledges readiness',async()=>{const m=manager(true);try{m.createSession();await assert.rejects(m.prepareUpdateRestart(false,AbortSignal.timeout(5000)),/disk full/);assert.equal(m.isUpdateRestartPreparing(),false)}finally{await m.shutdownAll()}})
test('stuck activity under force reports busy-timeout instead of a save failure',async()=>{const m=manager();try{const s=m.createSession();(m as unknown as {sessions:Map<string,{running:boolean}>}).sessions.get(s.id)!.running=true;await assert.rejects(m.prepareUpdateRestart(true,AbortSignal.timeout(300)),/UPDATE_BUSY_TIMEOUT/)}finally{await m.shutdownAll()}})
test('allowUnsaved proceeds despite persistence failure; default stays fail-closed',async()=>{const m=manager(true);try{m.createSession();await assert.rejects(m.prepareUpdateRestart(false,AbortSignal.timeout(5000)),/disk full/);const m2=manager(true);try{m2.createSession();await m2.prepareUpdateRestart(false,AbortSignal.timeout(5000),{allowUnsaved:true})}finally{await m2.shutdownAll()}}finally{await m.shutdownAll()}})
test('allowUnsaved tolerates a burned deadline mid-flush; explicit cancel still blocks',async()=>{
  const hanging = (): SessionPersistenceAdapter => ({ saveRecord(){}, appendEvent(){}, loadAll:()=>[],
    flushThrough:(_, seq, signal)=>new Promise((_,reject)=>{ if (signal?.aborted) return reject(signal.reason); signal?.addEventListener('abort',()=>reject(signal.reason)) }),
    flushAllAsync:async()=>{}, healthSnapshot:()=>({failedSessions:0,pendingEvents:0}) })
  const mgr = () => new RuntimeSessionManager({ defaultCwd:'/tmp/update-restart-test', createAgent:()=>({} as ManagedAgent), persistence:hanging() })
  const m1 = mgr(); try { m1.createSession(); await assert.rejects(m1.prepareUpdateRestart(false, AbortSignal.timeout(120)), /timeout/i) } finally { await m1.shutdownAll() }
  const m2 = mgr(); try { m2.createSession(); await m2.prepareUpdateRestart(false, AbortSignal.timeout(120), { allowUnsaved:true }); assert.equal(m2.isUpdateRestartPreparing(), true) } finally { m2.cancelUpdateRestart(); await m2.shutdownAll() }
  const m3 = mgr(); const c = new AbortController(); try { m3.createSession(); const p = m3.prepareUpdateRestart(false, c.signal, { allowUnsaved:true }); setTimeout(()=>c.abort(), 50); await assert.rejects(p) } finally { await m3.shutdownAll() }
})
