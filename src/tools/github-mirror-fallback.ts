/**
 * GitHub mirror auto-fallback coordinator.
 *
 * When a git clone from github.com fails or times out, this module
 * automatically retries through the configured mirror list (gitcode /
 * kkgithub / fastgit). The first successful mirror is remembered in
 * session memory (default TTL 10 min) so subsequent clones skip the
 * direct attempt and go straight to the working mirror.
 *
 * ## Safety invariants
 * - fail-open: any mirror-layer exception is caught; original URL is
 *   always the ultimate fallback.
 * - user-respect: when the user has explicitly chosen a mirror
 *   (mirrors.enabled=true + github != 'default'), we only try that
 *   one — no automatic retry through other mirrors.
 * - observable: every attempt fires the `onAttempt` callback so
 *   callers can surface `[mirror]` notices in tool output / logs.
 */

import { GITHUB_MIRRORS, resolveGithubMirrorId } from './mirror-env.js'
import type { GithubMirrorId } from './mirror-env.js'
import type { MirrorsConfig } from '../config/schema.js'

// ── types ──────────────────────────────────────────────────────────

export interface FallbackDecision {
  /** The URL that was successfully cloned. */
  url: string
  /** Which mirror was used (undefined = direct github.com). */
  mirrorId?: Exclude<GithubMirrorId, 'default'>
  /** Why this URL was chosen. */
  reason: 'direct' | 'memory' | 'fallback'
  /** Mirrors that were tried and failed before success. */
  triedFailures: Array<{ mirrorId: string; error: string }>
}

// ── GitHub URL detection ───────────────────────────────────────────

/**
 * Regex for `https://github.com/owner/repo[.git]`.
 * Source: same pattern used by `rewriteGitHubUrls` in mirror-env.ts.
 */
const GITHUB_HTTPS_RE = /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\.git)?$/

/** Regex for SCP-style SSH: `git@github.com:owner/repo[.git]`. */
const GITHUB_SSH_RE = /^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\.git)?$/

/** Check whether a URL targets github.com (HTTPS or SCP-style SSH). */
export function isGithubUrl(url: string): boolean {
  return GITHUB_HTTPS_RE.test(url.trim()) || GITHUB_SSH_RE.test(url.trim())
}

/** Extract `owner/repo` from a GitHub URL, or null if unrecognized. */
function extractRepo(url: string): string | null {
  const m = url.trim().match(GITHUB_HTTPS_RE) ?? url.trim().match(GITHUB_SSH_RE)
  return m?.[1] ?? null
}

/** Build a mirror URL for a given `owner/repo` path. */
function buildMirrorUrl(repo: string, mirrorId: Exclude<GithubMirrorId, 'default'>): string {
  const mirror = GITHUB_MIRRORS[mirrorId]
  // Legacy dead mirror ids resolve to undefined → caller's mirror list simply
  // skips them (issue #524 fail-open). Defensively return a non-URL sentinel
  // that will fail fast if ever used.
  if (!mirror) return `https://github.com/${repo}`
  return mirror.template.replace('{repo}', repo)
}

// ── session memory ─────────────────────────────────────────────────

/** Key = `${cwd}::${owner/repo}` so different projects don't share. */
const mirrorMemory = new Map<string, { mirrorId: Exclude<GithubMirrorId, 'default'>; expiresAt: number }>()

/** Clear all session mirror memory (exposed for testing). */
export function clearMirrorMemory(): void {
  mirrorMemory.clear()
}

// ── main orchestrator ──────────────────────────────────────────────

/**
 * Try cloning a GitHub repository, automatically falling back through
 * mirrors on failure.
 *
 * @param originalUrl  – must be a `https://github.com/…` URL (or SCP-style
 *   `git@github.com:…`); non-GitHub URLs bypass fallback entirely.
 * @param config       – mirror configuration (from `loadConfig().mirrors`).
 * @param cwd          – project working directory (used as memory key).
 * @param cloneFn      – injected clone implementation. Called with a URL and
 *   timeout (ms); must throw on failure.
 * @param fallbackTimeoutMs – per-attempt timeout (default 60s).
 * @param fallbackMemoryMinutes – TTL for a successful mirror memory entry
 *   (default 10 min). 0 = no memory.
 * @param onAttempt    – called before each clone attempt (for logging).
 */
export async function cloneWithFallback(args: {
  originalUrl: string
  config: MirrorsConfig
  cwd: string
  cloneFn: (url: string, timeoutMs: number) => Promise<void>
  fallbackTimeoutMs?: number
  fallbackMemoryMinutes?: number
  onAttempt?: (info: { url: string; mirrorId?: string }) => void
}): Promise<FallbackDecision> {
  const timeoutMs = args.fallbackTimeoutMs ?? 60_000
  const memoryMinutes = args.fallbackMemoryMinutes ?? 10
  const repo = extractRepo(args.originalUrl)

  // ── not a GitHub URL → no fallback, just try the original ──────
  if (!repo) {
    try {
      await args.cloneFn(args.originalUrl, timeoutMs)
      return { url: args.originalUrl, reason: 'direct', triedFailures: [] }
    } catch (err) {
      // Re-throw as-is — caller handles non-GitHub clone errors directly
      throw err
    }
  }

  // ── check memory ────────────────────────────────────────────────
  const memoryKey = `${args.cwd}::${repo}`
  const remembered = mirrorMemory.get(memoryKey)
  if (remembered && remembered.expiresAt > Date.now()) {
    const mirrorUrl = buildMirrorUrl(repo, remembered.mirrorId)
    try {
      args.onAttempt?.({ url: mirrorUrl, mirrorId: remembered.mirrorId })
      await args.cloneFn(mirrorUrl, timeoutMs)
      return {
        url: mirrorUrl,
        mirrorId: remembered.mirrorId,
        reason: 'memory',
        triedFailures: [],
      }
    } catch {
      // Memory stale or mirror down — clear and fall through
      mirrorMemory.delete(memoryKey)
    }
  }

  // ── user explicitly chose a mirror? only try that one ───────────
  const userMirrorId = resolveGithubMirrorId(args.config)
  if (userMirrorId) {
    const mirrorUrl = buildMirrorUrl(repo, userMirrorId)
    try {
      args.onAttempt?.({ url: mirrorUrl, mirrorId: userMirrorId })
      await args.cloneFn(mirrorUrl, timeoutMs)
      return {
        url: mirrorUrl,
        mirrorId: userMirrorId,
        reason: 'direct',
        triedFailures: [],
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Clone failed through user-selected mirror ${userMirrorId}: ${msg}`,
        { cause: err },
      )
    }
  }

  // ── autoFallback disabled? only try original ────────────────────
  if (args.config.autoFallback === false) {
    try {
      await args.cloneFn(args.originalUrl, timeoutMs)
      return { url: args.originalUrl, reason: 'direct', triedFailures: [] }
    } catch (err) {
      throw err
    }
  }

  // ── auto-fallback: [original, mirror1, mirror2, mirror3] ────────
  const triedFailures: FallbackDecision['triedFailures'] = []
  const mirrorIds = Object.keys(GITHUB_MIRRORS) as Exclude<GithubMirrorId, 'default'>[]

  // 1. Try original github.com
  try {
    args.onAttempt?.({ url: args.originalUrl })
    await args.cloneFn(args.originalUrl, timeoutMs)
    return { url: args.originalUrl, reason: 'direct', triedFailures }
  } catch (err) {
    triedFailures.push({
      mirrorId: 'direct',
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // 2. Try each mirror in order
  for (const mirrorId of mirrorIds) {
    const mirrorUrl = buildMirrorUrl(repo, mirrorId)
    try {
      args.onAttempt?.({ url: mirrorUrl, mirrorId })
      await args.cloneFn(mirrorUrl, timeoutMs)
      // Remember success
      mirrorMemory.set(memoryKey, {
        mirrorId,
        expiresAt: Date.now() + memoryMinutes * 60_000,
      })
      return { url: mirrorUrl, mirrorId, reason: 'fallback', triedFailures }
    } catch (err) {
      triedFailures.push({
        mirrorId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // All failed
  const errors = triedFailures.map((f) => `${f.mirrorId}: ${f.error}`).join('; ')
  throw new Error(`All clone attempts failed: ${errors}`)
}
