/** Explicit export for Android candidate validation. No credentials or runtime startup. */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { PROTOCOL_VERSION, DATA_FORMAT_VERSION, MOBILE_FEATURES, RUNTIME_CAPABILITIES } from '../src/server/protocol.js'

const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim()
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--',
  'src', 'scripts', 'package.json', 'package-lock.json', 'tsup.config.ts', 'tsconfig.json'], { encoding: 'utf8', windowsHide: true }).trim().length > 0
const protocolSource = readFileSync(new URL('../src/server/protocol.ts', import.meta.url), 'utf8')
const eventBlock = protocolSource.split('export type SessionEventType =')[1]?.split('export interface SessionEvent')[0]
if (!eventBlock) throw new Error('Session event union not found')
const events = [...eventBlock.matchAll(/^\s*\|\s*'([^']+)'/gm)].map(match => match[1])
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
console.log(JSON.stringify({ schemaVersion: 1, kernelVersion: pkg.version, sourceRevision: revision,
  sourceDirty: dirty, protocolVersion: PROTOCOL_VERSION, dataFormatVersion: DATA_FORMAT_VERSION,
  mobileFeatures: MOBILE_FEATURES, capabilities: RUNTIME_CAPABILITIES, events,
  requiredFeatures: ['sessions', 'chat', 'events', 'approvals', 'providers'],
}, null, 2))
