import { dirname } from 'node:path'
import { readFileSync } from 'node:fs'
import { findProjectConfig } from '../config/manager.js'
import { isProjectTrusted, notifyUntrustedOnce } from '../config/project-trust.js'
import type { Config } from '../config/schema.js'

/**
 * Merge project-level .rivet-config.json agent block into the startup config.
 * Only agent fields are merged — provider/model/auth stay on the startup snapshot
 * (the sidecar may have been started unconfigured, and the key was set later via
 * Settings). toolGating is deep-merged so project config can add extraCore without
 * clobbering the startup snapshot's other gating fields (enabled, disabledTools).
 *
 * Only reads the project config FILE (if it exists) — does NOT call loadConfig()
 * which merges user-level + defaults, which would clobber the startup snapshot
 * with unrelated user settings.
 *
 * Exported for testing. Malformed project config returns the unmodified startup
 * config.
 */
export function mergeProjectAgentConfig(
  startupConfig: Config,
  cwd: string,
): Config {
  try {
    const projectPath = findProjectConfig(cwd)
    if (!projectPath) return startupConfig
    // 信任门：agent 块含 approval/unsandboxed 等授权键——未授信项目不并入
    // （与 loadConfig Layer 3 剥离同语义；桌面端项目信任 UI 落地前的 fail-closed）。
    if (!isProjectTrusted(dirname(projectPath))) {
      notifyUntrustedOnce('config', dirname(projectPath))
      return startupConfig
    }
    const raw = JSON.parse(readFileSync(projectPath, 'utf-8')) as Record<string, unknown>
    const agent = raw?.agent
    if (!agent || typeof agent !== 'object' || Array.isArray(agent)) return startupConfig
    const { userInstructions: _userInstructions, ...projectAgent } = agent as Record<string, unknown>
    const projectTG = projectAgent.toolGating
    const projectToolGating =
      projectTG && typeof projectTG === 'object' && !Array.isArray(projectTG)
        ? (projectTG as Record<string, unknown>)
        : undefined
    return {
      ...startupConfig,
      agent: {
        ...startupConfig.agent,
        ...projectAgent,
        ...(projectToolGating ? {
          toolGating: {
            ...startupConfig.agent?.toolGating,
            ...projectToolGating,
          },
        } : {}),
      },
    }
  } catch {
    return startupConfig
  }
}
