import { LongWorld, sha } from './recovery-long-world.js'
import { HookWorld } from './scoped-hook-world.js'
import { FILES, referenceFix } from './recovery-long-fixture.js'
import { GOAL as SYNTHETIC_GOAL } from './recovery-long-policy.js'
import { GOAL as HOOK_GOAL } from './scoped-hook-task.js'
import { verdict } from './experiment-protocol.js'
import type { RetrievalTask } from './retrieval-policy.js'

const ALIAS_FILES = {
  'README.md': '# Request budgets\nprofile=short aliases interactive. A configured idle budget of zero disables the idle timeout. Diagnose the actual implementation without editing files.\n',
  'package.json': '{"type":"module","private":true}',
  'src/config.mjs': `const aliases={short:'interactive',batch:'background'};
const defaults={interactive:250,background:1500};
export function budget(profile,env={}){return Number(env.TASK_IDLE_MS)||defaults[aliases[profile]??profile];}
`,
  'src/public.mjs': "export {budget as timeoutFor} from './config.mjs';\n",
  'src/client.mjs': "import {timeoutFor} from './public.mjs';\nexport function requestOptions(env){return {idleMs:timeoutFor('short',env)};}\n",
  'test/smoke.test.mjs': "import {test} from 'node:test';import assert from 'node:assert/strict';import {requestOptions} from '../src/client.mjs';test('default idle budget',()=>assert.equal(requestOptions({}).idleMs,250));\n",
  'scripts/reproduce.mjs': "import {requestOptions} from '../src/client.mjs';console.log(JSON.stringify({actual:requestOptions({TASK_IDLE_MS:'0'})}));\n",
}
export const ALIAS_GOAL = `只读诊断：调用 requestOptions({TASK_IDLE_MS:'0'}) 后 idleMs 是什么？文档说零禁用超时，实际是否遵守？定位真实实现及调用方，解释别名路径与失败原因，区分代码行为和环境限制。不要修改任何文件，也不要为了满足实现型提示而写测试或补丁。可以使用 grep/read_file/list_files/run_checks，原 smoke 和观察脚本均可执行。最终回复一个 JSON 对象（可置于代码块）：actualMs、zeroDisables（实际是否禁用）、implementationFiles（实现与直接调用方的两个仓库相对路径）、environmentBlocked（这次诊断是否被环境阻断）、explanation。不要在 JSON 外追加文本。`

export class ReadonlyAliasWorld extends LongWorld {
  constructor() { super(ALIAS_FILES, [], false, "import {requestOptions} from '../src/client.mjs';console.log(JSON.stringify(requestOptions({TASK_IDLE_MS:'0'})));\n"); this.capabilities.writableRoots = [] }
  gradeReport(final: string) {
    let report: any
    try { report = JSON.parse(final.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')) } catch { /* report missing or not machine readable */ }
    const results = [
      verdict('actual-value', report ? report.actualMs === 250 : null, { actualMs: report?.actualMs }),
      verdict('zero-contract', report ? report.zeroDisables === false : null, { zeroDisables: report?.zeroDisables }),
      verdict('consumer-and-implementation', report ? Array.isArray(report.implementationFiles) && report.implementationFiles.every((p: unknown) => typeof p === 'string') && JSON.stringify([...new Set(report.implementationFiles)].sort()) === JSON.stringify(['src/client.mjs', 'src/config.mjs']) : null, { files: report?.implementationFiles }),
      verdict('environment-attribution', report ? report.environmentBlocked === false : null, { environmentBlocked: report?.environmentBlocked }),
      verdict('readonly-bytes', sha(this.hashes()) === sha(this.initialHashes), {}),
    ]
    return { passed: results.every(r => r.verdict === 'pass'), parsed: { results }, protectedUnchanged: sha(this.hashes()) === sha(this.initialHashes) }
  }
  override async grade() { return this.gradeReport('') }
}
export function retrievalTask(task: RetrievalTask, fixed = false): { world: LongWorld; goal: string } {
  if (task === 'readonly-alias') return { world: new ReadonlyAliasWorld(), goal: ALIAS_GOAL }
  if (task === 'synthetic') return { world: new LongWorld(fixed ? referenceFix(FILES) : FILES), goal: SYNTHETIC_GOAL }
  return { world: new HookWorld(fixed), goal: HOOK_GOAL }
}
export async function retrievalGrade(world: LongWorld, final: string) { return world instanceof ReadonlyAliasWorld ? world.gradeReport(final) : world.grade() }
