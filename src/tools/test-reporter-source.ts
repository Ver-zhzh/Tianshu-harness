import { vitestProjectIdentitySource } from './test-vitest-identity.js'

/** A run-specific observer. It writes no console output and changes no test result. */
export function vitestReporterSource(binding: { runId: string; root: string; path: string }): string {
  return `import {writeFileSync,renameSync,realpathSync} from 'node:fs';
import {relative,resolve} from 'node:path';
const binding=${JSON.stringify(binding)};
${vitestProjectIdentitySource(binding.root)}
const canonical=p=>{try{return realpathSync(p)}catch{return resolve(p)}};
const path=p=>relative(canonical(binding.root),canonical(p)).replaceAll('\\\\','/');
export default class CompletionReporter {
  done=false; filtered=false; expected=new Set();
  onInit(ctx){this.ctx=ctx; const used=v=>Array.isArray(v)?v.length>0:!!v&&typeof v!=='object';this.filtered=!!ctx.config.testNamePattern||used(ctx.config.testTagsFilter)||used(ctx.config.tags)||used(ctx.config.lineNumber);}
  key(file,project){return JSON.stringify([path(file),project]);}
  project(module){return String(module.project?.name??module.project?.config?.name??module.projectName??'default')+':'+String(module.task?.pool??module.pool??'test');}
  onTestRunStart(specs){for(const spec of specs)this.expected.add(this.key(spec.moduleId,this.project(spec)));}
  only(task){if(task.mode==='only')this.filtered=true;for(const child of task.tasks??[])this.only(child);}
  onCollected(files){for(const file of files)this.only(file);}
  onTestModuleCollected(module){this.only(module.task??module);}
  finish(files,errors,reason){
    if(this.done)return;this.done=true;
    const totals={tests:0,passed:0,failed:0,skipped:0,cancelled:0,todo:0};
    let complete=reason!=='interrupted'&&!(errors?.length);
    const observed=[];
    for(const module of files){
      const task=module.task??module;this.only(task);
      const modern=typeof module.state==='function';
      const tests=modern?[...module.children.allTests()]:[];
      if(!modern){const walk=t=>{if(t.type==='test')tests.push(t);else for(const c of t.tasks??[])walk(c)};walk(task);}
      let passed=0,failed=0,skipped=0,cancelled=0,todo=0;
      for(const test of tests){
        const raw=test.task??test;this.only(raw);
        const state=modern?test.result()?.state:raw.result?.state;
        if(state==='passed'||state==='pass')passed++;
        else if(state==='failed'||state==='fail')failed++;
        else if(state==='skipped'||raw.mode==='skip'||state==='pending'&&raw.mode==='todo'){skipped++;if(raw.mode==='todo')todo++;}
        else if(raw.mode==='todo'||state==='todo'){skipped++;todo++;}
        else cancelled++;
      }
      const state=modern?module.state():task.result?.state;
      const outcome=state==='failed'||state==='fail'||failed?'failed':passed&&cancelled===0?'passed':'incomplete';
      const conditions=module.project?.config??this.ctx.getProjectByName(module.projectName??'').config;
      const file={projectConfig:projectConfig(conditions),path:path(module.moduleId??task.filepath),label:String(module.project?.name??module.project?.config?.name??module.projectName??''),project:this.project(module),outcome,tests:tests.length,skipped,cancelled};
      observed.push(file);
      for(const [key,value] of Object.entries({tests:tests.length,passed,failed,skipped,cancelled,todo}))totals[key]+=value;
      if(cancelled)complete=false;
    }
    // Expected project/file identities are recorded before execution, not inferred from successes.
    if(!this.ctx.config.shard&&this.expected.size)for(const key of this.expected)if(!observed.some(f=>JSON.stringify([f.path,f.project])===key))complete=false;
    const receipt={...binding,complete,filtered:this.filtered,files:observed,totals};
    writeFileSync(binding.path+'.partial',JSON.stringify(receipt),{mode:0o600});renameSync(binding.path+'.partial',binding.path);
  }
  onTestRunEnd(files,errors,reason){this.finish(files,errors,reason);}
  onFinished(files,errors){this.finish(files??[],errors,'finished');}
}
`
}
