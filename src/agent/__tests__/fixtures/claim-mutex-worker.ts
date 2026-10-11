import { SessionRegistry } from '../../session-registry.js'

const [stateDir, sessionId, claimType] = process.argv.slice(2)
const registry = await SessionRegistry.create(stateDir!)
registry.register(sessionId!, '/workspace')
// Widen the real SELECT/INSERT window without changing its result. With an
// IMMEDIATE transaction the pause holds the write lock; without one all peers
// read the same empty snapshot before any INSERT (deterministic regression).
const db = (registry as any).db
const prepare = db.prepare.bind(db)
db.prepare = (sql: string) => {
  const stmt = prepare(sql)
  if (sql.includes('SELECT') && sql.includes('FROM claims')) {
    const all = stmt.all.bind(stmt)
    stmt.all = (...params: unknown[]) => {
      const rows = all(...params)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150)
      return rows
    }
  }
  return stmt
}
process.on('message', message => {
  if (message === 'go') {
    const acquired = registry.acquireClaim(sessionId!, 'src/file.ts', claimType as 'exclusive' | 'shared_read')
    process.send?.({ acquired })
  } else if (message === 'close') {
    registry.close()
    process.disconnect()
  }
})
process.send?.({ ready: true })
