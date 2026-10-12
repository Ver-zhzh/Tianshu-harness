import React, { useState } from 'react'
import type { ConsoleLog } from '../types/index.js'

interface ConsoleDrawerProps {
  logs: ConsoleLog[]
  isOpen: boolean
  onClose: () => void
  onClear: () => void
}

export const ConsoleDrawer: React.FC<ConsoleDrawerProps> = ({ logs, isOpen, onClose, onClear }) => {
  const [filter, setFilter] = useState<'all' | 'error' | 'warn' | 'log'>('all')

  if (!isOpen) return null

  const filteredLogs = logs.filter((l) => (filter === 'all' ? true : l.level === filter))

  return (
    <div className="flex flex-col h-48 border-t border-slate-800 bg-slate-950/95 font-mono text-xs select-none">
      {/* 栏目头 */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-800 bg-slate-900/80">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-slate-300">沙箱控制台与异常追踪</span>
          <div className="flex items-center gap-1 text-[11px]">
            {(['all', 'error', 'warn', 'log'] as const).map((lvl) => (
              <button
                key={lvl}
                onClick={() => setFilter(lvl)}
                className={`px-1.5 py-0.5 rounded uppercase text-[10px] font-bold transition ${
                  filter === lvl ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {lvl}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onClear}
            className="px-2 py-0.5 rounded text-[11px] text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition"
          >
            清空
          </button>
          <button
            onClick={onClose}
            className="px-1.5 py-0.5 rounded text-[11px] text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition"
          >
            ✕
          </button>
        </div>
      </div>

      {/* 日志内容滚动列表 */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1 font-mono text-[11px]">
        {filteredLogs.length === 0 ? (
          <div className="text-slate-600 italic p-2">控制台无消息记录</div>
        ) : (
          filteredLogs.map((log) => {
            let color = 'text-slate-300'
            let bg = 'bg-transparent'
            if (log.level === 'error') {
              color = 'text-red-400 font-bold'
              bg = 'bg-red-950/20'
            } else if (log.level === 'warn') {
              color = 'text-yellow-400'
              bg = 'bg-yellow-950/20'
            } else if (log.level === 'info') {
              color = 'text-blue-400'
            }

            return (
              <div key={log.id} className={`flex items-start gap-2 px-1.5 py-0.5 rounded ${bg}`}>
                <span className="text-slate-600 shrink-0">
                  {new Date(log.timestamp).toLocaleTimeString()}
                </span>
                <span className={`shrink-0 uppercase font-bold text-[9px] px-1 rounded ${
                  log.level === 'error' ? 'bg-red-500/20 text-red-400' :
                  log.level === 'warn' ? 'bg-yellow-500/20 text-yellow-400' : 'bg-slate-800 text-slate-400'
                }`}>
                  {log.level}
                </span>
                <span className={`break-all ${color}`}>{log.message}</span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
