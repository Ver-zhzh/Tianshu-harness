import React from 'react'
import type { BuilderMode, FrontendLanguage, ViewportMode } from '../types/index.js'

interface ToolbarProps {
  fileName: string
  language: FrontendLanguage
  builderMode: BuilderMode
  viewportMode: ViewportMode
  compileDurationMs: number
  hasError: boolean
  logCount: number
  isConsoleOpen: boolean
  onToggleConsole: () => void
  onChangeBuilderMode: (mode: BuilderMode) => void
  onChangeViewportMode: (mode: ViewportMode) => void
  onPickFile: () => void
  onRefresh: () => void
  onQuickAskAgent: () => void
}

export const Toolbar: React.FC<ToolbarProps> = ({
  fileName,
  language,
  builderMode,
  viewportMode,
  compileDurationMs,
  hasError,
  logCount,
  isConsoleOpen,
  onToggleConsole,
  onChangeBuilderMode,
  onChangeViewportMode,
  onPickFile,
  onRefresh,
  onQuickAskAgent,
}) => {
  const getLanguagePill = (lang: FrontendLanguage) => {
    switch (lang) {
      case 'html':
        return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-orange-500/20 text-orange-400 border border-orange-500/30">HTML5</span>
      case 'react-tsx':
      case 'react-jsx':
        return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-cyan-500/20 text-cyan-400 border border-cyan-500/30">React 18</span>
      case 'vue':
        return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">Vue 3 SFC</span>
      case 'svelte':
        return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/20 text-rose-400 border border-rose-500/30">Svelte</span>
      case 'css':
        return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-blue-500/20 text-blue-400 border border-blue-500/30">CSS</span>
      default:
        return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-800 text-slate-400">Web</span>
    }
  }

  return (
    <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800 bg-slate-900/95 select-none text-xs">
      {/* 左侧：文件信息与语言 */}
      <div className="flex items-center gap-2">
        <button
          onClick={onPickFile}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-800/80 hover:bg-slate-700/80 text-slate-200 transition font-medium"
          title="点击切换工作区中的前端文件"
        >
          <span>📁</span>
          <span className="font-mono max-w-[140px] truncate">{fileName || '未选文件'}</span>
          <span className="text-[10px] text-slate-400">▾</span>
        </button>
        {getLanguagePill(language)}
        <div className="flex items-center gap-1 text-[11px] text-slate-400">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
          <span>{compileDurationMs}ms</span>
        </div>
      </div>

      {/* 中间：视口与模式切换 */}
      <div className="flex items-center gap-2">
        {/* 建造模式 / 纯净预览 */}
        <div className="flex items-center p-0.5 rounded-lg bg-slate-950 border border-slate-800">
          <button
            onClick={() => onChangeBuilderMode('builder')}
            className={`px-2.5 py-1 rounded-md font-medium text-[11px] transition ${
              builderMode === 'builder'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            🎨 可视化建造
          </button>
          <button
            onClick={() => onChangeBuilderMode('preview')}
            className={`px-2.5 py-1 rounded-md font-medium text-[11px] transition ${
              builderMode === 'preview'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            👁️ 实时预览
          </button>
        </div>

        {/* 视口尺寸选择 */}
        <div className="flex items-center p-0.5 rounded-lg bg-slate-950 border border-slate-800 text-[11px]">
          {(
            [
              { mode: 'responsive', label: '🖥️ 桌面', tip: '自适应 100%' },
              { mode: 'tablet', label: '📱 平板', tip: '768px' },
              { mode: 'mobile', label: '📱 手机', tip: '375px' },
            ] as const
          ).map((vp) => (
            <button
              key={vp.mode}
              onClick={() => onChangeViewportMode(vp.mode)}
              title={vp.tip}
              className={`px-2 py-1 rounded-md font-medium transition ${
                viewportMode === vp.mode
                  ? 'bg-slate-800 text-blue-400'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {vp.label}
            </button>
          ))}
        </div>
      </div>

      {/* 右侧：天枢 Agent / 刷新 / 控制台 */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={onQuickAskAgent}
          className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white font-medium shadow-md shadow-indigo-500/20 transition"
        >
          <span>✨</span>
          <span>呼叫天枢 Agent</span>
        </button>

        <button
          onClick={onRefresh}
          title="强制重新转译并刷新沙箱"
          className="p-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700/80 text-slate-300 transition"
        >
          🔄
        </button>

        <button
          onClick={onToggleConsole}
          className={`flex items-center gap-1 px-2 py-1 rounded-lg font-mono text-[11px] transition ${
            hasError
              ? 'bg-red-500/20 text-red-400 border border-red-500/40 animate-pulse'
              : isConsoleOpen
              ? 'bg-slate-800 text-blue-400'
              : 'bg-slate-800/80 text-slate-400 hover:text-slate-200'
          }`}
        >
          <span>终端</span>
          {logCount > 0 && <span className="px-1 rounded bg-slate-700/80 text-[10px]">{logCount}</span>}
        </button>
      </div>
    </div>
  )
}
