/**
 * Disk I/O boundary for provider API keys (0600 secrets file).
 *
 * config.json holds only a `keyRef` pointer; the actual key lives in
 * `secrets.json` next to it.
 *
 * 内容自本次加固起为 **AES-256-GCM 信封**（数据密钥托管在 OS 密钥库或本机密钥
 * 文件，见 `src/auth/secure-store.ts`），与 `TokenStore`（src/auth/token-store.ts）
 * 同款。原因：`0o600` 在 Windows/NTFS 上不生效（权限由 ACL 决定），而
 * `~/.rivet` 常落在云同步/备份路径上——只靠文件权限等于把 key 明文交给任何能读
 * 该目录的进程。旧明文文件仍按原样读取，下次写入自动升级。`chmod` 保留作纵深防御。
 *
 * Reads are fail-open: a missing/corrupt store yields undefined and the
 * caller's existing fallback chain (env vars, friendly error) takes over.
 */

import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { rivetHome, userConfigPath } from './paths.js'
import { createSecretCipher, decodeSecret, encodeSecret, type SecretCipher } from '../auth/secure-store.js'

/** 锁等待上限。writeSecret/deleteSecret 的临界区是毫秒级 fs 操作，10s 足够排空
 *  8 个并发写者；超时则 fail-closed 抛错——凭据宁可报错也不无锁写入（与
 *  project-memory-writer 的超时 force-through 不同，那边丢一行记忆可接受，这边
 *  丢的是 API key）。
 *  RIVET_SECRETS_LOCK_TIMEOUT_MS 可缩短等待（接管路径的自动化测试/CI；
 *  非法值回落默认）。调用点读取，不进模块级冻结。 */
const DEFAULT_LOCK_TIMEOUT_MS = 10_000

function lockTimeoutMs(): number {
  const raw = Number(process.env.RIVET_SECRETS_LOCK_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LOCK_TIMEOUT_MS
}

interface SecretsFile {
  version: 1
  keys: Record<string, string>
}

/** Secrets live next to config.json (honors RIVET_CONFIG_PATH / RIVET_HOME). */
export function secretsPath(base?: string): string {
  if (base) return join(base, 'secrets.json')
  try {
    return join(dirname(userConfigPath()), 'secrets.json')
  } catch {
    return join(rivetHome(), 'secrets.json')
  }
}

/** cipher 与 secrets 文件同目录（数据密钥落 `<dir>/.token-key*`）；cipher 内部按后端+目录缓存且懒加载。 */
function cipherFor(base?: string): SecretCipher {
  return createSecretCipher(dirname(secretsPath(base)))
}

function readStore(base?: string, forWrite = false): SecretsFile | undefined {
  try {
    const raw = readFileSync(secretsPath(base), 'utf-8')
    const plain = decodeSecret(cipherFor(base), raw)
    if (plain === null) throw new Error('unreadable store')
    const parsed = JSON.parse(plain) as Partial<SecretsFile>
    if (parsed.version !== 1 || typeof parsed.keys !== 'object' || parsed.keys === null) throw new Error('invalid store')
    return { version: 1, keys: parsed.keys as Record<string, string> }
  } catch (error) {
    if (forWrite && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('Existing model credentials could not be read; refusing to overwrite them')
    }
    return undefined
  }
}

/**
 * 跨进程互斥锁（O_CREAT|O_EXCL 自旋，同 project-memory-writer.acquireLock 的协议）。
 * 锁文件写 PID 便于排障；stale 锁（持有者已死）在等待超时后强制接管——锁持有者
 * 崩溃在临界区内是罕见事件，而「永久死锁导致所有凭据写入失败」比偶发一次并发
 * 窗口更糟。锁到期前不接管。
 *
 * 接管的并发安全（审查加固）：① 先读锁内 PID 做存活检查——PID 还活着说明
 * 只是临界区慢（不是 stale），继续等而不是强抢；② 判死后 unlink 旧锁再走
 * 原子的 openSync('wx') 重建——两个同时超时者只有一个能建成功，另一个回到
 * 自旋，不再有「openSync('w') 双写并发进临界区」的窗口。接管与正常获取
 * 走同一条原子路径。
 */
function acquireStoreLock(path: string): () => void {
  const lockPath = `${path}.lock`
  mkdirSync(dirname(lockPath), { recursive: true })
  const timeout = lockTimeoutMs()
  const deadline = Date.now() + timeout
  while (true) {
    try {
      const fd = openSync(lockPath, 'wx')
      writeFileSync(fd, String(process.pid), 'utf8')
      closeSync(fd)
      return () => {
        try { unlinkSync(lockPath) } catch { /* already released */ }
      }
    } catch {
      if (Date.now() >= deadline) {
        // stale 锁接管前先验尸：锁内 PID 还活着 → 持有者没死，只是慢，
        // 强抢会造成活锁互踩。回到自旋（deadline 顺延一轮，防忙碌循环
        // 紧贴超时线反复触发接管检查）。
        let holderAlive = true
        try {
          const holderPid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10)
          if (Number.isInteger(holderPid) && holderPid > 0) {
            try { process.kill(holderPid, 0) } catch (err) {
              holderAlive = (err as NodeJS.ErrnoException).code !== 'ESRCH'
            }
          }
        } catch { /* 锁文件读取失败（消失/损坏）→ 视为可重建 */ holderAlive = false }
        if (holderAlive) {
          const waitUntil = Date.now() + 50
          while (Date.now() < waitUntil) { /* 活持有者：退避后重查 */ }
          continue
        }
        // 判死：原子接管——unlink 旧锁后重走 wx 路径。并发超时者中只有
        // unlink 与重建都成功的那一个拿到锁；失败者回到循环顶重试。
        try { unlinkSync(lockPath) } catch { /* already gone */ }
        // 给 wx 重建一轮机会；若再被抢先（另一接管者赢了），回循环顶自旋。
        // 若重建后仍持续失败直至再次超时，fail-closed 抛错——凭据宁可
        // 报错也不无锁写入。
        let retook = false
        try {
          const fd = openSync(lockPath, 'wx')
          writeFileSync(fd, String(process.pid), 'utf8')
          closeSync(fd)
          retook = true
        } catch { /* 另一接管者赢了 */ }
        if (retook) {
          return () => {
            try { unlinkSync(lockPath) } catch { /* already released */ }
          }
        }
        const now = Date.now()
        if (now >= deadline + timeout) {
          throw new Error(`secrets store lock acquisition timed out after ${timeout}ms (including stale-takeover retry): ${lockPath}`)
        }
        const waitUntil = Date.now() + 5
        while (Date.now() < waitUntil) { /* 5ms 自旋间隔 */ }
      } else {
        const waitUntil = Date.now() + 5
        while (Date.now() < waitUntil) { /* 5ms 自旋间隔，临界区毫秒级 */ }
      }
    }
  }
}

/** 在 store 文件的事务锁内执行 fn。writeSecret/deleteSecret 的读-改-写必须在
 *  同一临界区内——锁只包写入会让锁外的旧读快照被写回，丢失更新原样发生。 */
function withStoreLock(base: string | undefined, fn: () => void): void {
  const release = acquireStoreLock(secretsPath(base))
  try {
    fn()
  } finally {
    release()
  }
}

function writeStore(store: SecretsFile, base?: string): void {
  const path = secretsPath(base)
  mkdirSync(dirname(path), { recursive: true })
  // 唯一 tmp 名：并发写者互抢固定 `${path}.tmp` 会让败者 rename 抛 ENOENT。
  const tmpPath = `${path}.${process.pid}-${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(tmpPath, encodeSecret(cipherFor(base), JSON.stringify(store, null, 2)), { mode: 0o600 })
    renameSync(tmpPath, path)
  } finally {
    try { unlinkSync(tmpPath) } catch { /* rename 成功后 tmp 已不存在 */ }
  }
  chmodSync(path, 0o600)
}

export function readSecret(keyRef: string, base?: string): string | undefined {
  const store = readStore(base)
  const value = store?.keys[keyRef]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function writeSecret(keyRef: string, value: string, base?: string): void {
  // 锁内读-改-写：锁只包 writeStore 不够——readStore 在锁外读到的旧快照仍会被
  // 写回，丢失更新原样发生。整个事务必须在同一临界区内。
  withStoreLock(base, () => {
    const store = readStore(base, true) ?? { version: 1 as const, keys: {} }
    store.keys[keyRef] = value
    writeStore(store, base)
  })
}

export function deleteSecret(keyRef: string, base?: string): void {
  withStoreLock(base, () => {
    const store = readStore(base)
    if (!store || !(keyRef in store.keys)) return
    delete store.keys[keyRef]
    if (Object.keys(store.keys).length === 0) {
      try { unlinkSync(secretsPath(base)) } catch { /* already gone */ }
      return
    }
    writeStore(store, base)
  })
}

/** 展示安全的短指纹——用于标记共用同一 key 的条目，不打印密钥材料。 */
export function secretFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8)
}

export function fingerprintForKeyRef(keyRef: string, base?: string): string | undefined {
  const value = readSecret(keyRef, base)
  return value ? secretFingerprint(value) : undefined
}
