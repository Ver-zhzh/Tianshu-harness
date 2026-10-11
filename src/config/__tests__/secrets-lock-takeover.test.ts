/**
 * stale 锁接管路径回归（df92bed52 加固的「验尸 + 原子接管」）。
 *
 * 覆盖两条此前只有手工实测背书的分支：
 * 1. 死 PID 锁（stale）：等待超时 → 判死 → unlink + wx 原子接管 → 写入落盘；
 * 2. 活 PID 锁：不得强抢——等待方 50ms 退避续等，锁内容不被改写，
 *    持有者释放后照常获取（旧 openSync('w') 接管在这里是确定性丢互斥）。
 *
 * 超时经 RIVET_SECRETS_LOCK_TIMEOUT_MS 缩短到 300ms，免走 10s 真等。
 * 活锁用例的等待方放 worker_threads：acquireStoreLock 是同步忙等，
 * 同进程内会直接堵死事件循环（持有者与等待者同一进程时构成自锁）。
 *
 * 不在覆盖内：多等待者同一超时窗同时判死的 unlink→wx 间隙竞态
 * （微秒级窗口；正常并发路径的读-改-写完整性由 secrets-concurrent 守）。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSecret, secretsPath, writeSecret } from '../secrets-store.js'

const TIMEOUT = '300'
const PREV_TOKEN_STORE = process.env.RIVET_TOKEN_STORE
const PREV_LOCK_TIMEOUT = process.env.RIVET_SECRETS_LOCK_TIMEOUT_MS

before(() => {
  // 后端固定 local-key：默认后端会 spawn security/powershell（同 secrets-concurrent）。
  process.env.RIVET_TOKEN_STORE = 'local-key'
  process.env.RIVET_SECRETS_LOCK_TIMEOUT_MS = TIMEOUT
})
after(() => {
  if (PREV_TOKEN_STORE === undefined) delete process.env.RIVET_TOKEN_STORE
  else process.env.RIVET_TOKEN_STORE = PREV_TOKEN_STORE
  if (PREV_LOCK_TIMEOUT === undefined) delete process.env.RIVET_SECRETS_LOCK_TIMEOUT_MS
  else process.env.RIVET_SECRETS_LOCK_TIMEOUT_MS = PREV_LOCK_TIMEOUT
})

/** 刚退出子进程的 PID：kill(pid, 0) 必 ESRCH（接管判死的真实输入）。 */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''], { windowsHide: true })
  if (!child.pid) throw new Error('failed to spawn short-lived child for dead PID')
  return child.pid
}

const MODULE_URL = new URL('../secrets-store.js', import.meta.url).href

/** 等待方 worker：进入 writeSecret 前先报到（排除 tsx 装载抖动对断言窗口的污染）。 */
const WRITER_SRC = `
import { parentPort, workerData } from 'node:worker_threads'
import { writeSecret } from ${JSON.stringify(MODULE_URL)}
const { base, key, value } = workerData
parentPort.once('message', () => {
  parentPort.postMessage('entered')
  try {
    writeSecret(key, value, base)
    parentPort.postMessage('done')
  } catch (err) {
    parentPort.postMessage('error:' + String((err && err.message) || err))
  }
})
`

describe('secrets store stale-lock takeover', () => {
  it('dead holder lock is taken over after the timeout and the write lands', () => {
    const base = mkdtempSync(join(tmpdir(), 'rivet-secrets-takeover-dead-'))
    try {
      const lockPath = `${secretsPath(base)}.lock`
      writeFileSync(lockPath, String(deadPid()))
      const started = Date.now()
      writeSecret('takeover-key', 'sk-takeover', base)
      const elapsed = Date.now() - started
      assert.equal(readSecret('takeover-key', base), 'sk-takeover')
      assert.ok(!existsSync(lockPath), 'release 后锁文件应被摘除')
      assert.ok(
        elapsed >= Number(TIMEOUT) - 50,
        `锁被占时应等到超时再接管（实耗 ${elapsed}ms），瞬时拿到说明没走接管路径`,
      )
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('live holder lock is never stolen — waiter backs off, then proceeds after release', async () => {
    const base = mkdtempSync(join(tmpdir(), 'rivet-secrets-takeover-live-'))
    let worker: Worker | undefined
    try {
      const lockPath = `${secretsPath(base)}.lock`
      // 持有者 = 本进程（活着）。旧接管逻辑（openSync('w') 无验尸）会在此断言下确定性变红。
      writeFileSync(lockPath, String(process.pid))

      let done = false
      let failure: string | undefined
      const entered = new Promise<void>((resolve, reject) => {
        worker = new Worker(WRITER_SRC, { eval: true, workerData: { base, key: 'live-key', value: 'sk-live' } })
        worker.on('message', (msg: string) => {
          if (msg === 'entered') resolve()
          else if (msg === 'done') { done = true }
          else if (typeof msg === 'string' && msg.startsWith('error:')) { failure = msg.slice(6) }
        })
        worker.on('error', reject)
        worker.postMessage('go')
      })
      await entered

      // 等满 3 个超时窗：等待方每窗都会做一次验尸——活持有者应始终退避。
      await new Promise(r => setTimeout(r, Number(TIMEOUT) * 3))
      assert.equal(done, false, '活持有者的锁不得被强抢（等待方应仍在退避）')
      assert.equal(
        readFileSync(lockPath, 'utf8'),
        String(process.pid),
        '等待中超时窗内锁内容不得被改写（旧 openSync(\'w\') 接管会截断成等待方 PID）',
      )

      // 持有者释放 → 等待方照常获取并完成写入。
      unlinkSync(lockPath)
      for (let i = 0; i < 100 && !done && !failure; i++) await new Promise(r => setTimeout(r, 20))
      assert.equal(failure, undefined, failure)
      assert.equal(done, true, '持有者释放后等待方应完成写入')
      assert.equal(readSecret('live-key', base), 'sk-live')
    } finally {
      await worker?.terminate()
      rmSync(base, { recursive: true, force: true })
    }
  })
})
