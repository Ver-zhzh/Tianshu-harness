import { existsSync, globSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parse } from 'yaml'

export type TestPackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'
export interface TestPackage { root: string; name?: string; scripts?: Record<string, string>; packageManager?: string; workspaces?: string[] | { packages?: string[] } }
export function readTestPackage(root: string): TestPackage | undefined {
  try { return { ...JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')), root: resolve(root) } } catch { return undefined }
}
export function insideTestRoot(root: string, path: string): boolean {
  const rel = relative(root, path)
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\')
}
export function canonicalTestPath(path: string): string { try { return realpathSync(path) } catch { return resolve(path) } }
export function testWorkspace(cwd: string): { root: string; packages: TestPackage[] } {
  let directory = resolve(cwd)
  for (;;) {
    const pkg = readTestPackage(directory)
    let patterns = Array.isArray(pkg?.workspaces) ? pkg.workspaces : pkg?.workspaces?.packages
    if (existsSync(join(directory, 'pnpm-workspace.yaml'))) {
      try { patterns = (parse(readFileSync(join(directory, 'pnpm-workspace.yaml'), 'utf8')) as { packages?: string[] })?.packages } catch { return { root: directory, packages: pkg ? [pkg] : [] } }
    }
    if (Array.isArray(patterns)) {
      const packages = new Map<string, TestPackage>()
      if (pkg) packages.set(pkg.root, pkg)
      for (const pattern of patterns) {
        if (typeof pattern !== 'string' || pattern.startsWith('!') || pattern.includes('..') || isAbsolute(pattern)) continue
        for (const file of globSync(pattern.replace(/\/$/, '') + '/package.json', { cwd: directory, exclude: ['**/node_modules/**', '**/.git/**'] })) {
          const child = readTestPackage(dirname(resolve(directory, file)))
          if (child && insideTestRoot(canonicalTestPath(directory), canonicalTestPath(child.root))) packages.set(child.root, child)
        }
      }
      // Negative workspace patterns exclude members; never interpret them as inclusions.
      for (const pattern of patterns.filter(p => typeof p === 'string' && p.startsWith('!'))) {
        if (pattern.includes('..') || isAbsolute(pattern.slice(1))) continue
        for (const file of globSync(pattern.slice(1).replace(/\/$/, '') + '/package.json', { cwd: directory, exclude: ['**/node_modules/**', '**/.git/**'] })) packages.delete(dirname(resolve(directory, file)))
      }
      const standalone = readTestPackage(cwd)
      if (standalone && !packages.has(standalone.root)) return { root: standalone.root, packages: [standalone] }
      return { root: directory, packages: [...packages.values()] }
    }
    const parent = dirname(directory)
    if (parent === directory || existsSync(join(directory, '.git'))) return { root: resolve(cwd), packages: readTestPackage(cwd) ? [readTestPackage(cwd)!] : [] }
    directory = parent
  }
}
export function testPackageManager(cwd: string): TestPackageManager {
  const workspace = testWorkspace(cwd)
  const declared = readTestPackage(cwd)?.packageManager ?? readTestPackage(workspace.root)?.packageManager
  const name = declared?.split('@')[0]
  if (name && ['npm', 'pnpm', 'yarn', 'bun'].includes(name)) return name as TestPackageManager
  for (const [lock, manager] of [['pnpm-lock.yaml', 'pnpm'], ['pnpm-workspace.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['.pnp.cjs', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun']] as const) if (existsSync(join(workspace.root, lock))) return manager
  return 'npm'
}
export function selectTestPackages(cwd: string, selectors: string[]): TestPackage[] {
  const workspace = testWorkspace(cwd)
  let selected: TestPackage[] = []
  for (const selector of selectors) {
    if (!selector || /[[\]{}^]|\.\.\./.test(selector)) return []
    const exclude = selector.startsWith('!'), value = exclude ? selector.slice(1) : selector
    const expression = new RegExp('^' + value.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
    const matches = workspace.packages.filter(pkg => expression.test(pkg.name ?? '') || expression.test('./' + relative(workspace.root, pkg.root).replaceAll('\\', '/')) || resolve(workspace.root, value) === pkg.root)
    selected = exclude ? selected.filter(pkg => !matches.includes(pkg)) : [...new Set([...selected, ...matches])]
  }
  return selected
}
