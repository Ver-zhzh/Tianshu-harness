import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(import.meta.dirname, '..')

export function assessRunningBuild(health, expectedBuildId, expectedVersion) {
  if (!health || typeof health !== 'object' || typeof health.buildId !== 'string') {
    throw new Error('健康接口未返回 buildId；需要带有效 sidecar token 的完整 /health 响应')
  }
  if (!health.buildId || health.buildId === 'unknown') throw new Error('运行实例的 buildId 不可验证')
  if (health.buildId !== expectedBuildId) {
    throw new Error(`运行实例 buildId 不匹配：实际 ${health.buildId}，期望 ${expectedBuildId}`)
  }
  if (health.version !== expectedVersion) {
    throw new Error(`运行实例版本不匹配：实际 ${String(health.version)}，期望 ${expectedVersion}`)
  }
  if (health.readiness !== 'ready' || health.ok !== true) {
    throw new Error(`运行实例尚未就绪：readiness=${String(health.readiness)} ok=${String(health.ok)}`)
  }
  return { buildId: health.buildId, version: health.version, instanceId: health.instanceId }
}

export async function verifyRunningBuild({ url, token, expectedBuildId, expectedVersion, fetchImpl = fetch }) {
  const endpoint = new URL('/health', url)
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) {
    throw new Error('只允许查询本机 HTTP sidecar，避免向远端发送认证令牌')
  }
  if (!token) throw new Error('缺少 RIVET_SERVER_TOKEN，无法读取带 buildId 的完整健康信息')
  if (!expectedBuildId) throw new Error('缺少期望 buildId，必须显式指定候选构建身份')
  const response = await fetchImpl(endpoint, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) throw new Error(`健康接口返回 HTTP ${response.status}`)
  return assessRunningBuild(await response.json(), expectedBuildId, expectedVersion)
}

function option(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main() {
  const url = option('--url')
  if (!url) throw new Error('用法：node scripts/verify-running-build.mjs --url http://127.0.0.1:<port> --expected-build <id> [--expected-version <version>]')
  const expectedBuildId = option('--expected-build') ?? process.env.TIANSHU_BUILD_ID
  const expectedVersion = option('--expected-version')
    ?? JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version
  const result = await verifyRunningBuild({ url, token: process.env.RIVET_SERVER_TOKEN,
    expectedBuildId, expectedVersion })
  console.log(`运行实例已核验：version=${result.version} buildId=${result.buildId} instanceId=${result.instanceId ?? 'unknown'}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`[verify-running-build] ${error.message}`); process.exitCode = 1 })
}
