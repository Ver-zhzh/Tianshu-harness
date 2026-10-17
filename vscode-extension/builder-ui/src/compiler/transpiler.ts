import type { FrontendLanguage } from '../types/index.js'

/**
 * 沙箱内部注入脚本：
 * 1. 拦截悬停与点击事件，用于可视化建造器选择元素
 * 2. 捕获 console 与运行时错误回传给主 IDE 窗口
 * 3. 动态接收来自主窗口的高亮指令
 */
const SANDBOX_RUNTIME_INSPECTOR = `
(function() {
  let isBuilderMode = true;
  let activeSelectedEl = null;

  // 错误捕获
  window.addEventListener('error', function(e) {
    window.parent.postMessage({
      type: 'sandboxConsole',
      level: 'error',
      message: (e.message || '未知脚本错误') + (e.filename ? ' (' + e.filename + ':' + e.lineno + ')' : ''),
      timestamp: Date.now()
    }, '*');
  });

  window.addEventListener('unhandledrejection', function(e) {
    window.parent.postMessage({
      type: 'sandboxConsole',
      level: 'error',
      message: 'Unhandled Promise: ' + String(e.reason),
      timestamp: Date.now()
    }, '*');
  });

  // 控制台日志代理
  ['log', 'info', 'warn', 'error'].forEach(function(level) {
    const orig = console[level];
    console[level] = function(...args) {
      orig.apply(console, args);
      try {
        const text = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        window.parent.postMessage({
          type: 'sandboxConsole',
          level: level,
          message: text,
          timestamp: Date.now()
        }, '*');
      } catch(err) {}
    };
  });

  // 高亮框元素
  const hoverOverlay = document.createElement('div');
  hoverOverlay.style.position = 'fixed';
  hoverOverlay.style.pointerEvents = 'none';
  hoverOverlay.style.border = '2px dashed #3b82f6';
  hoverOverlay.style.backgroundColor = 'rgba(59, 130, 246, 0.12)';
  hoverOverlay.style.zIndex = '999998';
  hoverOverlay.style.display = 'none';
  hoverOverlay.style.transition = 'all 0.08s ease-out';
  document.documentElement.appendChild(hoverOverlay);

  const selectedOverlay = document.createElement('div');
  selectedOverlay.style.position = 'fixed';
  selectedOverlay.style.pointerEvents = 'none';
  selectedOverlay.style.border = '2px solid #2563eb';
  selectedOverlay.style.backgroundColor = 'rgba(37, 99, 235, 0.18)';
  selectedOverlay.style.zIndex = '999999';
  selectedOverlay.style.display = 'none';
  document.documentElement.appendChild(selectedOverlay);

  const tagBadge = document.createElement('div');
  tagBadge.style.position = 'absolute';
  tagBadge.style.top = '-22px';
  tagBadge.style.left = '0';
  tagBadge.style.backgroundColor = '#2563eb';
  tagBadge.style.color = '#ffffff';
  tagBadge.style.fontSize = '11px';
  tagBadge.style.fontWeight = '600';
  tagBadge.style.padding = '2px 6px';
  tagBadge.style.borderRadius = '3px';
  tagBadge.style.whiteSpace = 'nowrap';
  selectedOverlay.appendChild(tagBadge);

  function updateOverlay(overlay, el) {
    if (!el) {
      overlay.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.top = r.top + 'px';
    overlay.style.left = r.left + 'px';
    overlay.style.width = r.width + 'px';
    overlay.style.height = r.height + 'px';
  }

  window.addEventListener('mouseover', function(e) {
    if (!isBuilderMode) return;
    const target = e.target;
    if (target === hoverOverlay || target === selectedOverlay || target === document.documentElement || target === document.body) return;
    updateOverlay(hoverOverlay, target);
  }, true);

  window.addEventListener('mouseout', function() {
    if (!isBuilderMode) return;
    hoverOverlay.style.display = 'none';
  }, true);

  window.addEventListener('click', function(e) {
    if (!isBuilderMode) return;
    const target = e.target;
    if (target === hoverOverlay || target === selectedOverlay) return;
    e.preventDefault();
    e.stopPropagation();

    activeSelectedEl = target;
    updateOverlay(selectedOverlay, target);
    tagBadge.textContent = target.tagName.toLowerCase() + (target.className ? '.' + String(target.className).trim().split(/\\s+/)[0] : '');

    const attrs = {};
    for (let i = 0; i < target.attributes.length; i++) {
      const a = target.attributes[i];
      attrs[a.name] = a.value;
    }

    const rect = target.getBoundingClientRect();
    window.parent.postMessage({
      type: 'sandboxElementSelected',
      tagName: target.tagName.toLowerCase(),
      className: target.className || '',
      id: target.id || '',
      textContent: target.textContent || '',
      attributes: attrs,
      rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
    }, '*');
  }, true);

  // 接收主窗口消息（如切换建造/预览模式、更新属性）
  window.addEventListener('message', function(ev) {
    const d = ev.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'setMode') {
      isBuilderMode = d.mode === 'builder';
      if (!isBuilderMode) {
        hoverOverlay.style.display = 'none';
        selectedOverlay.style.display = 'none';
      }
    }
  });

  window.addEventListener('scroll', function() {
    if (activeSelectedEl) updateOverlay(selectedOverlay, activeSelectedEl);
  }, true);
})();
`

/**
 * 将任意语言前端源码即时转换为可被 iframe 直接呈现的完整 HTML 网页
 */
export function transpileToHtml(source: string, language: FrontendLanguage): string {
  switch (language) {
    case 'html':
      return transpileHtml(source)
    case 'react-tsx':
    case 'react-jsx':
      return transpileReact(source)
    case 'vue':
      return transpileVue(source)
    case 'svelte':
      return transpileSvelte(source)
    case 'css':
      return transpileCss(source)
    default:
      return transpileHtml(source)
  }
}

function transpileHtml(html: string): string {
  const trimmed = html.trim()
  if (!trimmed) {
    return createEmptyTemplate('HTML 页面为空，请开始编写或从左侧物料拖入组件')
  }

  let finalHtml = trimmed
  // 如果不是完整 HTML 文档，包裹标准骨架
  if (!/<html[\s>]/i.test(finalHtml)) {
    finalHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 text-slate-100 min-h-screen p-6 font-sans">
  ${finalHtml}
</body>
</html>`
  } else {
    // 确保注入了 tailwind
    if (!/tailwindcss/i.test(finalHtml)) {
      finalHtml = finalHtml.replace(/<head>/i, '<head>\n  <script src="https://cdn.tailwindcss.com"></script>')
    }
  }

  // 注入调试与建造器探针
  finalHtml = finalHtml.replace(/<\/body>/i, `<script>${SANDBOX_RUNTIME_INSPECTOR}</script>\n</body>`)
  return finalHtml
}

function transpileReact(code: string): string {
  const trimmed = code.trim()
  if (!trimmed) {
    return createEmptyTemplate('React 组件为空，请编写组件或导入物料')
  }

  // 轻量代码预处理：
  // 1. 移除 import 语句
  const cleanCode = code
    .replace(/^import\s+.*?from\s+['"].*?['"];?/gm, '')
    .replace(/^import\s+['"].*?['"];?/gm, '')
    .replace(/export\s+default\s+/g, 'window.__DefaultComponent = ')
    .replace(/export\s+(const|function|class)\s+(\w+)/g, '$1 $2; window.$2 = $2;')

  // 提取可能的根组件名
  const componentMatch = cleanCode.match(/function\s+([A-Z]\w+)/) || cleanCode.match(/const\s+([A-Z]\w+)\s*=/)
  const inferredRoot = componentMatch ? componentMatch[1] : 'App'

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="https://cdn.tailwindcss.com"></script>
  <!-- React 18 & Babel Standalone 运行时 -->
  <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
</head>
<body class="bg-slate-900 text-slate-100 min-h-screen font-sans">
  <div id="root"></div>

  <script type="text/babel">
    try {
      const { useState, useEffect, useRef, useMemo, useCallback } = React;
      ${cleanCode}

      const TargetRoot = window.__DefaultComponent || (typeof ${inferredRoot} !== 'undefined' ? ${inferredRoot} : null);
      if (TargetRoot) {
        const root = ReactDOM.createRoot(document.getElementById('root'));
        root.render(React.createElement(TargetRoot));
      } else {
        document.getElementById('root').innerHTML = '<div class="p-6 text-yellow-400">未检测到导出的 React 组件或函数名首字母未大写</div>';
      }
    } catch(err) {
      console.error('React 运行时渲染错误:', err);
      document.getElementById('root').innerHTML = '<div class="p-6 text-red-400 font-mono text-sm bg-red-950/40 rounded-lg border border-red-800 m-4"><div class="font-bold mb-2">React 渲染异常:</div>' + err.message + '</div>';
    }
  </script>
  <script>${SANDBOX_RUNTIME_INSPECTOR}</script>
</body>
</html>`
}

function transpileVue(code: string): string {
  const trimmed = code.trim()
  if (!trimmed) {
    return createEmptyTemplate('Vue 3 组件为空，请编写 template 或导入物料')
  }

  // 解构 template, script, style
  const templateMatch = trimmed.match(/<template>([\s\S]*?)<\/template>/i)
  const scriptMatch = trimmed.match(/<script[\s\S]*?>([\s\S]*?)<\/script>/i)
  const styleMatch = trimmed.match(/<style[\s\S]*?>([\s\S]*?)<\/style>/i)

  const templateHtml = templateMatch ? templateMatch[1] : trimmed
  const scriptCode = scriptMatch ? scriptMatch[1] : ''
  const styles = styleMatch ? styleMatch[1] : ''

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://unpkg.com/vue@3/dist/vue.global.js"></script>
  <style>${styles}</style>
</head>
<body class="bg-slate-900 text-slate-100 min-h-screen font-sans">
  <div id="app">
    ${templateHtml}
  </div>

  <script>
    try {
      const { createApp, ref, reactive, computed, onMounted } = Vue;
      const componentOptions = (function() {
        ${scriptCode.replace(/export\s+default\s+/g, 'return ')}
        return {};
      })();

      const app = createApp({
        ...componentOptions,
      });
      app.mount('#app');
    } catch(err) {
      console.error('Vue 3 运行时异常:', err);
      document.getElementById('app').innerHTML = '<div class="p-6 text-red-400 font-mono text-sm bg-red-950/40 rounded-lg border border-red-800 m-4"><div class="font-bold mb-2">Vue 3 渲染异常:</div>' + err.message + '</div>';
    }
  </script>
  <script>${SANDBOX_RUNTIME_INSPECTOR}</script>
</body>
</html>`
}

function transpileSvelte(code: string): string {
  const trimmed = code.trim()
  if (!trimmed) {
    return createEmptyTemplate('Svelte 组件为空，请编写组件或导入物料')
  }

  // 提取 Svelte 标签，做响应式模拟渲染
  const scriptMatch = trimmed.match(/<script[\s\S]*?>([\s\S]*?)<\/script>/i)
  const styleMatch = trimmed.match(/<style[\s\S]*?>([\s\S]*?)<\/style>/i)
  let template = trimmed
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, '')

  // 替换 Svelte 常见语法糖如 {expression} 预览
  template = template.replace(/\{#if\s+.*?\}/g, '').replace(/\{\/if\}/g, '').replace(/\{#each\s+.*?\}/g, '').replace(/\{\/each\}/g, '')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="https://cdn.tailwindcss.com"></script>
  <style>${styleMatch ? styleMatch[1] : ''}</style>
</head>
<body class="bg-slate-900 text-slate-100 min-h-screen font-sans p-6">
  <div id="svelte-root">
    ${template}
  </div>
  <script>${SANDBOX_RUNTIME_INSPECTOR}</script>
</body>
</html>`
}

function transpileCss(css: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="https://cdn.tailwindcss.com"></script>
  <style>${css}</style>
</head>
<body class="bg-slate-900 text-slate-100 min-h-screen font-sans p-8">
  <div class="max-w-2xl mx-auto space-y-6">
    <h2 class="text-xl font-bold border-b border-slate-700 pb-2">CSS 样式预览展台</h2>
    <div class="p-6 rounded-xl border border-slate-700 bg-slate-800/80 shadow-lg space-y-4">
      <div class="preview-target">这里是匹配所选样式的预览容器</div>
      <p class="text-sm text-slate-400">在编辑器中修改 CSS 类选择器或样式规则，本预览实时生效。</p>
    </div>
  </div>
  <script>${SANDBOX_RUNTIME_INSPECTOR}</script>
</body>
</html>`
}

function createEmptyTemplate(hint: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 text-slate-400 min-h-screen flex items-center justify-center p-6 text-center font-sans">
  <div class="max-w-md p-8 border border-slate-800 rounded-2xl bg-slate-950/60 shadow-2xl">
    <div class="w-12 h-12 mx-auto mb-4 rounded-full bg-blue-500/10 flex items-center justify-center text-blue-400">
      <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg>
    </div>
    <div class="text-slate-200 font-semibold mb-2">画布就绪</div>
    <div class="text-sm text-slate-400">${hint}</div>
  </div>
  <script>${SANDBOX_RUNTIME_INSPECTOR}</script>
</body>
</html>`
}
