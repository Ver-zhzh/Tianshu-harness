import { join } from 'node:path'
import { resolveTargetPlatform } from './runtime-platform-filter.js'

/** Flat native/ belongs to the host; cross-build outputs never replace it. */
export function packedSqlitePath(repoRoot, target = resolveTargetPlatform(), host = { os: process.platform, arch: process.arch }) {
  const native = join(repoRoot, 'dist', 'native')
  const cross = target.os !== host.os || target.arch !== host.arch
  return join(native, ...(cross ? [`${target.os}-${target.arch}`] : []), 'better_sqlite3.node')
}
