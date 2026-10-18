// 双 bundle：扩展宿主（node/cjs）+ webview 座舱（browser/iife）。
import esbuild from 'esbuild'
import { readFileSync } from 'node:fs'

// RUNTIME_VERSION 必须对齐「内核」版本（根 package.json / Release tag runtime-v<ver>），
// 不是扩展自身版本——runtime 产物名与下载路径都按内核版本生成。公开仓/私有仓
// 构建时扩展都在仓库子目录，../package.json 恒可读；读不到时 fail-fast。
const rootPkg = JSON.parse(readFileSync('../package.json', 'utf-8'))
if (!rootPkg.version) throw new Error('esbuild: 根 package.json 缺 version，无法注入 RUNTIME_VERSION')
const watch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const extensionCfg = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
  define: { RUNTIME_VERSION: JSON.stringify(rootPkg.version) },
}

/** @type {import('esbuild').BuildOptions} */
const webviewCfg = {
  entryPoints: ['webview-ui/src/main.tsx'],
  bundle: true,
  outfile: 'dist/webview.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  sourcemap: true,
  // markdown 三件套（marked/dompurify/highlight.js）让 webview bundle 明显变大，
  // minify 压回去；扩展宿主 bundle 保持不压便于排查栈
  minify: true,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' },
}

if (watch) {
  const ctxs = await Promise.all([esbuild.context(extensionCfg), esbuild.context(webviewCfg)])
  await Promise.all(ctxs.map((c) => c.watch()))
} else {
  await Promise.all([esbuild.build(extensionCfg), esbuild.build(webviewCfg)])
}
