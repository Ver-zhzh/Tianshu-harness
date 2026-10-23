/** Node lines that contain the 2026-10-21 security fixes and support the CLI. */
const MINIMUM_BY_MAJOR = new Map<number, readonly [number, number]>([
  [24, [22, 1]],
  [26, [12, 1]],
])

export function isSecureNodeVersion(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  const minimum = MINIMUM_BY_MAJOR.get(major)
  if (!minimum) return false
  return minor > minimum[0] || (minor === minimum[0] && patch >= minimum[1])
}

export function assertSecureNodeVersion(version: string, context: string): void {
  if (isSecureNodeVersion(version)) return
  throw new Error(`${context}: Node.js v${version} is not a supported security release; use Node 24.x v24.22.1+ or Node 26.x v26.12.1+`)
}

export function requireSecureNodeRuntime(): void {
  try {
    assertSecureNodeVersion(process.versions.node, 'rivet')
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    process.exit(1)
  }
}
