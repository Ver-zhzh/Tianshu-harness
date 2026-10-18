import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { jestProjectIdentitySource } from './test-project-identity.js'

export function createJestBridge(directory: string, binding: { root: string; origin: string; cwd: string; runId: string; config?: string; projects?: string[]; configLoader: string; sequencer: string; reporters: Array<string | [string, unknown]>; processor?: string }) {
  const report = join(directory, 'jest.json'), inventory = join(directory, 'inventory.json'), selected = join(directory, 'selected.json')
  const reporter = join(directory, 'observer.cjs'), sequencer = join(directory, 'sequencer.mjs'), bridge = join(directory, 'jest.config.cjs')
  const identity = jestProjectIdentitySource(binding.root, join(directory, 'identities.json'))
  writeFileSync(reporter, `const fs=require('node:fs');${identity}
module.exports=class {
 files=[];filtered=false;
 constructor(global){this.filtered=!!global.testNamePattern;process.on('uncaughtExceptionMonitor',()=>require('node:fs').writeFileSync(${JSON.stringify(join(directory, 'output-error'))},'uncaught_error'));}
 onTestResult(test,result){const s=scope(test);let passed=0,failed=0,skipped=0,todo=0;
 for(const t of result.testResults){if(t.status==='passed')passed++;else if(t.status==='failed')failed++;else {skipped++;if(t.status==='todo')todo++;}}
 this.files.push({...s,outcome:failed||result.testExecError?'failed':passed?'passed':'incomplete',tests:passed+failed+skipped,skipped,cancelled:0,passed,failed,todo,loadError:!!result.testExecError});}
 onRunComplete(contexts,result){const files=this.files,totals={tests:0,passed:0,failed:0,skipped:0,cancelled:0,todo:0};
 for(const f of files)for(const k of Object.keys(totals))totals[k]+=f[k]??0;
 const receipt={runId:${JSON.stringify(binding.runId)},files,totals,filtered:this.filtered,complete:!result.wasInterrupted&&!result.numRuntimeErrorTestSuites&&!files.some(f=>f.loadError)&&files.length===result.numTotalTestSuites&&totals.tests===result.numTotalTests};
 fs.writeFileSync(${JSON.stringify(report + '.partial')},JSON.stringify(receipt),{mode:0o600});fs.renameSync(${JSON.stringify(report + '.partial')},${JSON.stringify(report)});}
};`, { mode: 0o600 })
  writeFileSync(sequencer, `import {createRequire} from 'node:module';const require=createRequire(import.meta.url);const fs=require('node:fs');${identity}
import * as Original from ${JSON.stringify(pathToFileURL(binding.sequencer).href)};const Base=Original.default?.default??Original.default;
const save=(path,tests)=>fs.writeFileSync(path,JSON.stringify(tests.map(scope)),{mode:0o600});
export default class extends Base {
 async shard(tests,options){save(${JSON.stringify(inventory)},tests);const result=await super.shard(tests,options);return result;}
 async sort(tests){if(!fs.existsSync(${JSON.stringify(inventory)}))save(${JSON.stringify(inventory)},tests);const result=await super.sort(tests);save(${JSON.stringify(selected)},result);return result;}
};`, { mode: 0o600 })
  const reporters = binding.reporters.map((item, index) => {
    const [entry, options] = typeof item === 'string' ? [item, undefined] : item
    if (['default', 'summary', 'github-actions'].includes(entry)) return item
    const wrapper = join(directory, `user-reporter-${index}.mjs`)
    writeFileSync(wrapper, `import {createRequire} from 'node:module';const require=createRequire(import.meta.url);import * as mod from ${JSON.stringify(pathToFileURL(entry).href)};const Original=mod.default?.default??mod.default;
export default class {constructor(...args){const target=new Original(...args);return new Proxy(target,{get(t,key){const value=t[key];if(key==='getLastError'&&typeof value==='function')return (...args)=>{const error=value.apply(t,args);if(error)require('node:fs').writeFileSync(${JSON.stringify(join(directory, 'output-error'))},'reporter_error');return error;};return typeof value==='function'?value.bind(t):value;}});}};`, { mode: 0o600 })
    return options === undefined ? wrapper : [wrapper, options]
  })
  const processor = join(directory, 'processor.cjs')
  writeFileSync(processor, `module.exports=async result=>{${binding.processor ? `const mod=await import(require('node:url').pathToFileURL(${JSON.stringify(binding.processor)}).href);result=await (mod.default??mod)(result);` : ''}
require('node:fs').writeFileSync(${JSON.stringify(join(directory, 'processed.json'))},JSON.stringify({runId:${JSON.stringify(binding.runId)}}),{mode:0o600});return result;};`, { mode: 0o600 })
  writeFileSync(bridge, `const {readInitialOptions}=require(${JSON.stringify(binding.configLoader)});
module.exports=async()=>{const {config,configPath}=await readInitialOptions(${JSON.stringify(binding.config)}, {packageRootOrConfig:${JSON.stringify(binding.cwd)}});
const originalRoot=config.rootDir??(configPath?require('node:path').dirname(configPath):${JSON.stringify(binding.cwd)});
return {...config,rootDir:originalRoot,...(${JSON.stringify(binding.projects)}?{projects:${JSON.stringify(binding.projects)}}:config.projects?{projects:config.projects.map(p=>typeof p==='object'?{...p,rootDir:p.rootDir??originalRoot}:p)}:{}),testSequencer:${JSON.stringify(sequencer)},testResultsProcessor:${JSON.stringify(processor)},reporters:[...${JSON.stringify(reporters)},${JSON.stringify(reporter)}]};};`, { mode: 0o600 })
  return { report, inventory, selected, reporter, sequencer, bridge }
}
