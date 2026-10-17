import type { Stats } from 'node:fs'

/** A second directory entry can grant access to an inode outside the allowed roots. */
export function assertSingleLinkFile(path: string, stat: Pick<Stats, 'isFile' | 'nlink'>): void {
  if (stat.isFile() && stat.nlink > 1) {
    throw new Error(`Hardlink blocked: ${path} has ${stat.nlink} links and may alias an outside or sensitive file. Copy it instead of linking it.`)
  }
}
