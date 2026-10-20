/** Synthetic, dependency-free recovery task. Oracle/grader never enters the model workspace. */
export const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'durable-task-service', private: true, type: 'module', scripts: { test: 'node --test test/*.test.mjs', reproduce: 'node scripts/reproduce.mjs' } }, null, 2),
  'README.md': `# Durable task service

Small local service: callers enqueue work, lease it, and report completion.
The event journal is the recovery source. Multiple namespaces can use one data directory.
No dependencies or network access are needed. Run node --test test/smoke.test.mjs
and node scripts/reproduce.mjs. Source is under src/.

Contract: completion belongs to exactly one lease. A later retry supersedes the
old lease, cancellation cannot be undone by an old completion, and a process
restart must not reuse an earlier lease identity. Namespace histories are independent.
Preserve the existing API and journal format; old valid journals must still load.
`,
  'src/journal.mjs': `import {mkdirSync,existsSync,readFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';

export class Journal {
  constructor(directory, namespace) {
    mkdirSync(directory,{recursive:true});
    this.path=join(directory,'events.jsonl');
  }
  read() {
    if(!existsSync(this.path)) return [];
    return readFileSync(this.path,'utf8').split('\\n').filter(Boolean).map(line=>JSON.parse(line));
  }
  append(event) { appendFileSync(this.path,JSON.stringify(event)+'\\n'); }
}
`,
  'src/state.mjs': `export function reduce(state,event) {
  const job=state.get(event.jobId);
  switch(event.type) {
    case 'queued':
      if(!job) state.set(event.jobId,{id:event.jobId,payload:event.payload,status:'queued',attempt:0,token:null,result:null});
      break;
    case 'started':
      if(job) Object.assign(job,{status:'running',attempt:event.attempt,token:event.token,result:null});
      break;
    case 'finished':
      if(job) Object.assign(job,{status:event.ok?'succeeded':'failed',result:event.result});
      break;
    case 'cancelled':
      if(job) job.status='cancelled';
      break;
  }
  return state;
}

export function replay(events) { return events.reduce(reduce,new Map()); }
`,
  'src/service.mjs': `import {Journal} from './journal.mjs';
import {reduce,replay} from './state.mjs';

export function createService(directory,namespace) {
  const journal=new Journal(directory,namespace);
  const state=replay(journal.read());
  let counter=0;
  function record(event) { journal.append(event); reduce(state,event); }
  function view(id) { const job=state.get(id); return job?structuredClone(job):null; }
  return {
    enqueue(id,payload) {
      if(!state.has(id)) record({type:'queued',jobId:id,payload});
      return view(id);
    },
    start(id) {
      const job=state.get(id);
      if(!job || !['queued','failed'].includes(job.status)) throw new Error('not startable');
      const attempt=job.attempt+1;
      const token=namespace+':'+id+':'+(++counter);
      record({type:'started',jobId:id,attempt,token});
      return {id,token,attempt};
    },
    finish(id,token,ok,result) {
      if(!state.has(id)) return {accepted:false,job:null};
      record({type:'finished',jobId:id,token,ok,result});
      return {accepted:true,job:view(id)};
    },
    cancel(id) {
      if(state.has(id)) record({type:'cancelled',jobId:id});
      return view(id);
    },
    get:view,
    events:()=>structuredClone(journal.read()),
  };
}
`,
  'test/smoke.test.mjs': `import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createService} from '../src/service.mjs';
test('single lease succeeds and survives restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'task-smoke-'));
  try {const a=createService(dir,'one');a.enqueue('x',{value:1});const run=a.start('x');
    assert.equal(a.finish('x',run.token,true,42).accepted,true);
    assert.equal(createService(dir,'one').get('x').result,42);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('cannot start already running job',()=>{
  const dir=mkdtempSync(join(tmpdir(),'task-smoke-'));
  try {const a=createService(dir,'one');a.enqueue('x',{});a.start('x');assert.throws(()=>a.start('x'));}
  finally {rmSync(dir,{recursive:true,force:true});}
});
`,
  'scripts/reproduce.mjs': `import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createService} from '../src/service.mjs';
const dir=mkdtempSync(join(tmpdir(),'task-repro-'));
try {
  const a=createService(dir,'reports');a.enqueue('export',{});
  const old=a.start('export');a.finish('export',old.token,false,'timeout');
  const current=a.start('export');a.finish('export',current.token,false,'current failure');
  const late=a.finish('export',old.token,true,'old success');
  console.log(JSON.stringify({old,current,late,afterRestart:createService(dir,'reports').get('export')}));
  assert.equal(late.accepted,false,'late result must be rejected');
  assert.equal(a.get('export').status,'failed');
} finally {rmSync(dir,{recursive:true,force:true});}
`,
}

// Private independent behavioural checks, using only the pre-existing public API.
export const GRADER = `import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const root=process.argv[2];
const {createService}=await import(pathToFileURL(join(root,'src/service.mjs')));
const {replay}=await import(pathToFileURL(join(root,'src/state.mjs')));
const results=[];
const cases={
  'normal-success':(d)=>{const s=createService(d,'a');s.enqueue('x',{});const r=s.start('x');assert.equal(s.finish('x',r.token,true,4).accepted,true);assert.equal(s.get('x').result,4);},
  'wrong-token':(d)=>{const s=createService(d,'a');s.enqueue('x',{});s.start('x');assert.equal(s.finish('x','foreign',true,4).accepted,false);assert.equal(s.get('x').status,'running');},
  'late-retry-result':(d)=>{const s=createService(d,'a');s.enqueue('x',{});const r=s.start('x');s.finish('x',r.token,false,0);const t=s.start('x');assert.notEqual(r.token,t.token);s.finish('x',t.token,false,1);assert.equal(s.finish('x',r.token,true,9).accepted,false);assert.equal(s.get('x').result,1);},
  'cancelled-result':(d)=>{const s=createService(d,'a');s.enqueue('x',{});const r=s.start('x');s.cancel('x');assert.equal(s.finish('x',r.token,true,9).accepted,false);assert.equal(createService(d,'a').get('x').status,'cancelled');},
  'duplicate-result':(d)=>{const s=createService(d,'a');s.enqueue('x',{});const r=s.start('x');s.finish('x',r.token,true,1);const n=s.events().length;assert.equal(s.finish('x',r.token,true,9).accepted,false);assert.equal(s.events().length,n);assert.equal(s.get('x').result,1);},
  'restart-token':(d)=>{let s=createService(d,'a');s.enqueue('x',{});const old=s.start('x');s.finish('x',old.token,false,0);s=createService(d,'a');const next=s.start('x');assert.notEqual(next.token,old.token);assert.equal(s.finish('x',old.token,true,9).accepted,false);assert.equal(s.get('x').status,'running');},
  'namespace-isolation':(d)=>{const a=createService(d,'a'),b=createService(d,'b');a.enqueue('x',{owner:'a'});b.enqueue('x',{owner:'b'});a.start('x');assert.equal(createService(d,'b').get('x').status,'queued');assert.equal(createService(d,'b').get('x').payload.owner,'b');},
  'replay-stale':()=>{const events=[{type:'queued',jobId:'x',payload:{}},{type:'started',jobId:'x',attempt:1,token:'one'},{type:'finished',jobId:'x',token:'one',ok:false,result:0},{type:'started',jobId:'x',attempt:2,token:'two'},{type:'finished',jobId:'x',token:'one',ok:true,result:9}];assert.equal(replay(events).get('x').status,'running');},
  'legacy-journal-replay':()=>{assert.equal(replay([{type:'queued',jobId:'x',payload:1},{type:'started',jobId:'x',attempt:1,token:'t'},{type:'finished',jobId:'x',token:'t',ok:true,result:7}]).get('x').result,7);},
  'safe-namespace-path':(d)=>{const s=createService(d,'../other');s.enqueue('x',{});assert.ok(createService(d,'../other').get('x'));assert.equal(createService(d,'other').get('x'),null);},
  'repeated-restarts':(d)=>{let s=createService(d,'a');s.enqueue('x',{});const tokens=[];for(let i=0;i<5;i++){s=createService(d,'a');const r=s.start('x');assert.ok(!tokens.includes(r.token));tokens.push(r.token);s.finish('x',r.token,false,i);}assert.equal(s.get('x').attempt,5);},
  'rejected-not-durable':(d)=>{const s=createService(d,'a');s.enqueue('x',{});s.start('x');const n=s.events().length;s.finish('x','foreign',true,9);assert.equal(s.events().length,n);assert.equal(createService(d,'a').get('x').status,'running');},
};
for(const [id,fn] of Object.entries(cases)){const dir=mkdtempSync(join(root,'.grade-'));try{fn(dir);results.push({id,passed:true});}catch(e){results.push({id,passed:false,error:e.message.slice(0,250)});}finally{rmSync(dir,{recursive:true,force:true});}}
console.log(JSON.stringify({results}));process.exitCode=results.every(r=>r.passed)?0:1;
`

export function referenceFix(files: Record<string, string>): Record<string, string> {
  return { ...files,
    'src/journal.mjs': files['src/journal.mjs']!.replace("this.path=join(directory,'events.jsonl');", "this.path=join(directory,Buffer.from(namespace).toString('hex')+'.jsonl');"),
    'src/state.mjs': files['src/state.mjs']!.replace("if(job) Object.assign(job,{status:event.ok?'succeeded':'failed',result:event.result});", "if(job && job.status==='running' && job.token===event.token) Object.assign(job,{status:event.ok?'succeeded':'failed',result:event.result});"),
    'src/service.mjs': files['src/service.mjs']!.replace("  let counter=0;\n", '').replace("(++counter)", 'attempt').replace("if(!state.has(id)) return {accepted:false,job:null};", "const current=state.get(id);\n      if(!current || current.status!=='running' || current.token!==token) return {accepted:false,job:view(id)};"),
  }
}
