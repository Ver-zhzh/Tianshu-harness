import React, { useState } from 'react'
import type { ComponentMaterial, FrontendLanguage } from '../types/index.js'

interface PaletteProps {
  language: FrontendLanguage
  onInsertSnippet: (snippet: string) => void
}

const MATERIALS: ComponentMaterial[] = [
  // 布局
  {
    id: 'flex-col',
    category: 'layout',
    name: '弹性列容器 (Flex Column)',
    icon: '↕️',
    description: '垂直方向流式排列的 Flex 布局容器',
    snippet: `<div class="flex flex-col gap-4 p-4 border border-slate-700/60 rounded-xl bg-slate-800/40">\n  <div class="text-sm font-medium text-slate-300">子元素 1</div>\n  <div class="text-sm font-medium text-slate-300">子元素 2</div>\n</div>`,
  },
  {
    id: 'flex-row',
    category: 'layout',
    name: '弹性行容器 (Flex Row)',
    icon: '↔️',
    description: '水平排布、居中对齐的 Flex 容器',
    snippet: `<div class="flex items-center justify-between gap-4 p-4 border border-slate-700/60 rounded-xl bg-slate-800/40">\n  <span class="text-sm text-slate-200">左侧标题</span>\n  <button class="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white">操作</button>\n</div>`,
  },
  {
    id: 'grid-3',
    category: 'layout',
    name: '三列网格 (Grid 3-Col)',
    icon: '⊞',
    description: '自适应三列等宽网格布局',
    snippet: `<div class="grid grid-cols-1 md:grid-cols-3 gap-6">\n  <div class="p-5 rounded-xl border border-slate-700/60 bg-slate-800/50">卡片 1</div>\n  <div class="p-5 rounded-xl border border-slate-700/60 bg-slate-800/50">卡片 2</div>\n  <div class="p-5 rounded-xl border border-slate-700/60 bg-slate-800/50">卡片 3</div>\n</div>`,
  },
  {
    id: 'card',
    category: 'layout',
    name: '毛玻璃卡片 (Glass Card)',
    icon: '🎴',
    description: '现代深色质感卡片带柔和阴影',
    snippet: `<div class="p-6 rounded-2xl border border-slate-700/60 bg-slate-800/60 backdrop-blur-md shadow-xl">\n  <h3 class="text-lg font-semibold text-white mb-2">卡片标题</h3>\n  <p class="text-sm text-slate-400 leading-relaxed mb-4">这里是卡片详细正文说明文字。</p>\n  <button class="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-500">查看详情</button>\n</div>`,
  },

  // 基础
  {
    id: 'hero-title',
    category: 'basic',
    name: '大标题 (Hero Heading)',
    icon: '🔤',
    description: '渐变主视觉大标题',
    snippet: `<h1 class="text-4xl md:text-5xl font-extrabold tracking-tight bg-gradient-to-r from-blue-400 via-indigo-300 to-purple-400 bg-clip-text text-transparent">\n  天枢极速前端创造\n</h1>`,
  },
  {
    id: 'badge',
    category: 'basic',
    name: '状态徽章 (Status Badge)',
    icon: '🏷️',
    description: '带微光边框的状态标签',
    snippet: `<span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">\n  <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>\n  运行就绪\n</span>`,
  },
  {
    id: 'button-primary',
    category: 'basic',
    name: '主要按钮 (Primary Button)',
    icon: '🔘',
    description: '蓝调高亮交互按钮',
    snippet: `<button class="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl font-medium text-sm text-white bg-blue-600 hover:bg-blue-500 active:scale-95 transition shadow-lg shadow-blue-500/25">\n  立即开始\n</button>`,
  },

  // 表单
  {
    id: 'input-text',
    category: 'form',
    name: '文本输入框 (Text Input)',
    icon: '📝',
    description: '标准输入框带对焦光晕',
    snippet: `<div class="space-y-1.5">\n  <label class="block text-xs font-medium text-slate-400">用户名</label>\n  <input type="text" placeholder="请输入..." class="w-full px-3.5 py-2 rounded-xl border border-slate-700 bg-slate-900/80 text-sm text-white placeholder-slate-500 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 focus:outline-none transition" />\n</div>`,
  },
  {
    id: 'toggle-switch',
    category: 'form',
    name: '切换开关 (Toggle Switch)',
    icon: '🎚️',
    description: 'iOS 风格平滑切换开关',
    snippet: `<label class="inline-flex items-center gap-3 cursor-pointer select-none">\n  <input type="checkbox" class="sr-only peer" checked />\n  <div class="relative w-11 h-6 bg-slate-700 rounded-full peer peer-checked:bg-blue-600 after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full"></div>\n  <span class="text-sm font-medium text-slate-300">开启实时预览</span>\n</label>`,
  },

  // 业务区块
  {
    id: 'navbar',
    category: 'sections',
    name: '导航栏 (Top Navbar)',
    icon: '🧭',
    description: '响应式顶部导航与品牌栏',
    snippet: `<nav class="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/80 backdrop-blur-md">\n  <div class="flex items-center gap-2 font-bold text-white tracking-wide">\n    <span class="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center text-xs">TS</span>\n    天枢 IDE\n  </div>\n  <div class="flex items-center gap-6 text-sm text-slate-300">\n    <a href="#" class="hover:text-white transition">首页</a>\n    <a href="#" class="hover:text-white transition">特性</a>\n    <a href="#" class="hover:text-white transition">文档</a>\n  </div>\n  <button class="px-4 py-1.5 rounded-lg bg-blue-600 text-xs font-semibold text-white hover:bg-blue-500">登录</button>\n</nav>`,
  },
  {
    id: 'stats-kpi',
    category: 'sections',
    name: '指标统计卡 (Stat KPI)',
    icon: '📊',
    description: '数据统计展示与涨跌标识',
    snippet: `<div class="p-6 rounded-2xl border border-slate-800 bg-slate-900/60 shadow-lg">\n  <div class="text-xs font-medium text-slate-400">活跃用户数</div>\n  <div class="mt-2 flex items-baseline gap-2">\n    <span class="text-3xl font-bold text-white tracking-tight">128,490</span>\n    <span class="text-xs font-semibold text-emerald-400">↑ 14.8%</span>\n  </div>\n</div>`,
  },
]

export const Palette: React.FC<PaletteProps> = ({ language, onInsertSnippet }) => {
  const [activeTab, setActiveTab] = useState<'all' | 'layout' | 'basic' | 'form' | 'sections'>('all')
  const [search, setSearch] = useState('')

  const filtered = MATERIALS.filter((m) => {
    if (activeTab !== 'all' && m.category !== activeTab) return false
    if (search && !m.name.toLowerCase().includes(search.toLowerCase()) && !m.description.toLowerCase().includes(search.toLowerCase())) {
      return false
    }
    return true
  })

  // 根据语言微调 snippet (例如 JSX 的 class -> className)
  const formatSnippetForLang = (snippet: string) => {
    if (language === 'react-tsx' || language === 'react-jsx') {
      return snippet.replace(/class=/g, 'className=')
    }
    return snippet
  }

  return (
    <div className="flex flex-col h-full border-r border-slate-800 bg-slate-900/90 w-72 select-none">
      {/* 标题与搜索 */}
      <div className="p-3 border-b border-slate-800 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-slate-300 tracking-wider uppercase">组件物料库</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-mono">
            {MATERIALS.length} 个物料
          </span>
        </div>
        <input
          type="text"
          placeholder="搜索组件物料..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full px-2.5 py-1.5 rounded-lg border border-slate-800 bg-slate-950/80 text-xs text-slate-200 placeholder-slate-500 focus:border-blue-500 focus:outline-none"
        />
      </div>

      {/* 分类过滤 Tab */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-slate-800/80 overflow-x-auto text-[11px]">
        {(['all', 'layout', 'basic', 'form', 'sections'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-2 py-1 rounded-md font-medium whitespace-nowrap transition ${
              activeTab === tab
                ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
            }`}
          >
            {tab === 'all' && '全部'}
            {tab === 'layout' && '布局'}
            {tab === 'basic' && '基础'}
            {tab === 'form' && '表单'}
            {tab === 'sections' && '区块'}
          </button>
        ))}
      </div>

      {/* 物料卡片列表 */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
        {filtered.map((item) => (
          <div
            key={item.id}
            onClick={() => onInsertSnippet(formatSnippetForLang(item.snippet))}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('text/plain', formatSnippetForLang(item.snippet))
            }}
            className="group relative p-2.5 rounded-xl border border-slate-800 bg-slate-950/40 hover:bg-slate-800/60 hover:border-blue-500/40 transition cursor-pointer"
          >
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm">{item.icon}</span>
              <span className="text-xs font-semibold text-slate-200 group-hover:text-blue-400 transition">
                {item.name}
              </span>
            </div>
            <p className="text-[11px] text-slate-400 leading-snug line-clamp-2">{item.description}</p>
            <div className="mt-2 flex items-center justify-end">
              <span className="text-[10px] text-blue-400 opacity-0 group-hover:opacity-100 transition flex items-center gap-1 font-medium">
                点击插入 ↵
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
