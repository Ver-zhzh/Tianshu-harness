import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Plugin } from 'esbuild'

/** Build-time annotation only; the runtime never infers its revision from cwd. */
export function createBuildStamp(version: string) {
  let revision = 'unknown'
  try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim() } catch { /* source archives have no Git metadata */ }
  return { id: randomUUID(), revision, version }
}

/** onLoad runs for every rebuild; config-level define would reuse a watch nonce. */
export function buildStampPlugin(version: string): Plugin {
  return {
    name: 'rivet-build-stamp',
    setup(build) {
      build.onLoad({ filter: /[/\\]runtime-provenance\.ts$/ }, async args => {
        const source = await readFile(args.path, 'utf8')
        const marker = 'declare const __RIVET_BUILD_STAMP__: string | undefined'
        if (source.split(marker).length !== 2) throw new Error('Runtime provenance stamp declaration missing or duplicated')
        return { contents: source.replace(marker, `const __RIVET_BUILD_STAMP__ = ${JSON.stringify(JSON.stringify(createBuildStamp(version)))}`),
          loader: 'ts', resolveDir: dirname(args.path), watchFiles: [args.path] }
      })
    },
  }
}
