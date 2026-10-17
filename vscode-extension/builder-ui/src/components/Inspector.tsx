import React, { useState, useEffect } from 'react'
import type { SelectedElement } from '../types/index.js'

interface InspectorProps {
  selectedElement: SelectedElement | null
  onUpdateElement: (newClasses: string, newText: string) => void
  onRevealLine?: (line: number) => void
  onAskAgentForElement?: (element: SelectedElement, prompt: string) => void
}

export const Inspector: React.FC<InspectorProps> = ({
  selectedElement,
  onUpdateElement,
  onRevealLine,
  onAskAgentForElement,
}) => {
  const [classes, setClasses] = useState('')
  const [textContent, setTextContent] = useState('')
  const [agentPrompt, setAgentPrompt] = useState('')
  const [showAgentBox, setShowAgentBox] = useState(false)

  useEffect(() => {
    if (selectedElement) {
      setClasses(selectedElement.className || '')
      setTextContent(selectedElement.textContent || '')
      setShowAgentBox(false)
      setAgentPrompt('')
    }
  }, [selectedElement])

  if (!selectedElement) {
    return (
      <div className="flex flex-col items-center justify-center h-full border-l border-slate-800 bg-slate-900/90 w-80 p-6 text-center select-none text-slate-500">
        <div className="w-10 h-10 rounded-full bg-slate-800/80 flex items-center justify-center text-slate-400 mb-3">
          <span className="text-lg">🎯</span>
        </div>
        <div className="text-xs font-semibold text-slate-300 mb-1">未选中任何元素</div>
        <div className="text-[11px] leading-relaxed text-slate-400">
          在画布中点击任一页面元素，即可在此实时修改样式、排版或呼叫天枢 Agent 改造。
        </div>
      </div>
    )
  }

  const toggleClass = (cls: string, groupPrefix?: string) => {
    const classList = classes.split(/\s+/).filter(Boolean)
    let nextList: string[] = []

    if (groupPrefix) {
      // 互斥替换，例如换 flex-col 会先去掉 flex-row
      nextList = classList.filter((c) => !c.startsWith(groupPrefix))
      if (!classList.includes(cls)) {
        nextList.push(cls)
      }
    } else {
      if (classList.includes(cls)) {
        nextList = classList.filter((c) => c !== cls)
      } else {
        nextList = [...classList, cls]
      }
    }

    const nextClasses = nextList.join(' ')
    setClasses(nextClasses)
    onUpdateElement(nextClasses, textContent)
  }

  const handleClassesCommit = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      onUpdateElement(classes, textContent)
    }
  }

  const handleTextCommit = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      onUpdateElement(classes, textContent)
    }
  }

  const handleApply = () => {
    onUpdateElement(classes, textContent)
  }

  return (
    <div className="flex flex-col h-full border-l border-slate-800 bg-slate-900/95 w-80 select-none overflow-y-auto">
      {/* 头部：当前选中元素 */}
      <div className="p-3 border-b border-slate-800 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 font-mono text-xs font-bold text-blue-400">
            <span>&lt;{selectedElement.tagName}&gt;</span>
            {selectedElement.id && <span className="text-purple-400">#{selectedElement.id}</span>}
          </div>
          <button
            onClick={() => setShowAgentBox(!showAgentBox)}
            className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-indigo-600/20 text-indigo-300 border border-indigo-500/30 text-[11px] font-medium hover:bg-indigo-600/30 transition"
          >
            <span>🤖</span> 呼叫天枢
          </button>
        </div>

        {/* 呼叫天枢 Agent 浮层 */}
        {showAgentBox && (
          <div className="p-2.5 rounded-xl border border-indigo-500/40 bg-indigo-950/40 space-y-2 mt-2">
            <div className="text-[11px] font-semibold text-indigo-200">
              对 &lt;{selectedElement.tagName}&gt; 组件提出改造要求：
            </div>
            <textarea
              placeholder="例如：改为暗黑霓虹风卡片、添加响应式网格、加微动效..."
              value={agentPrompt}
              onChange={(e) => setAgentPrompt(e.target.value)}
              className="w-full h-16 p-2 rounded-lg border border-indigo-500/30 bg-slate-950 text-xs text-white placeholder-slate-500 focus:outline-none"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowAgentBox(false)}
                className="px-2 py-1 text-[11px] text-slate-400 hover:text-slate-200"
              >
                取消
              </button>
              <button
                onClick={() => {
                  if (agentPrompt.trim() && onAskAgentForElement) {
                    onAskAgentForElement(selectedElement, agentPrompt)
                    setShowAgentBox(false)
                  }
                }}
                className="px-3 py-1 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-semibold transition"
              >
                立即发送
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="p-3 space-y-4 text-xs">
        {/* 文本内容修改 */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-slate-400 text-[11px] font-medium">
            <span>文字内容 (Text Content)</span>
            <span className="text-[10px] text-slate-500">Ctrl+Enter 提交</span>
          </div>
          <textarea
            value={textContent}
            onChange={(e) => setTextContent(e.target.value)}
            onKeyDown={handleTextCommit}
            onBlur={handleApply}
            rows={2}
            className="w-full px-2.5 py-1.5 rounded-lg border border-slate-800 bg-slate-950 text-xs text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none"
          />
        </div>

        {/* 样式 Classes */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-slate-400 text-[11px] font-medium">
            <span>类名 (Tailwind / CSS Classes)</span>
            <span className="text-[10px] text-slate-500">Enter 提交</span>
          </div>
          <input
            type="text"
            value={classes}
            onChange={(e) => setClasses(e.target.value)}
            onKeyDown={handleClassesCommit}
            onBlur={handleApply}
            className="w-full px-2.5 py-1.5 rounded-lg border border-slate-800 bg-slate-950 text-xs text-slate-100 focus:border-blue-500 focus:outline-none font-mono"
          />
        </div>

        {/* 可视化快速排版控制器 */}
        <div className="space-y-3 pt-2 border-t border-slate-800/80">
          <div className="text-[11px] font-bold text-slate-300 uppercase tracking-wider">快捷样式面板</div>

          {/* 布局排布 */}
          <div className="space-y-1.5">
            <div className="text-[11px] text-slate-400 font-medium">排版方向 (Flex Direction)</div>
            <div className="grid grid-cols-2 gap-1.5">
              {[
                { label: '水平 (Row)', cls: 'flex flex-row', prefix: 'flex-' },
                { label: '垂直 (Col)', cls: 'flex flex-col', prefix: 'flex-' },
              ].map((opt) => (
                <button
                  key={opt.cls}
                  onClick={() => toggleClass(opt.cls, opt.prefix)}
                  className={`px-2 py-1 rounded-md text-[11px] font-medium transition ${
                    classes.includes(opt.cls)
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-800/80 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* 间距 Gap */}
          <div className="space-y-1.5">
            <div className="text-[11px] text-slate-400 font-medium">间距 (Gap)</div>
            <div className="grid grid-cols-4 gap-1">
              {['gap-2', 'gap-4', 'gap-6', 'gap-8'].map((g) => (
                <button
                  key={g}
                  onClick={() => toggleClass(g, 'gap-')}
                  className={`px-1.5 py-1 rounded text-[10px] font-mono transition ${
                    classes.includes(g)
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-800/80 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  {g}
                </button>
              ))}
            </div>
          </div>

          {/* 内边距 Padding */}
          <div className="space-y-1.5">
            <div className="text-[11px] text-slate-400 font-medium">内边距 (Padding)</div>
            <div className="grid grid-cols-4 gap-1">
              {['p-2', 'p-4', 'p-6', 'p-8'].map((p) => (
                <button
                  key={p}
                  onClick={() => toggleClass(p, 'p-')}
                  className={`px-1.5 py-1 rounded text-[10px] font-mono transition ${
                    classes.includes(p)
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-800/80 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          {/* 圆角 Rounded */}
          <div className="space-y-1.5">
            <div className="text-[11px] text-slate-400 font-medium">圆角 (Border Radius)</div>
            <div className="grid grid-cols-4 gap-1">
              {[
                { label: '无', cls: 'rounded-none' },
                { label: 'MD', cls: 'rounded-md' },
                { label: 'XL', cls: 'rounded-2xl' },
                { label: '胶囊', cls: 'rounded-full' },
              ].map((r) => (
                <button
                  key={r.cls}
                  onClick={() => toggleClass(r.cls, 'rounded-')}
                  className={`px-1.5 py-1 rounded text-[10px] transition ${
                    classes.includes(r.cls)
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-800/80 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>

          {/* 阴影与边框 */}
          <div className="space-y-1.5">
            <div className="text-[11px] text-slate-400 font-medium">质感 (Surface)</div>
            <div className="grid grid-cols-2 gap-1.5">
              {[
                { label: '边框 (Border)', cls: 'border border-slate-700' },
                { label: '高阴影 (Shadow)', cls: 'shadow-xl' },
              ].map((s) => (
                <button
                  key={s.cls}
                  onClick={() => toggleClass(s.cls)}
                  className={`px-2 py-1 rounded-md text-[11px] font-medium transition ${
                    classes.includes(s.cls)
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-800/80 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* 底部保存按钮 */}
        <div className="pt-2">
          <button
            onClick={handleApply}
            className="w-full py-2 rounded-xl bg-blue-600 hover:bg-blue-500 font-medium text-white text-xs transition shadow-lg shadow-blue-500/20"
          >
            应用到源文件 (Save)
          </button>
        </div>
      </div>
    </div>
  )
}
