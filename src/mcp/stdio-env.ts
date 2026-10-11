/**
 * MCP stdio 子进程的环境组装。
 *
 * MCP SDK 的 StdioClientTransport 只继承一份白名单环境变量（PATH / HOME /
 * TEMP / …）——HTTPS_PROXY 一类代理变量不在其中。结果是：终端里 npx 能走代理
 * 拉包，GUI 启动的 sidecar 里的 npx 完全看不到代理；拉包失败表现为子进程秒退
 * → `MCP error -32000: Connection closed`（issue #72）。
 *
 * 这里对称 whisper 的 buildWhisperFetchChildEnv（src/server/speech-routes.ts）：
 * 把设置页 network.proxy / noProxy 注入标准代理变量。显式设置过的键一律不覆盖
 * ——优先级：server 自己的 env > 应用设置。
 */

import { buildStdioEnvWithNodePath } from '../platform/resolve-node-cli.js'

export interface McpNetworkConfig {
  proxy?: string
  noProxy?: string
}

/**
 * 启动即执行类环境变量（issue #137 同类，对称 `src/tools/bash.ts` 的显式剥离）：
 * 它们不含 KEY/TOKEN/SECRET 关键词，敏感过滤兜不住，但可在子进程启动时注入
 * 任意代码（NODE_OPTIONS 的 --require、JAVA_TOOL_OPTIONS 的 -javaagent、
 * LD_PRELOAD/DYLD_INSERT_LIBRARIES 的 so 注入）。
 *
 * MCP server 的 env 来自用户配置/技能/配置同步等可写来源，且审批指纹刻意不绑定
 * env 键值（凭据轮换容忍）——仅改值不触发重审，故在此处显式剥离，与 bash 路径
 * 的 #137 硬化对齐。
 */
const CODE_EXEC_ENV_VARS = [
  'NODE_OPTIONS',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'LD_PRELOAD',
  'DYLD_INSERT_LIBRARIES',
] as const

/** 剥离启动即执行类环境变量（大小写不敏感，覆盖 win32）。 */
export function stripCodeExecEnvVars(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if ((CODE_EXEC_ENV_VARS as readonly string[]).includes(key.toUpperCase())) continue
    out[key] = value
  }
  return out
}

/**
 * 计算需要补充的代理键（不覆盖 `existing` 中已有的代理变量）。
 * 对称 whisper 的判定：只要 HTTPS_PROXY / HTTP_PROXY（含小写）任一已存在，
 * 就不再写入应用设置里的 proxy——用户显式配置优先。
 */
export function buildMcpProxyEnv(
  existing: Record<string, string | undefined> | undefined,
  network: McpNetworkConfig | undefined | null,
): Record<string, string> {
  const out: Record<string, string> = {}
  const configured = network?.proxy?.trim()
  if (configured) {
    const hasHttps = !!(existing?.HTTPS_PROXY?.trim() || existing?.https_proxy?.trim())
    const hasHttp = !!(existing?.HTTP_PROXY?.trim() || existing?.http_proxy?.trim())
    if (!hasHttps && !hasHttp) {
      out.HTTPS_PROXY = configured
      out.HTTP_PROXY = configured
    }
  }
  const noProxy = network?.noProxy?.trim()
  if (noProxy && !existing?.NO_PROXY?.trim() && !existing?.no_proxy?.trim()) {
    out.NO_PROXY = noProxy
  }
  return out
}

/**
 * 组装 stdio 子进程最终 env：
 *   server 静态 env + 动态（OAuth）env + 应用代理 + Node 目录 PATH 注入。
 * 优先级：static > dynamic > network（应用设置）。
 */
export function buildStdioChildEnv(
  staticEnv: Record<string, string> | undefined,
  dynamicEnv: Record<string, string>,
  network: McpNetworkConfig | undefined,
  deps: {
    execPath?: string
    platform?: NodeJS.Platform
    existsSync?: (path: string) => boolean
    getDefaultEnvironment?: () => Record<string, string>
  } = {},
): Record<string, string> {
  const merged: Record<string, string> = { ...(staticEnv ?? {}), ...dynamicEnv }
  const proxyEnv = buildMcpProxyEnv(merged, network)
  // 对称 issue #137：剥离 NODE_OPTIONS 等启动即执行类变量——配置可控的 env 值
  // 原样进子进程且审批指纹不绑定值（凭据轮换容忍），与 bash 路径的不对称是
  // 真实攻击面（探针：NODE_OPTIONS=--require 可在子进程启动即执行任意代码）。
  return buildStdioEnvWithNodePath(stripCodeExecEnvVars({ ...proxyEnv, ...merged }), deps)
}
