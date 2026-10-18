import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getResolvedEnv } from './resolved-env.js'

/** Rewrite only the installed JS CLI, after package hooks and argument forwarding. */
export function testRunnerPreload(directory: string, cwd: string, entry: string, bridge: string | undefined, runner: 'vitest' | 'jest'): NodeJS.ProcessEnv {
  const path = join(directory, 'runner-argv.mjs')
  writeFileSync(path, `import {realpathSync} from 'node:fs';
const canonical=p=>{try{return realpathSync(p)}catch{return p}};
if(canonical(process.argv[1])===canonical(${JSON.stringify(entry)})){
const args=process.argv.slice(2),allProjects=args.includes('--rivet-all-projects'),unsharded=args.includes('--rivet-unsharded'),projects=args.filter(a=>a.startsWith('--rivet-project=')).map(a=>a.slice(16)),kept=[];
for(let i=0;i<args.length;i++){const a=args[i],k=a.split('=')[0];
if(a==='--rivet-all-projects'||a==='--rivet-unsharded'||k==='--rivet-project')continue;
if((${JSON.stringify(!!bridge)}&&['--config','-c',...(${JSON.stringify(runner === 'jest')}?['--reporters','--testResultsProcessor']:[])].includes(k))||(unsharded&&k==='--shard')||((allProjects||projects.length)&&['--project','--selectProjects','--ignoreProjects'].includes(k))){if(!a.includes('=')){i++;if(['--selectProjects','--ignoreProjects','--reporters'].includes(k))while(args[i+1]&&!args[i+1].startsWith('-'))i++;}continue;}kept.push(a);}
process.argv.splice(2,process.argv.length-2,...kept,...${JSON.stringify(bridge ? ['--config', bridge] : [])},...projects.flatMap(p=>[${JSON.stringify(runner === 'jest' ? '--selectProjects' : '--project')},p]));
}`, { mode: 0o600 })
  return { NODE_OPTIONS: `${getResolvedEnv(cwd).NODE_OPTIONS ?? ''} --import=${pathToFileURL(path).href}`.trim() }
}
