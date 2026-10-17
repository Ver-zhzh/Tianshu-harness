import type { Tool, ToolCallParams, ToolResult } from '../tools/types.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { LspManager } from './manager.js'

function resolveParams(input: Record<string, unknown>): { filePath: string; line: number; column: number } | string {
  const filePath = input.file_path as string | undefined
  if (!filePath || typeof filePath !== 'string') return 'Missing required parameter: file_path'
  const line = input.line as number | undefined
  if (typeof line !== 'number' || line < 1) return 'Missing or invalid parameter: line (must be >= 1)'
  const column = input.column as number | undefined
  if (typeof column !== 'number' || column < 0) return 'Missing or invalid parameter: column (must be >= 0)'
  return { filePath, line, column }
}

export function createGotoDefinitionTool(manager: LspManager): Tool {
  return {
    definition: {
      name: 'lsp_goto_definition',
      description:
        '跳转到给定文件位置符号的定义。返回定义的文件路径、行号和列号。用于理解函数、类、变量或类型的定义位置。',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '包含该符号的源文件路径' },
          line: { type: 'number', description: '符号所在行号（从 1 开始）' },
          column: { type: 'number', description: '符号所在列号（从 0 开始）' },
        },
        required: ['file_path', 'line', 'column'],
      },
    },

    async execute(params: ToolCallParams): Promise<ToolResult> {
      // 就绪判定在执行期（2026-10-16，issue #500 配套修复）：存在性由注册决定
      // （registerLspTools 仅注册 ready 且能力支持的服务器），进程状态波动只影响
      // 单次调用结果，不改 wire 工具表。
      if (!manager.isReady()) {
        return { content: '语言服务器未就绪或已退出——lsp_goto_definition 当前不可用', isError: true }
      }

      const resolved = resolveParams(params.input)
      if (typeof resolved === 'string') {
        return { content: resolved, isError: true }
      }

      const locations = await manager.gotoDefinition(
        resolved.filePath,
        resolved.line,
        resolved.column,
      )

      if (locations.length === 0) {
        return {
          content: `No definition found for symbol at ${resolved.filePath}:${resolved.line}:${resolved.column}`,
        }
      }

      const formatted = locations.map(loc => {
        const displayLine = loc.range.start.line + 1
        const displayCol = loc.range.start.character
        return `${loc.uri}:${displayLine}:${displayCol}`
      }).join('\n')

      return {
        content: `${locations.length} definition(s) found:\n${formatted}`,
      }
    },

    requiresApproval(): boolean {
      return false
    },

    isConcurrencySafe(): boolean {
      return true
    },

    isEnabled(): boolean {
      // 存在性由注册决定——注册后不再随 LSP 进程状态从 wire 表消失（动态
      // isEnabled 曾参与 schema 期过滤、造成工具表波动；issue #500 配套修复）。
      return true
    },
  }
}

export function createFindReferencesTool(manager: LspManager): Tool {
  return {
    definition: {
      name: 'lsp_find_references',
      description:
        '查找给定文件位置符号的所有引用。返回符号被使用的文件路径、行号和列号列表。用于理解修改函数、类或变量的影响范围。',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '包含该符号的源文件路径' },
          line: { type: 'number', description: '符号所在行号（从 1 开始）' },
          column: { type: 'number', description: '符号所在列号（从 0 开始）' },
        },
        required: ['file_path', 'line', 'column'],
      },
    },

    async execute(params: ToolCallParams): Promise<ToolResult> {
      // 就绪判定在执行期——同 createGotoDefinitionTool（issue #500 配套修复）。
      if (!manager.isReady()) {
        return { content: '语言服务器未就绪或已退出——lsp_find_references 当前不可用', isError: true }
      }

      const resolved = resolveParams(params.input)
      if (typeof resolved === 'string') {
        return { content: resolved, isError: true }
      }

      const locations = await manager.findReferences(
        resolved.filePath,
        resolved.line,
        resolved.column,
      )

      if (locations.length === 0) {
        return {
          content: `No references found for symbol at ${resolved.filePath}:${resolved.line}:${resolved.column}`,
        }
      }

      const formatted = locations.map(loc => {
        const displayLine = loc.range.start.line + 1
        const displayCol = loc.range.start.character
        return `${loc.uri}:${displayLine}:${displayCol}`
      }).join('\n')

      return {
        content: `${locations.length} reference(s) found:\n${formatted}`,
      }
    },

    requiresApproval(): boolean {
      return false
    },

    isConcurrencySafe(): boolean {
      return true
    },

    isEnabled(): boolean {
      // 存在性由注册决定（同 createGotoDefinitionTool）。
      return true
    },
  }
}

/**
 * LSP 工具注册集（单点维护）——serve-agent.attachLspTools（桌面端晚到注册）与
 * bootstrap.initializeLsp（TUI 启动期注册）共用，防止两处注册集合漂移。
 *
 * 分工（2026-10-16，issue #500 配套修复）：
 *   - 存在性由注册决定：仅 ready 且能力支持的服务器进 wire 表（启动期探测，稳定）；
 *   - 可用性由执行期决定：进程状态波动在 execute 头部守卫给出可解释错误。
 * 此前 isEnabled 动态读 isReady/supports 参与 schema 期过滤，工具会随进程状态
 * 从 wire 表出现/消失——工具表波动会触发 continuation 守卫 fail-closed 拒发。
 */
export function registerLspTools(manager: LspManager, registry: Pick<ToolRegistry, 'register'>): void {
  if (!manager.isReady()) return
  if (manager.supportsDefinition()) registry.register(createGotoDefinitionTool(manager))
  if (manager.supportsReferences()) registry.register(createFindReferencesTool(manager))
}
