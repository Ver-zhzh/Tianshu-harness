import type { SpawnSyncReturns } from 'node:child_process'

export function verifyMutation(
  name: string,
  destination: string,
  run?: (phase: 'baseline' | 'mutant', env: NodeJS.ProcessEnv) => SpawnSyncReturns<string>,
): void
