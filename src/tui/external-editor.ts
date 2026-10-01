import { writeFileSync, readFileSync, unlinkSync, mkdtempSync, mkdirSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync, spawn } from 'node:child_process'
import { getDefaultEditor } from '../platform.js'
import { rivetHome } from '../config/paths.js'

export function getEditorCommand(): string {
  return process.env['VISUAL'] || process.env['EDITOR'] || getDefaultEditor()
}

export function createTempFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-edit-'))
  const path = join(dir, 'RIVET_INPUT.md')
  writeFileSync(path, content)
  return path
}

export function readAndCleanup(path: string): string {
  const content = readFileSync(path, 'utf-8')
  try { unlinkSync(path) } catch { /* best effort */ }
  return content
}

export function openInEditor(initialContent: string): string | null {
  const path = createTempFile(initialContent)
  const editor = getEditorCommand()
  const result = spawnSync(editor, [path], { stdio: 'inherit', windowsHide: true })
  if (result.status !== 0 && result.error) return null
  // status may be non-zero if editor was terminated but file was saved
  return readAndCleanup(path)
}

export async function editDraftInEditor(initialContent: string, options: { directory?: string; command?: string[] } = {}): Promise<string | null> {
  const root = options.directory ?? join(rivetHome(), 'tmp')
  mkdirSync(root, { recursive: true })
  const directory = mkdtempSync(join(root, 'draft-'))
  const file = join(directory, 'INPUT.md')
  writeFileSync(file, initialContent, { mode: 0o600 })
  // Respect quoted executable paths and editor arguments without invoking a shell.
  const command = options.command ?? (getEditorCommand().match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []).map(part => part.replace(/^(["'])(.*)\1$/, '$2'))
  try {
    if (!command.length) return null
    const status = await new Promise<number | null>(resolve => {
      const child = spawn(command[0]!, [...command.slice(1), file], { stdio: 'inherit', windowsHide: true })
      child.once('error', () => resolve(null))
      child.once('exit', code => resolve(code))
    })
    return status === 0 ? readFileSync(file, 'utf8') : null
  } catch { return null }
  finally { try { unlinkSync(file); rmdirSync(directory) } catch { /* Editor may have moved the file. */ } }
}
