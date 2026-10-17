import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createGotoDefinitionTool, createFindReferencesTool, registerLspTools } from '../tools.js'
import type { LspManager } from '../manager.js'
import type { Tool, ToolCallParams } from '../../tools/types.js'

function makeParams(input: Record<string, unknown>): ToolCallParams {
  return { input, toolUseId: 'tu_1', cwd: '/project' }
}

describe('createGotoDefinitionTool', () => {
  it('has correct tool definition', () => {
    const mgr: LspManager = {
      initialize: async () => {},
      isReady: () => true,
      supportsDefinition: () => true,
      supportsReferences: () => false,
      gotoDefinition: async () => [],
      findReferences: async () => [],
      changeFile: () => {},
      getFileDiagnostics: async () => [],
      dispose: () => {},
    }

    const tool = createGotoDefinitionTool(mgr)
    assert.equal(tool.definition.name, 'lsp_goto_definition')
    // 描述中文化：断言语义锚点而非英文原文
    assert.ok(tool.definition.description!.includes('定义'))
    assert.ok(tool.definition.input_schema)
    assert.equal(tool.definition.input_schema!.required!.length, 3)
    assert.ok(tool.definition.input_schema!.required!.includes('file_path'))
    assert.ok(tool.definition.input_schema!.required!.includes('line'))
    assert.ok(tool.definition.input_schema!.required!.includes('column'))
    assert.ok(tool.isEnabled())
    assert.equal(tool.requiresApproval(makeParams({})), false)
    assert.equal(tool.isConcurrencySafe(), true)
  })

  it('存在性不随进程状态波动：isEnabled 恒 true；未就绪在 execute 报错', async () => {
    // 2026-10-16（issue #500 配套修复）：存在性由注册决定（registerLspTools 仅在
    // ready + 能力支持时注册）；「就绪」判定在 execute——工具不再随 LSP 进程
    // 状态从 wire 表出现/消失（工具表波动会触发 continuation 守卫拒发）。
    const mgr: LspManager = {
      initialize: async () => {},
      isReady: () => false,
      supportsDefinition: () => true,
      supportsReferences: () => false,
      gotoDefinition: async () => [],
      findReferences: async () => [],
      changeFile: () => {},
      getFileDiagnostics: async () => [],
      dispose: () => {},
    }

    const tool = createGotoDefinitionTool(mgr)
    assert.equal(tool.isEnabled(), true, '注册后存在性稳定——不随 LSP 进程状态从 wire 表消失')
    const result = await tool.execute(makeParams({ file_path: 'a.ts', line: 1, column: 0 }))
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('未就绪'))
  })

  it('returns definition location', async () => {
    const mgr: LspManager = {
      initialize: async () => {},
      isReady: () => true,
      supportsDefinition: () => true,
      supportsReferences: () => false,
      gotoDefinition: async (file, line, col) => {
        assert.equal(file, 'src/foo.ts')
        assert.equal(line, 10)
        assert.equal(col, 5)
        return [{
          uri: 'src/bar.ts',
          range: { start: { line: 5, character: 3 }, end: { line: 5, character: 10 } },
        }]
      },
      findReferences: async () => [],
      changeFile: () => {},
      getFileDiagnostics: async () => [],
      dispose: () => {},
    }

    const tool = createGotoDefinitionTool(mgr)
    const result = await tool.execute(makeParams({ file_path: 'src/foo.ts', line: 10, column: 5 }))

    assert.ok(result.content.includes('src/bar.ts'))
    assert.ok(result.content.includes(':6:')) // display uses 1-based line: 5 → 6
    assert.ok(result.content.includes(':3')) // column unchanged
    assert.equal(result.isError, undefined)
  })

  it('handles empty result gracefully', async () => {
    const mgr: LspManager = {
      initialize: async () => {},
      isReady: () => true,
      supportsDefinition: () => true,
      supportsReferences: () => false,
      gotoDefinition: async () => [],
      findReferences: async () => [],
      changeFile: () => {},
      getFileDiagnostics: async () => [],
      dispose: () => {},
    }

    const tool = createGotoDefinitionTool(mgr)
    const result = await tool.execute(makeParams({ file_path: 'src/nonexistent.ts', line: 1, column: 1 }))

    assert.ok(result.content.includes('No definition found'))
  })

  it('returns error for missing file_path parameter', async () => {
    const mgr: LspManager = {
      initialize: async () => {},
      isReady: () => true,
      supportsDefinition: () => true,
      supportsReferences: () => false,
      gotoDefinition: async () => [],
      findReferences: async () => [],
      changeFile: () => {},
      getFileDiagnostics: async () => [],
      dispose: () => {},
    }

    const tool = createGotoDefinitionTool(mgr)
    const result = await tool.execute(makeParams({ line: 1, column: 1 }))

    assert.equal(result.isError, true)
    assert.ok(result.content.includes('file_path'))
  })
})

describe('createFindReferencesTool', () => {
  it('returns reference list', async () => {
    const mgr: LspManager = {
      initialize: async () => {},
      isReady: () => true,
      supportsDefinition: () => false,
      supportsReferences: () => true,
      gotoDefinition: async () => [],
      findReferences: async () => [
        { uri: 'src/a.ts', range: { start: { line: 5, character: 3 }, end: { line: 5, character: 9 } } },
        { uri: 'src/b.ts', range: { start: { line: 12, character: 1 }, end: { line: 12, character: 7 } } },
      ],
      changeFile: () => {},
      getFileDiagnostics: async () => [],
      dispose: () => {},
    }

    const tool = createFindReferencesTool(mgr)
    const result = await tool.execute(makeParams({ file_path: 'src/foo.ts', line: 10, column: 5 }))

    assert.ok(result.content.includes('2 reference(s)'))
    assert.ok(result.content.includes('src/a.ts'))
    assert.ok(result.content.includes('src/b.ts'))
    assert.ok(result.content.includes(':6:')) // 5 → 1-based: 6
    assert.ok(result.content.includes(':13:')) // 12 → 1-based: 13
    assert.equal(result.isError, undefined)
  })

  it('handles empty result', async () => {
    const mgr: LspManager = {
      initialize: async () => {},
      isReady: () => true,
      supportsDefinition: () => false,
      supportsReferences: () => true,
      gotoDefinition: async () => [],
      findReferences: async () => [],
      changeFile: () => {},
      getFileDiagnostics: async () => [],
      dispose: () => {},
    }

    const tool = createFindReferencesTool(mgr)
    const result = await tool.execute(makeParams({ file_path: 'src/foo.ts', line: 1, column: 1 }))

    assert.ok(result.content.includes('No references found'))
  })

  it('存在性不随进程状态波动：isEnabled 恒 true；未就绪在 execute 报错', async () => {
    const mgr: LspManager = {
      initialize: async () => {},
      isReady: () => false,
      supportsDefinition: () => false,
      supportsReferences: () => true,
      gotoDefinition: async () => [],
      findReferences: async () => [],
      changeFile: () => {},
      getFileDiagnostics: async () => [],
      dispose: () => {},
    }

    const tool = createFindReferencesTool(mgr)
    assert.equal(tool.isEnabled(), true)
    const result = await tool.execute(makeParams({ file_path: 'a.ts', line: 1, column: 0 }))
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('未就绪'))
  })
})

describe('registerLspTools（注册决定存在性 / 能力过滤）', () => {
  function mkMgr(over: Partial<LspManager> = {}): LspManager {
    return {
      initialize: async () => {},
      isReady: () => true,
      supportsDefinition: () => true,
      supportsReferences: () => true,
      gotoDefinition: async () => [],
      findReferences: async () => [],
      changeFile: () => {},
      getFileDiagnostics: async () => [],
      dispose: () => {},
      ...over,
    }
  }

  function collector(): { names: string[]; registry: { register(tool: Tool): void } } {
    const names: string[] = []
    return { names, registry: { register: (tool: Tool) => { names.push(tool.definition.name) } } }
  }

  it('ready 且能力支持时注册两个工具', () => {
    const { names, registry } = collector()
    registerLspTools(mkMgr(), registry)
    assert.deepEqual(names.sort(), ['lsp_find_references', 'lsp_goto_definition'])
  })

  it('未就绪不注册（存在性由注册决定）', () => {
    const { names, registry } = collector()
    registerLspTools(mkMgr({ isReady: () => false }), registry)
    assert.deepEqual(names, [])
  })

  it('按能力过滤：不支持 definition 的服务器不注册 goto 工具', () => {
    const { names, registry } = collector()
    registerLspTools(mkMgr({ supportsDefinition: () => false }), registry)
    assert.deepEqual(names, ['lsp_find_references'])
  })

  it('按能力过滤：不支持 references 的服务器不注册 find 工具', () => {
    const { names, registry } = collector()
    registerLspTools(mkMgr({ supportsReferences: () => false }), registry)
    assert.deepEqual(names, ['lsp_goto_definition'])
  })
})
