import { normalizeClaimPath } from './claim-path.js'

interface ClaimRow {
  rowid: number
  session_id: string
  file_path: string
  claim_type: 'exclusive' | 'shared_read'
  acquired_at: string
  last_touched_at: string
  cwd?: string
}

/** Preserve every owner when old races left conflicting rows. Arbitrarily
 * choosing a winner would discard a live lease. Only aliases/duplicates of
 * the SAME owner are merged, keeping the strongest mode and latest credential.
 * Migration and index creation share a write lock with acquireClaim. */
export function migrateClaimStorage(db: any): void {
  db.transaction(() => {
    const rows = db.prepare(`SELECT c.rowid, c.*, s.cwd FROM claims c
      LEFT JOIN sessions s ON s.id = c.session_id ORDER BY c.rowid`).all() as ClaimRow[]
    const groups = new Map<string, ClaimRow[]>()
    for (const row of rows) {
      const key = normalizeClaimPath(row.cwd, row.file_path)
      const id = JSON.stringify([row.session_id, key])
      const group = groups.get(id) ?? []
      group.push({ ...row, file_path: key })
      groups.set(id, group)
    }
    // Existing unique indexes can collide during alias consolidation. Delete
    // redundant rows before moving the survivor onto its canonical key.
    for (const group of groups.values()) {
      const survivor = group.reduce((a, b) => a.last_touched_at >= b.last_touched_at ? a : b)
      for (const row of group) {
        if (row.rowid !== survivor.rowid) db.prepare('DELETE FROM claims WHERE rowid = ?').run(row.rowid)
      }
      const strongest = group.some(r => r.claim_type === 'exclusive') ? 'exclusive' : 'shared_read'
      db.prepare('UPDATE claims SET file_path = ?, claim_type = ? WHERE rowid = ?').run(survivor.file_path, strongest, survivor.rowid)
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_claims_owner_file ON claims(session_id, file_path)')
  }).immediate()
}

/** BEGIN IMMEDIATE serializes the conflict read and insert/upgrade across
 * connections/processes. Do not use safeAll/safeRun here: an I/O/read/commit
 * error must roll back and reject acquisition, never become an empty snapshot.
 * Same-owner renewal happens AFTER checking all peers, including legacy races.
 */
export function acquireStoredClaim(db: any, sessionId: string, filePath: string, claimType: 'exclusive' | 'shared_read'): boolean {
  return db.transaction(() => {
    const cwd = db.prepare('SELECT cwd FROM sessions WHERE id = ?').get(sessionId)?.cwd as string | undefined
    const key = normalizeClaimPath(cwd, filePath)
    const existing = db.prepare('SELECT session_id, claim_type, last_touched_at, acquired_at FROM claims WHERE file_path = ?').all(key) as ClaimRow[]
    const own = existing.find(c => c.session_id === sessionId)
    const mode = own?.claim_type === 'exclusive' ? 'exclusive' : claimType
    if (existing.some(c => c.session_id !== sessionId && (c.claim_type === 'exclusive' || mode === 'exclusive'))) return false
    // A credential must change even for two renewals in the same millisecond
    // or after a backwards clock adjustment; takeover CAS relies on that.
    const previous = Date.parse(own?.last_touched_at ?? own?.acquired_at ?? '')
    const now = new Date(Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0)).toISOString()
    if (own) {
      return db.prepare('UPDATE claims SET claim_type = ?, last_touched_at = ? WHERE session_id = ? AND file_path = ?')
        .run(mode, now, sessionId, key).changes > 0
    }
    return db.prepare('INSERT INTO claims (session_id, file_path, claim_type, acquired_at, last_touched_at) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, key, mode, now, now).changes > 0
  }).immediate()
}
