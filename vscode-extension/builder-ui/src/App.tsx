import React, { useState, useEffect, useRef, useCallback } from 'react'
import type {
  BuilderMode,
  ConsoleLog,
  FrontendLanguage,
  SelectedElement,
  ViewportMode,
} from './types/index.js'
import { onHostMessage, sendToHost } from './bridge.js'
import { transpileToHtml } from './compiler/transpiler.js'
import { Toolbar } from './components/Toolbar.js'
import { Palette } from './components/Palette.js'
import { Inspector } from './components/Inspector.js'
import { ConsoleDrawer } from './components/ConsoleDrawer.js'

export const App: React.FC = () => {
  const [fileName, setFileName] = useState<string>('')
  const [filePath, setFilePath] = useState<string>('')
  const [language, setLanguage] = useState<FrontendLanguage>('html')
  const [sourceCode, setSourceCode] = useState<string>('')

  const [compiledHtml, setCompiledHtml] = useState<string>('')
  const [compileDurationMs, setCompileDurationMs] = useState<number>(0)
  const [builderMode, setBuilderMode] = useState<BuilderMode>('builder')
  const [viewportMode, setViewportMode] = useState<ViewportMode>('responsive')

  const [selectedElement, setSelectedElement] = useState<SelectedElement | null>(null)
  const [logs, setLogs] = useState<ConsoleLog[]>([])
  const [isConsoleOpen, setIsConsoleOpen] = useState<boolean>(false)
  const [showAgentModal, setShowAgentModal] = useState<boolean>(false)
  const [agentGlobalPrompt, setAgentGlobalPrompt] = useState<string>('')

  const iframeRef = useRef<HTMLIFrameElement>(null)

  // 执行即时转译
  const runCompile = useCallback((code: string, lang: FrontendLanguage) => {
    const start = performance.now()
    try {
      const html = transpileToHtml(code, lang)
      const duration = Math.round(performance.now() - start)
      setCompiledHtml(html)
      setCompileDurationMs(duration)
    } catch (err) {
      const msg = (err as Error).message
      setLogs((prev) => [
        ...prev,
        {
          id: Math.random().toString(36).slice(2),
          level: 'error',
          message: `编译异常: ${msg}`,
          timestamp: Date.now(),
        },
      ])
    }
  }, [])

  // 监听来自扩展宿主的消息
  useEffect(() => {
    const dispose = onHostMessage((msg) => {
      switch (msg.type) {
        case 'initFile':
          setFileName(msg.payload.fileName)
          setFilePath(msg.payload.filePath)
          setLanguage(msg.payload.language)
          setSourceCode(msg.payload.content)
          runCompile(msg.payload.content, msg.payload.language)
          break

        case 'fileContentUpdate':
          setSourceCode(msg.content)
          runCompile(msg.content, language)
          break

        case 'noFileLoaded':
          setFileName('未载入前端文件')
          setLanguage('html')
          setSourceCode('')
          runCompile('', 'html')
          break
      }
    })

    // 通知宿主：Webview 已挂载
    sendToHost({ type: 'ready' })
    return () => dispose()
  }, [language, runCompile])

  // 监听沙箱内部（iframe）通过 postMessage 发回的事件
  useEffect(() => {
    const handleSandboxMessage = (event: MessageEvent) => {
      const data = event.data
      if (!data || typeof data !== 'object') return

      if (data.type === 'sandboxElementSelected') {
        setSelectedElement({
          tagName: data.tagName,
          className: data.className,
          id: data.id,
          textContent: data.textContent,
          attributes: data.attributes || {},
          rect: data.rect,
        })
      } else if (data.type === 'sandboxConsole') {
        setLogs((prev) => [
          ...prev.slice(-100),
          {
            id: Math.random().toString(36).slice(2),
            level: data.level,
            message: data.message,
            timestamp: data.timestamp || Date.now(),
          },
        ])
      }
    }

    window.addEventListener('message', handleSandboxMessage)
    return () => window.removeEventListener('message', handleSandboxMessage)
  }, [])

  // 模式切换时通知沙箱
  const handleModeChange = (mode: BuilderMode) => {
    setBuilderMode(mode)
    if (iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage({ type: 'setMode', mode }, '*')
    }
  }

  // 从物料库插入代码片段（双向回写源文件）
  const handleInsertSnippet = (snippet: string) => {
    let nextCode = sourceCode
    if (!nextCode.trim()) {
      nextCode = snippet
    } else {
      // 智能插入：若是 HTML，尝试插入到 </body> 之前
      if (language === 'html' && /<\/body>/i.test(nextCode)) {
        nextCode = nextCode.replace(/<\/body>/i, `  ${snippet}\n</body>`)
      } else if ((language === 'react-tsx' || language === 'react-jsx') && /<\/div>|<\/>/i.test(nextCode)) {
        const lastIdx = Math.max(nextCode.lastIndexOf('</div>'), nextCode.lastIndexOf('</>'))
        if (lastIdx !== -1) {
          nextCode = nextCode.slice(0, lastIdx) + `  ${snippet}\n  ` + nextCode.slice(lastIdx)
        } else {
          nextCode += `\n${snippet}`
        }
      } else if (language === 'vue' && /<\/template>/i.test(nextCode)) {
        nextCode = nextCode.replace(/<\/template>/i, `  ${snippet}\n</template>`)
      } else {
        nextCode += `\n${snippet}`
      }
    }

    setSourceCode(nextCode)
    runCompile(nextCode, language)
    sendToHost({ type: 'updateCode', content: nextCode, path: filePath })
  }

  // 属性面板修改元素（双向回写源文件）
  const handleUpdateElement = (newClasses: string, newText: string) => {
    if (!selectedElement) return

    let nextCode = sourceCode
    const oldClass = selectedElement.className

    // 精准替换 class/className
    if (oldClass) {
      if (nextCode.includes(`class="${oldClass}"`)) {
        nextCode = nextCode.replace(`class="${oldClass}"`, `class="${newClasses}"`)
      } else if (nextCode.includes(`className="${oldClass}"`)) {
        nextCode = nextCode.replace(`className="${oldClass}"`, `className="${newClasses}"`)
      }
    }

    // 更新状态并写回
    setSelectedElement({
      ...selectedElement,
      className: newClasses,
      textContent: newText,
    })
    setSourceCode(nextCode)
    runCompile(nextCode, language)
    sendToHost({ type: 'updateCode', content: nextCode, path: filePath })
  }

  // 针对特定组件呼叫天枢 Agent
  const handleAskAgentForElement = (el: SelectedElement, prompt: string) => {
    sendToHost({
      type: 'askAgent',
      prompt,
      componentName: el.tagName,
      codeSnippet: `<${el.tagName} class="${el.className}">${el.textContent}</${el.tagName}>`,
    })
  }

  // 全局呼叫天枢 Agent
  const handleGlobalAskAgentSubmit = () => {
    if (!agentGlobalPrompt.trim()) return
    sendToHost({
      type: 'askAgent',
      prompt: agentGlobalPrompt,
      codeSnippet: sourceCode,
    })
    setShowAgentModal(false)
    setAgentGlobalPrompt('')
  }

  // 计算视口宽度约束
  const getViewportWidthStyle = () => {
    switch (viewportMode) {
      case 'mobile':
        return 'w-[375px]'
      case 'tablet':
        return 'w-[768px]'
      case 'desktop':
      case 'responsive':
      default:
        return 'w-full'
    }
  }

  const hasError = logs.some((l) => l.level === 'error')

  return (
    <div className="flex flex-col w-full h-full bg-slate-950 text-slate-100 overflow-hidden font-sans">
      {/* 顶部控制栏 */}
      <Toolbar
        fileName={fileName}
        language={language}
        builderMode={builderMode}
        viewportMode={viewportMode}
        compileDurationMs={compileDurationMs}
        hasError={hasError}
        logCount={logs.length}
        isConsoleOpen={isConsoleOpen}
        onToggleConsole={() => setIsConsoleOpen(!isConsoleOpen)}
        onChangeBuilderMode={handleModeChange}
        onChangeViewportMode={setViewportMode}
        onPickFile={() => sendToHost({ type: 'pickWorkspaceFile' })}
        onRefresh={() => runCompile(sourceCode, language)}
        onQuickAskAgent={() => setShowAgentModal(true)}
      />

      {/* 主工作区 */}
      <div className="flex flex-1 w-full overflow-hidden">
        {/* 左侧：物料库抽屉（仅建造模式显示） */}
        {builderMode === 'builder' && (
          <Palette language={language} onInsertSnippet={handleInsertSnippet} />
        )}

        {/* 中间：画布沙箱与设备视口外框 */}
        <div className="flex-1 flex flex-col items-center justify-center bg-slate-950/60 p-4 overflow-auto">
          <div
            className={`h-full transition-all duration-200 flex flex-col rounded-xl overflow-hidden shadow-2xl border border-slate-800 bg-slate-900 ${getViewportWidthStyle()}`}
          >
            {/* 视口模拟器顶部把手（在移动或平板视口下更逼真） */}
            {viewportMode !== 'responsive' && (
              <div className="flex items-center justify-between px-3 py-1 bg-slate-800 border-b border-slate-700/60 text-[10px] text-slate-400 select-none">
                <span className="font-mono">
                  {viewportMode === 'mobile' ? 'iPhone 15 (375 × 812)' : 'iPad Mini (768 × 1024)'}
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-500"></span>
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-500"></span>
                </span>
              </div>
            )}

            {/* 真实实时渲染沙箱 iframe */}
            <iframe
              ref={iframeRef}
              title="Tianshu Live Preview"
              srcDoc={compiledHtml}
              sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
              className="w-full flex-1 border-0 bg-slate-900"
            />
          </div>
        </div>

        {/* 右侧：属性面板（仅建造模式显示） */}
        {builderMode === 'builder' && (
          <Inspector
            selectedElement={selectedElement}
            onUpdateElement={handleUpdateElement}
            onAskAgentForElement={handleAskAgentForElement}
          />
        )}
      </div>

      {/* 底部：控制台抽屉 */}
      <ConsoleDrawer
        logs={logs}
        isOpen={isConsoleOpen}
        onClose={() => setIsConsoleOpen(false)}
        onClear={() => setLogs([])}
      />

      {/* 全局呼叫天枢 Agent 弹窗 */}
      {showAgentModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg p-5 rounded-2xl border border-indigo-500/40 bg-slate-900 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-bold text-sm text-indigo-300">
                <span>🤖</span>
                <span>天枢 AI Agent 页面改造指令</span>
              </div>
              <button
                onClick={() => setShowAgentModal(false)}
                className="text-slate-400 hover:text-slate-200"
              >
                ✕
              </button>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              指令将直接注入当前天枢内核会话，Agent 将根据您的自然语言要求智能重构当前页面，并在本窗口实时流式呈现。
            </p>
            <textarea
              placeholder="例如：将当前页面改造成现代 SaaS 登录注册页，包含渐变背景、第三方快捷登录与响应式适配..."
              value={agentGlobalPrompt}
              onChange={(e) => setAgentGlobalPrompt(e.target.value)}
              rows={4}
              className="w-full p-3 rounded-xl border border-slate-700 bg-slate-950 text-xs text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={() => setShowAgentModal(false)}
                className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
              >
                取消
              </button>
              <button
                onClick={handleGlobalAskAgentSubmit}
                className="px-4 py-1.5 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white font-semibold text-xs shadow-lg shadow-indigo-500/25 transition"
              >
                开始生成
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
