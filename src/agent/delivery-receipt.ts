import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { sessionsDir } from '../config/paths.js'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { assertValidSessionId } from '../validation.js'

function receiptFile(cwd: string, sessionId: string): string {
  assertValidSessionId(sessionId)
  return join(sessionsDir(cwd), sessionId, 'delivery-receipt.json')
}
export function readDeliveryReceipt(cwd: string, sessionId: string): string | undefined {
  return readDeliveryReceipts(cwd, sessionId).at(-1)
}
export function readDeliveryReceipts(cwd: string, sessionId: string): string[] {
  const file = receiptFile(cwd, sessionId)
  if (!existsSync(file)) return []
  const data = JSON.parse(readFileSync(file, 'utf8'))
  const commits: unknown[] = data.version === 2 ? data.commits : [data.commitSha]
  if (data.sessionId !== sessionId || data.root && data.root !== resolve(cwd) || !Array.isArray(commits)
    || !commits.every(sha => typeof sha === 'string' && /^[a-f0-9]{40,64}$/i.test(sha))) throw new Error('Invalid delivery receipt owner or SHA')
  return [...new Set(commits as string[])]
}
export function recordDeliveryReceipt(cwd: string, sessionId: string, commitSha: string): void {
  if (!/^[a-f0-9]{40,64}$/i.test(commitSha)) throw new Error('A delivery receipt requires the actual commit SHA')
  const file = receiptFile(cwd, sessionId)
  mkdirSync(dirname(file), { recursive: true })
  const commits = [...new Set([...readDeliveryReceipts(cwd, sessionId), commitSha])]
  writeFileAtomicSync(file, JSON.stringify({ version: 2, root: resolve(cwd), sessionId, commits, commitSha }) + '\n')
}
