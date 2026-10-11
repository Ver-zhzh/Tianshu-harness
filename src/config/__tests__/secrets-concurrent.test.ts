/**
 * 并发回归：secrets.json 多进程/多线程并发读-改-写的丢失更新与丢删除。
 *
 * 缺陷形态（2026-10 实测坐实，见交付文档「secrets 并发缺陷族」）：
 * 1. writeSecret 无锁 read-modify-write → 并发写只留最后写者的快照，其余 key 丢失；
 * 2. deleteSecret 同款 → 并发删被后写者的旧快照复活，「删除成功」的 key 残留磁盘；
 * 3. 共享固定 .tmp 路径 → 并发 rename 互抢，抛 ENOENT。
 *
 * 并发用 worker_threads 模拟（同步 fs 调用在各 worker 独立执行，交错真实）；
 * 同进程单线程内的 Promise 并发不构成并发——同步函数天然串行。
 *
 * 后端固定 local-key：macOS/Windows 默认后端会 spawn `security`/`powershell`，
 * 既慢又会写开发机的真实钥匙串。加密路径不变（AES-256-GCM 信封）。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeSecret, readSecret } from '../secrets-store.js'

const PREV_TOKEN_STORE = process.env.RIVET_TOKEN_STORE
before(() => {
  process.env.RIVET_TOKEN_STORE = 'local-key'
})
after(() => {
  if (PREV_TOKEN_STORE === undefined) delete process.env.RIVET_TOKEN_STORE
  else process.env.RIVET_TOKEN_STORE = PREV_TOKEN_STORE
})

const MODULE_URL = new URL('../secrets-store.js', import.meta.url).href

const WORKER_SRC = `
import { parentPort, workerData } from 'node:worker_threads'
import { writeSecret, deleteSecret } from ${JSON.stringify(MODULE_URL)}
const { base, op, workerId, rounds } = workerData
parentPort.once('message', () => {
  const errors = []
  for (let i = 0; i < rounds; i++) {
    const key = op + '-' + workerId + '-' + i
    try {
      if (op === 'write') writeSecret(key, 'sk-' + key, base)
      else deleteSecret(key, base)
    } catch (e) {
      errors.push(String((e && e.code) || e.message))
    }
  }
  parentPort.postMessage({ errors })
})
`

/** 起 N 个 worker 同时执行同一 op，返回每个 worker 的报错清单。 */
function runConcurrently(base: string, op: 'write' | 'delete', workers: number, rounds: number): Promise<string[][]> {
  return Promise.all(
    Array.from({ length: workers }, (_, i) =>
      new Promise<{ errors: string[] }>((resolve, reject) => {
        const w = new Worker(WORKER_SRC, { eval: true, workerData: { base, op, workerId: i, rounds } })
        w.on('message', resolve)
        w.on('error', reject)
        w.postMessage('go')
      })
    )
  ).then(results => results.map(r => r.errors))
}

describe('secrets store concurrency', () => {
  const WORKERS = 8
  const ROUNDS = 30

  it('concurrent writeSecret keeps every key (no lost update)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'rivet-secrets-conc-w-'))
    try {
      const errors = await runConcurrently(base, 'write', WORKERS, ROUNDS)
      assert.deepEqual(errors.flatMap(e => e), [], '并发写不得抛错（共享 .tmp 竞态）')
      const missing: string[] = []
      for (let w = 0; w < WORKERS; w++) {
        for (let i = 0; i < ROUNDS; i++) {
          const key = `write-${w}-${i}`
          if (readSecret(key, base) !== `sk-${key}`) missing.push(key)
        }
      }
      assert.equal(missing.length, 0, `并发写后应全部存活，丢了 ${missing.length} 个：${missing.slice(0, 5).join(', ')}…`)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('concurrent deleteSecret removes every key (no lost delete)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'rivet-secrets-conc-d-'))
    try {
      // 种子：WORKERS × ROUNDS 个 key，worker (w) 负责删自己的 ROUNDS 个
      for (let w = 0; w < WORKERS; w++) {
        for (let i = 0; i < ROUNDS; i++) {
          writeSecret(`delete-${w}-${i}`, `sk-delete-${w}-${i}`, base)
        }
      }
      const errors = await runConcurrently(base, 'delete', WORKERS, ROUNDS)
      assert.deepEqual(errors.flatMap(e => e), [], '并发删不得抛错')
      const survivors: string[] = []
      for (let w = 0; w < WORKERS; w++) {
        for (let i = 0; i < ROUNDS; i++) {
          const key = `delete-${w}-${i}`
          if (readSecret(key, base) !== undefined) survivors.push(key)
        }
      }
      // 「删除成功」却仍留在磁盘上的 key 比丢失更新更危险——用户以为凭据已撤销。
      assert.equal(survivors.length, 0, `并发删后不得残留，磁盘上还有 ${survivors.length} 个：${survivors.slice(0, 5).join(', ')}…`)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
