/** EXECUTED is an implementation marker; historical GREEN never proves quality. */
export function readPlanCompletionSummary(content: string, completion?: { summary: string; revision: 'current' | 'changed' | 'unknown' }): string | undefined {
  if (completion) return `${completion.summary}\n计划版本：${completion.revision === 'current' ? '与关闭回执一致；验证和审查独立登记' : completion.revision === 'changed' ? '已变化，验收证据需复核；未重启执行' : '未知，历史声明未逐项核实'}`
  const closure = content.slice(Math.max(0, content.lastIndexOf('## 7. Execution closure')))
  const facts = ['执行', '实际提交', '验证', '审查'].map(label => closure.match(new RegExp(`^${label}：[^\\n]+`, 'm'))?.[0])
  if (facts.every(Boolean)) return facts.join('\n')
  if (/Status:\s*EXECUTED/.test(content)) return '执行：completed（历史标记）\n实际提交：未知\n验证：未知（未关联回执）\n审查：未知（未关联记录）'
  return undefined
}
