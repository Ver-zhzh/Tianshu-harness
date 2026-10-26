import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { DEFAULT_CONFIG } from '../config/default.js'
import { providerSchema } from '../config/schema.js'
import { buildManagedAgent } from '../server/serve-agent.js'
import { __resetToolPresetForTest } from '../tools/tool-preset.js'

const root = resolve('.'), home = mkdtempSync(join(tmpdir(), 'focused-wire-'))
const captured: string[][] = []
let hold: { entered: () => void; wait: Promise<void> } | undefined
const server = createServer(async (req, res) => {
  let text = ''; for await (const chunk of req) text += chunk
  const body = JSON.parse(text)
  if (body.tools?.length) captured.push(body.tools.map((tool: any) => tool.function.name))
  if (hold) { const current = hold; current.entered(); await current.wait }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  if (JSON.stringify(body.messages).includes('ASK_FIXTURE') && !body.messages.some((message: any) => message.role === 'tool')) {
    res.end('data: '+JSON.stringify({ choices:[{delta:{tool_calls:[{index:0,id:'fixture-question',type:'function',function:{name:'ask_user_question',arguments:JSON.stringify({question:'请补充实际目标目录。'})}}]},finish_reason:null}] })+'\n\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:100,completion_tokens:10}})+'\n\ndata: [DONE]\n\n')
    return
  }
  res.end('data: '+JSON.stringify({choices:[{delta:{content:'已完成本次只读观察。'},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:10}})+'\n\ndata: [DONE]\n\n')
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${(server.address() as any).port}/v1`
const previous = Object.fromEntries(['RIVET_HOME','RIVET_SESSION_DIR','RIVET_CONFIG_PATH','RIVET_TOOL_PRESET','TIANSHU_TOOL_FIXTURE_KEY','RIVET_COMPUTER_USE_AUTOMOUNT'].map(key => [key, process.env[key]]))
after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); for (const [key,value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }; __resetToolPresetForTest(); rmSync(home,{recursive:true,force:true}) })
const provider = providerSchema.parse({ name:'wirefixture',baseUrl:url,protocol:'openai',thinking:'disabled',apiKeyEnv:'TIANSHU_TOOL_FIXTURE_KEY',models:[{id:'wire-main',contextWindow:200000,maxTokens:1024},{id:'wire-next',contextWindow:200000,maxTokens:1024}] })
const callbacks = { onTextDelta() {},onThinkingDelta() {},onToolUse() {},onToolResult() {},onTurnComplete() {},onError(error: Error) { throw error },onAbort() {},onApprovalRequired:async()=>false }

async function headless(preset: string, prompt = '仅回答本次只读观察已完成，不要调用工具。') {
  const cwd = mkdtempSync(join(home, 'cli-'))
  writeFileSync(join(cwd,'config.json'),JSON.stringify({provider:{default:'wirefixture',providers:{wirefixture:provider}},agent:{defaultModel:'wirefixture:wire-main',defaultDomain:'qiming',verificationSnapshot:'off'},tools:{preset}}))
  const env = { ...process.env, NODE_TEST_CONTEXT:undefined, RIVET_HOME:cwd, RIVET_CONFIG_PATH:join(cwd,'config.json'),RIVET_SESSION_DIR:join(cwd,'sessions'),RIVET_TOOL_PRESET:preset,TIANSHU_TOOL_FIXTURE_KEY:'fixture',RIVET_PRO:'0' }
  const index = captured.length
  const child = spawn(process.execPath,['--import',pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,join(root,'src/main.ts'),'-p',prompt,'--json'],{cwd,env,stdio:['ignore','pipe','pipe']})
  let stderr='',stdout='';child.stdout.on('data',chunk=>{stdout+=String(chunk)});child.stderr.on('data',chunk=>{stderr+=String(chunk)})
  const timer=setTimeout(()=>child.kill('SIGKILL'),45000)
  const code=await new Promise<number|null>(resolve=>child.on('close',resolve));clearTimeout(timer)
  assert.equal(code,0,stderr.slice(-1200));assert.ok(captured.length>index,'real CLI must send a model request')
  if (prompt.includes('ASK_FIXTURE')) assert.match(JSON.parse(stdout.trim()).text, /请补充实际目标目录/, 'the actual question tool must reach the CLI result')
  return captured[index]!
}
for(const [preset,count] of [['minimal',26],['orchestration',30]] as const) test(`real -p request exposes ${count} tools for ${preset}`,async()=>{
  const names=await headless(preset)
  assert.equal(names.length,count,JSON.stringify(names))
  for(const name of ['delegate_task','delegate_batch','team_orchestrate'])assert.ok(names.includes(name),name)
  for(const name of ['galaxy','starflow','plan_task','council_convene'])assert.equal(names.includes(name),preset==='orchestration',name)
})

test('real -p explicit workflow activates only its required cold tool',async()=>{
  const names=await headless('minimal','/galaxy 仅作只读观察，不要派发任务。')
  assert.equal(names.length,27);assert.ok(names.includes('galaxy'));assert.ok(!names.includes('starflow'))
})

test('a real headless question tool reaches output instead of silently ending the run',async()=>{
  assert.equal((await headless('minimal','ASK_FIXTURE')).length,26)
})

test('real managed sidecar request retains an explicit mount across model replacement',async()=>{
  process.env.RIVET_HOME=home;process.env.RIVET_SESSION_DIR=join(home,'sessions');process.env.RIVET_CONFIG_PATH=join(home,'empty-config.json');process.env.RIVET_TOOL_PRESET='minimal';process.env.TIANSHU_TOOL_FIXTURE_KEY='fixture';__resetToolPresetForTest()
  const config=structuredClone(DEFAULT_CONFIG);config.agent.defaultDomain='qiming';config.agent.verificationSnapshot='off';config.agent.maxTurns=2;config.provider={default:'wirefixture',providers:{wirefixture:provider}}
  const agent=buildManagedAgent({config,provider,model:provider.models[0]!,apiKey:'fixture',configured:true},home,'managed-wire',undefined,'manual')
  try{
    let start=captured.length;await agent.run('只读观察已完成，不调用工具。',callbacks)
    assert.equal(captured[start]!.length,26,JSON.stringify(captured[start]))
    assert.equal(agent.enableTool!('galaxy').status,'mounted')
    assert.ok(agent.getToolSurface!().tools.some(tool=>tool.name==='galaxy'&&tool.state==='visible'))
    start=captured.length;await agent.run('明确启用后继续只读，不调用工具。',callbacks)
    assert.equal(captured[start]!.length,27);assert.ok(captured[start]!.includes('galaxy'))
    process.env.RIVET_TOOL_PRESET='full' // Settings changes must not change this registry's frozen preset.
    assert.ok(agent.switchModel!('wirefixture:wire-next'))
    start=captured.length;await agent.run('继续只读观察，不调用工具。',callbacks)
    assert.ok(captured[start]!.includes('galaxy'),JSON.stringify(captured[start]))
    assert.equal(captured[start]!.length,27)
    assert.equal(agent.getToolSurface!().preset,'minimal')
    assert.equal(agent.enableTool!('galaxy').status,'already-active')
    config.agent.toolGating.disabledTools = ['galaxy']
    assert.ok(agent.switchModel!('wirefixture:wire-main'))
    start=captured.length;await agent.run('新限制下继续只读。',callbacks)
    assert.equal(captured[start]!.length,26);assert.ok(!captured[start]!.includes('galaxy'))
    assert.equal(agent.enableTool!('galaxy').status,'disabled')
  }finally{await agent.shutdown?.()}
})

test('real managed orchestration request exposes exactly the intended advanced tools', async () => {
  process.env.RIVET_TOOL_PRESET='orchestration';__resetToolPresetForTest()
  const config=structuredClone(DEFAULT_CONFIG);config.agent.defaultDomain='qiming';config.agent.verificationSnapshot='off';config.agent.maxTurns=1;config.provider={default:'wirefixture',providers:{wirefixture:provider}}
  const agent=buildManagedAgent({config,provider,model:provider.models[0]!,apiKey:'fixture',configured:true},home,'managed-orchestration',undefined,'manual')
  try { const index=captured.length;await agent.run('仅回答只读观察已完成。',callbacks);assert.equal(captured[index]!.length,30);for(const name of ['galaxy','starflow','plan_task','council_convene'])assert.ok(captured[index]!.includes(name));assert.ok(!captured[index]!.includes('attack_case')) }
  finally { await agent.shutdown?.() }
})

test('in-flight model requests cannot be rewritten by explicit mounting', async () => {
  process.env.RIVET_TOOL_PRESET='minimal';__resetToolPresetForTest()
  const config=structuredClone(DEFAULT_CONFIG);config.agent.verificationSnapshot='off';config.agent.maxTurns=1;config.provider={default:'wirefixture',providers:{wirefixture:provider}}
  const agent=buildManagedAgent({config,provider,model:provider.models[0]!,apiKey:'fixture',configured:true},home,'managed-busy',undefined,'manual')
  let entered!:()=>void,release!:()=>void
  const started=new Promise<void>(resolve=>{entered=resolve}), wait=new Promise<void>(resolve=>{release=resolve})
  hold={entered,wait}
  try {
    const run=agent.run('等待本次只读观察。',callbacks);await started
    assert.equal(agent.enableTool!('starflow').status,'busy')
    assert.ok(!agent.getToolSurface!().tools.some(tool=>tool.name==='starflow'&&tool.state==='visible'))
    release();hold=undefined;await run
    assert.equal(agent.enableTool!('starflow').status,'mounted')
  } finally { release();hold=undefined;await agent.shutdown?.() }
})

test('trusted before-model runtime hooks can still mount the existing GUI capability at a safe boundary', async () => {
  process.env.RIVET_TOOL_PRESET='minimal';process.env.RIVET_COMPUTER_USE_AUTOMOUNT='1';__resetToolPresetForTest()
  const config=structuredClone(DEFAULT_CONFIG);config.agent.verificationSnapshot='off';config.agent.maxTurns=1;config.provider={default:'wirefixture',providers:{wirefixture:provider}}
  const agent=buildManagedAgent({config,provider,model:provider.models[0]!,apiKey:'fixture',configured:true},home,'managed-gui-boundary',undefined,'manual')
  try {
    agent.registerExternalTools!([{definition:{name:'computer_use',description:'Fixture GUI definition; never executed',input_schema:{type:'object',properties:{}}},isEnabled:()=>true,isConcurrencySafe:()=>false,requiresApproval:()=>true,execute:async()=>{throw Error('GUI execution is outside this test')}}])
    const index=captured.length;await agent.run('请打开 Chrome 查看网页，只作观察。',callbacks)
    assert.ok(captured[index]!.includes('computer_use'));assert.equal(captured[index]!.length,27)
    assert.ok(!captured[index]!.includes('galaxy'))
  } finally { await agent.shutdown?.() }
})
