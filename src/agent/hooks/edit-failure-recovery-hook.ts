import type { PostToolRuntimeHook, RuntimeHookContext, RuntimeToolEvent } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'
import { renderRouteAnnotation, STALL_ROUTE_TABLE } from '../failure-taxonomy.js'
import { extractPatchTargetPaths } from '../../tools/apply-patch.js'
import { resolve } from 'node:path'

/** edit-failure 的恢复路由标注——统一从 STALL_ROUTE_TABLE 取值，单源不漂移。 */
const EDIT_FAILURE_ANNOTATION = renderRouteAnnotation(STALL_ROUTE_TABLE['edit-stuck'])

/**
 * Edit-Failure Recovery Hook — postTool detection of consecutive edit failures
 * on the same file across turns.
 *
 * When edit_file / hash_edit / write_file / ast_edit / apply_patch fails ≥2
 * times on the same file, the agent's mental model is almost certainly stale.
 * Instead of retrying the same edit pattern (which leads to debris and undo
 * loops), we inject a repair advisory that tells the agent to:
 * read the actual target and use version-bound edits or a captured transaction.
 * Structural mutation facts use the persistent file-repair route instead;
 * format errors and safe refusals do not increase this fallback counter.
 *
 * apply_patch 的恢复方向相反：它的失败（hunk 计数错 / 上下文漂移 / 目标不在
 * 索引）靠重发同一补丁永远修不好，建议退回 edit_file/hash_edit 单点编辑。
 *
 * The failure counter is session-scoped and reset on success for that file.
 */

export interface EditFailureRecoveryHookDeps {
  advisoryBus: Pick<AdvisoryBus, 'submit'>
}

const EDIT_TOOLS = new Set(['edit_file', 'hash_edit', 'write_file', 'ast_edit', 'apply_patch'])

export function createEditFailureRecoveryHook(deps: EditFailureRecoveryHookDeps): PostToolRuntimeHook {
  const failCounts = new Map<string, number>()
  const notified = new Set<string>()

  return {
    phase: 'postTool',
    name: 'edit-failure-recovery',
    run(_ctx: RuntimeHookContext, tool: RuntimeToolEvent): void {
      if (!EDIT_TOOLS.has(tool.name)) return
      // Structured mutation facts already drive the persistent file-repair advice.
      if (tool.mutations?.length || tool.failureClass === 'format_error' || tool.failureClass === 'refused') return

      const filePath = extractFilePath(tool)
      if (!filePath) return

      if (tool.success) {
        failCounts.delete(filePath)
        notified.delete(filePath)
        return
      }

      const count = (failCounts.get(filePath) ?? 0) + 1
      failCounts.set(filePath, count)

      if (count >= 2 && !notified.has(filePath)) {
        notified.add(filePath)
        const isPatch = tool.name === 'apply_patch'
        deps.advisoryBus.submit({
          key: `edit-failure-recovery:${filePath}`,
          priority: 0.62,
          category: 'repair',
          tier: 'operational',
          content: isPatch
            ? `已连续 ${count} 次用 apply_patch 修改 ${filePath} 失败。读取当前目标内容，核对 diff 的 hunk 行数和上下文；改用绑定版本的 edit_file.operations 或内容锚点编辑；不要原样重发补丁，不做无捕获的整文件恢复。 ${EDIT_FAILURE_ANNOTATION}`
            : `已连续 ${count} 次编辑 ${filePath} 失败。读取目标当前内容，使用绑定 expected_version 的 edit_file.operations、内容锚点编辑或前台 bash.write_files 事务；仅可恢复本次精确捕获，缺少捕获或发生冲突时保留现场和备份。 ${EDIT_FAILURE_ANNOTATION}`,
          ttl: 1,
          expect: {
            kind: 'tool_appears',
            tools: isPatch
              ? ['read_file', 'edit_file', 'hash_edit', 'write_file']
              : ['read_file', 'edit_file', 'hash_edit', 'bash'],
            targetIncludes: filePath,
            recoveryTarget: resolve(_ctx.snapshot.cwd, filePath),
            withinTurns: 2,
          },
        })
      }
    },
  }
}

function extractFilePath(tool: RuntimeToolEvent): string | undefined {
  if (tool.name === 'apply_patch') {
    // apply_patch 没有 file_path 字段——目标文件埋在 diff 的 +++ 头里。
    const diff = typeof tool.input?.diff === 'string' ? tool.input.diff : undefined
    if (!diff) return undefined
    const targets = extractPatchTargetPaths(diff)
    return targets.length > 0 ? targets.join(',') : undefined
  }
  if (typeof tool.input?.file_path === 'string') return tool.input.file_path
  if (typeof tool.input?.path === 'string') return tool.input.path
  return tool.target
}
