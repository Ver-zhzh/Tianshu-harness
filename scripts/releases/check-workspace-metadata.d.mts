import type { Buffer } from 'node:buffer'

export interface WorkspaceMetadataResult {
  stableVersion: string
  packageVersion: string
  platforms: number
}
export function validateWorkspaceMetadata(input: {
  packageVersion: string
  manifest: unknown
  catalogBytes: string | Buffer
  control: unknown
}): WorkspaceMetadataResult
export function checkWorkspaceMetadata(root?: string): WorkspaceMetadataResult
export function writeCatalog(file: string, catalog: unknown, root?: string): Buffer
