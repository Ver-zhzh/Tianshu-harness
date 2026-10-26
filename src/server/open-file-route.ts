import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { buildOpenPathCommand, buildRevealCommand, decideOpenAction, isDirectoryPath, windowsFileHasHandler } from '../tools/open-path.js'
import { isAuthorizedRequest } from './auth.js'
import type { RouteHandler } from './index.js'

interface OpenFileDeps {
  platform: NodeJS.Platform
  exists: typeof existsSync
  isDirectory: typeof isDirectoryPath
  hasHandler: typeof windowsFileHasHandler
  spawn: typeof spawn
}

/** Open a local path from the desktop file tree or viewer. */
export function buildOpenFileRoute(apiToken?: string, overrides: Partial<OpenFileDeps> = {}): Record<string, RouteHandler> {
  const deps: OpenFileDeps = {
    platform: process.platform, exists: existsSync, isDirectory: isDirectoryPath,
    hasHandler: windowsFileHasHandler, spawn, ...overrides,
  }
  return {
    'POST /open-file': async (body, _params, headers) => {
      if (!isAuthorizedRequest({ body, headers }, apiToken)) {
        return { status: 401, body: { error: 'Unauthorized' } }
      }
      const input = body as Record<string, unknown> | undefined
      const filePath = input?.path
      if (typeof filePath !== 'string' || !filePath) {
        return { status: 400, body: { error: 'Missing path' } }
      }
      const paths = deps.platform === 'win32' ? win32 : posix
      // The sidecar's cwd can differ from the captured file-tree root.
      const resolved = typeof input?.cwd === 'string' && input.cwd
        ? paths.resolve(input.cwd, filePath)
        : paths.resolve(filePath)
      if (!deps.exists(resolved)) {
        return { status: 404, body: { error: `Path not found: ${resolved}` } }
      }
      const isDir = deps.isDirectory(resolved)
      const action = input?.reveal === true ? 'reveal' : decideOpenAction({
        platform: deps.platform,
        isDirectory: isDir,
        hasHandler: isDir ? undefined : deps.hasHandler(resolved, deps.platform),
      })
      // Files without an association use reveal to avoid detached OpenWith dialogs (#193).
      const command = action === 'reveal'
        ? buildRevealCommand(resolved, deps.platform)
        : deps.platform === 'win32'
          ? { cmd: 'explorer.exe', args: [resolved.replace(/\//g, '\\')] }
          : buildOpenPathCommand(resolved, deps.platform)
      try {
        await new Promise<void>((resolve, reject) => {
          // windowsHide also sets SW_HIDE for GUI apps. Only suppress helper
          // consoles; Explorer itself must be allowed to show its window.
          const child = deps.spawn(command.cmd, command.args, {
            detached: true, stdio: 'ignore', windowsHide: command.cmd !== 'explorer.exe',
          })
          child.on('error', reject)
          child.on('spawn', () => { child.unref(); resolve() })
        })
        return action === 'reveal'
          ? { status: 200, body: { opened: false, revealed: true, path: resolved } }
          : { status: 200, body: { opened: resolved } }
      } catch (err) {
        console.error(`[open-file] spawn failed: ${command.cmd} ${command.args.join(' ')} → ${(err as Error).message}`)
        return { status: 500, body: { error: `启动失败: ${(err as Error).message}` } }
      }
    },
  }
}
