/** Restore original behavior in memory only; shared checkout files are never rewritten. */
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { registerHooks, createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
const root = resolve(import.meta.dirname, '..')
const require = createRequire(root + '/package.json')
const { transformSync } = require('esbuild')
const cases = [
  ['public recovery absent', 'src/prompt/static.ts', 'main request', s => s.replace(/  <rule name="obstacle-recovery">[\s\S]*?  <\/rule>\n\n/, '')],
  ['isolated green mistaken for external pollution', 'src/prompt/static.ts', 'static attribution', s => s.replace('隔离单文件绿而全量红，只是定位范围的线索，不能推出外部污染', '隔离单文件绿而全量红 ⇒ 外部阻塞/污染')],
  ['coverage failure licenses a raw commit', 'src/prompt/static.ts', 'static attribution', s => s.replace('仅使用运行时实际支持的 scoped 提交，仍须满足所选文件的覆盖、版本和所有权检查。', '门能跑但被影响面覆盖义务卡死时，在仓库根做显式点名文件的 scoped commit。')],
  ['Taiyi main domain loses bounded followthrough', 'src/agent/star-domain-data.ts', 'taiyi main request', s => s.replace('缺少平台或凭据只暂停对应步骤，其余可做的继续。', '缺少平台或凭据就等待用户。')],
  ['Yaoguang main domain loses environment recovery', 'src/agent/star-domain-data.ts', 'yaoguang main request', s => s.replace('遇阻先确认最小环境和实际入口，执行一个能区分假设的动作。', '')],
  ['Yaoguang worker treats reproduction failure as completion', 'src/agent/star-domain-data.ts', 'Yaoguang worker', s => s.replace(/用户目标只是判断能否复现时，[\s\S]*?归族发现的结构性缺陷记录在案/, '复现成功或失败都是结论——失败的复现同样回答了问题；归族发现的结构性缺陷记录在案')],
  ['diagnosis exonerates code without evidence', 'src/agent/hooks/error-diagnosis-hook.ts', 'missing_dep delivery', s => s.replace('使用已安装入口继续，确需安装时遵守授权边界。', '这不是代码问题。')],
  ['readback wording promises an unaccounted action', 'src/agent/hooks/self-verify-hook.ts', 'self-verify promises', s => s.replace(/content: '【瑶光】最近几步没有独立验证中的测试或类型检查记录。[^\n]+/, "content: '【瑶光】最近几步你基于读取/编辑给出了结论，但没有独立验证（未运行测试或类型检查）。在继续推进之前，请先确认该结论有 ground truth 支撑——跑测试/读原文/用原输入自检，而非信任摘要或自己的判断。',")],
]
if (process.env.OBSTACLE_RESTORED_DEFECT !== undefined) {
  const entry = cases[Number(process.env.OBSTACLE_RESTORED_DEFECT)]
  if (!entry) throw new Error('Unknown restored defect')
  registerHooks({ load(url, ctx, next) {
    if (!url.startsWith('file:') || fileURLToPath(url) !== join(root, entry[1])) return next(url, ctx)
    const source = readFileSync(new URL(url), 'utf8')
    const restored = entry[3](source)
    assert.notEqual(restored, source, 'restoration anchor missing')
    return { shortCircuit: true, format: 'module', source: transformSync(restored, { loader: 'ts', format: 'esm', target: 'esnext' }).code }
  } })
} else {
  const home = mkdtempSync(join(tmpdir(), 'tianshu-obstacle-mutation-'))
  for (const [i, [name, , pattern]] of cases.entries()) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--import', import.meta.filename, '--test', '--test-name-pattern=' + pattern, 'src/agent/__tests__/obstacle-recovery-contract.test.ts'], {
      cwd: root, env: { ...process.env, RIVET_HOME: home, RIVET_SESSION_DIR: join(home, 'sessions'), OBSTACLE_RESTORED_DEFECT: String(i) }, encoding: 'utf8', timeout: 30_000, windowsHide: true,
    })
    const output = result.stdout + result.stderr
    assert.ok(result.status === 1 && output.includes('AssertionError') && !output.includes('restoration anchor missing'), `${name}: expected assertion RED\n${output.slice(-2500)}`)
    console.log('ASSERTION RED: ' + name)
  }
  console.log(cases.length + ' restored defects caught; checkout untouched')
}
