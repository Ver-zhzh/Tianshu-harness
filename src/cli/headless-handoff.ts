import { join } from 'node:path'
import { sessionsDir } from '../config/paths.js'
import { parseHandoffCommand, queryHandoffCommand } from '../agent/handoff-command.js'
import { publishFactHandoff } from '../agent/fact-handoff.js'
import { createHandoffRequest, buildHandoffPrompt, completeHandoffRequest } from '../tui/handoff.js'
import type { HeadlessCliArgs, HeadlessRunResult } from '../headless.js'
export function prepareHeadlessHandoff(args: HeadlessCliArgs, cwd: string, sessionId: string) {
  const command = args.prompt ? parseHandoffCommand(args.prompt) : undefined
  if (!command) return undefined
  if (command.action !== 'generate') return { text: queryHandoffCommand(cwd, sessionId, command), sessionId }
  const snapshot = publishFactHandoff(cwd, sessionId, {}, command.note)
  if (!command.narrative) return { text: snapshot.brief, sessionId, snapshotId: snapshot.snapshotId }
  const request = createHandoffRequest(cwd, sessionId, join(sessionsDir(cwd), `${sessionId}.handoff.md`))
  return { prompt: buildHandoffPrompt(request.sourcePath, command.note), request, sessionId }
}
export function finishHeadlessHandoff(request: ReturnType<typeof createHandoffRequest>, result: HeadlessRunResult): void {
  const archive = completeHandoffRequest(request)
  if (result.json) result.json.text += `\n${archive.message}`
  else result.stdout += `\n${archive.message}`
  if (!['archived', 'updated'].includes(archive.status)) result.exitCode = 1
}
