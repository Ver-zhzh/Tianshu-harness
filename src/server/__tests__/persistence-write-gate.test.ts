/**
 * 会话库写资格闸门（store-lock 丢锁 fail-closed）回归
 *
 * 病灶：StoreLock 运行期丢锁（被接管/删除）后，FileSessionPersistence 的
 * 100ms debounce 延迟刷新、flushAll/flushSync、索引自愈重建（rebuildAndSlice）
 * 此前都不查写资格——丢锁进程会继续把事件/快照/索引写进已经不再属于自己的
 * 会话库（双写，新锁主的数据被污染）。
 *
 * 修复：构造注入 canWrite() 谓词（实时求值），所有写路径在**提交前**检查；
 * 撤销后火忘式写入直接丢弃，saveArchive/flushThrough 这类调用方依赖结果的
 * 写路径抛错。读路径不受闸门影响。
 *
 * 每条用例都做过「还原缺陷即红」核验：撤掉对应的提交前检查后，对应用例
 * 必须落盘 → 红（见各用例注释）。
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { FileSessionPersistence } from '../session-persistence.js'
import type { SessionEvent, SessionRecord } from '../session-manager.js'

let DIR = ''

beforeEach(() => {
  DIR = mkdtempSync(join(tmpdir(), 'persistence-gate-'))
})

afterEach(() => {
  rmSync(DIR, { recursive: true, force: true })
})

function record(id: string): SessionRecord {
  return { id, status: 'running', createdAt: 1, updatedAt: 2, cwd: '/work', lastSeq: 1, pendingApprovals: 0 }
}

/** 非 CRITICAL 类型 → 留在 100ms debounce 缓冲（除非显式 flush）。 */
function ev(seq: number, type = 'text_delta'): SessionEvent {
  return { seq, ts: seq, type, data: { text: 'x' } } as SessionEvent
}

describe('FileSessionPersistence — 写资格闸门（canWrite）', () => {
  // 还原缺陷即红：撤掉 runWriteChain 的提交前检查 → 缓冲行落盘 → 红。
  it('撤销后：debounce 延迟刷新不落盘', async () => {
    let canWrite = true
    const p = new FileSessionPersistence(DIR, { canWrite: () => canWrite })
    p.appendEvent('s1', ev(1))
    canWrite = false
    await sleep(300) // debounce 100ms 已过，写链已跑完
    assert.equal(existsSync(join(DIR, 's1', 'events.jsonl')), false, '丢锁后延迟刷新必须丢弃')
  })

  // 还原缺陷即红：撤掉 runWriteChain 检查 → CRITICAL 立即链写落盘 → 红。
  it('撤销后：CRITICAL 事件的立即写链也不落盘', async () => {
    let canWrite = true
    const p = new FileSessionPersistence(DIR, { canWrite: () => canWrite })
    p.appendEvent('s1', ev(1, 'user')) // CRITICAL → 立即 kickWriteChain
    canWrite = false // 同步赋值先于 microtask 写链启动 —— 撤销发生在提交前
    await p.flushAllAsync(1_000)
    assert.equal(existsSync(join(DIR, 's1', 'events.jsonl')), false)
  })

  // 还原缺陷即红：撤掉 appendEvent 入口检查 → 撤销后的事件仍入缓冲并随后落盘 → 红。
  it('撤销后：新到达的事件直接丢弃，不进缓冲', async () => {
    const p = new FileSessionPersistence(DIR, { canWrite: () => false })
    p.appendEvent('s1', ev(1, 'user'))
    p.saveRecord(record('s1'))
    await p.flushAllAsync(1_000)
    assert.equal(existsSync(join(DIR, 's1')), false, '入口闸门后一个字节都不该有')
  })

  // 还原缺陷即红：撤掉 flushSession 检查 → 滞留缓冲被同步排空落盘 → 红。
  it('撤销后：flushSync 丢弃滞留缓冲，不落盘', () => {
    let canWrite = true
    const p = new FileSessionPersistence(DIR, { canWrite: () => canWrite })
    p.appendEvent('s1', ev(1)) // 有资格时入缓冲
    p.saveRecord(record('s1'))
    canWrite = false
    p.flushSync()
    assert.equal(existsSync(join(DIR, 's1', 'events.jsonl')), false)
    assert.equal(existsSync(join(DIR, 's1', 'index.json')), false)
  })

  // 还原缺陷即红：撤掉 flushAllAsync 的闸门 → 滞留缓冲经写链落盘 → 红。
  it('撤销后：flushAllAsync 丢弃滞留缓冲并立即返回（不空等到超时）', async () => {
    let canWrite = true
    const p = new FileSessionPersistence(DIR, { canWrite: () => canWrite })
    p.appendEvent('s1', ev(1))
    p.saveRecord(record('s1'))
    canWrite = false
    const t0 = Date.now()
    await p.flushAllAsync(30_000)
    assert.ok(Date.now() - t0 < 5_000, '闸门撤销后 flushAllAsync 不得空转等超时')
    assert.equal(existsSync(join(DIR, 's1')), false)
  })

  // 还原缺陷即红：撤掉 rebuildAndSlice 的写回闸门 → events.index.jsonl 落盘 → 红。
  it('撤销后：索引自愈重建（rebuildAndSlice）不落地，读结果照常返回', async () => {
    const dir = join(DIR, 's1')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'events.jsonl'), JSON.stringify(ev(1)) + '\n' + JSON.stringify(ev(2)) + '\n', 'utf8')
    // 无 events.index.jsonl → loadEventsBefore 触发整本重建
    const p = new FileSessionPersistence(DIR, { canWrite: () => false })

    const page = await p.loadEventsBefore('s1', 99, 10)

    assert.equal(page.events.length, 2, '读路径不受闸门影响')
    assert.equal(existsSync(join(dir, 'events.index.jsonl')), false, '丢锁后修复性写入必须跳过')
  })

  it('有写资格时：索引重建照常落地（闸门不误伤正常路径）', async () => {
    const dir = join(DIR, 's1')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'events.jsonl'), JSON.stringify(ev(1)) + '\n' + JSON.stringify(ev(2)) + '\n', 'utf8')
    const p = new FileSessionPersistence(DIR, { canWrite: () => true })

    const page = await p.loadEventsBefore('s1', 99, 10)

    assert.equal(page.events.length, 2)
    assert.equal(existsSync(join(dir, 'events.index.jsonl')), true)
  })

  // 还原缺陷即红：撤掉 flushThrough 检查 → 空等到 deadline 而非立即抛错 → 超时红。
  it('撤销后：flushThrough 立即抛错而不是空等 30s', async () => {
    const p = new FileSessionPersistence(DIR, { canWrite: () => false })
    const t0 = Date.now()
    await assert.rejects(p.flushThrough('s1', 1), /lock lost|revoked/i)
    assert.ok(Date.now() - t0 < 2_000, '必须 fail-fast，不能把 30s 预算耗在空等上')
  })

  // 还原缺陷即红：撤掉附件/删除任一闸门 → 对应文件落盘/被删 → 红。
  it('撤销后：附件落盘丢弃、saveArchive 抛错、deleteSession 不动磁盘', () => {
    const dir = join(DIR, 's1')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'events.jsonl'), JSON.stringify(ev(1)) + '\n', 'utf8')
    const p = new FileSessionPersistence(DIR, { canWrite: () => false })

    p.saveToolOutput('s1', 'out1', 'text')
    p.saveImage('s1', 'img1', Buffer.from('x').toString('base64'), 'image/png')
    p.saveDocument('s1', 'doc1', Buffer.from('x').toString('base64'), 'a.md')
    assert.throws(
      () => p.saveArchive('s1', 'zip1', { base64: Buffer.from('x').toString('base64') }, 'a.zip'),
      /lock lost|revoked/i,
      '调用方依赖返回路径存在 → 必须抛错而不是静默丢弃',
    )
    p.deleteSession('s1')

    assert.equal(existsSync(join(dir, 'events.jsonl')), true, '丢锁后 deleteSession 不得删别人数据')
    assert.equal(existsSync(join(dir, 'tool-outputs')), false)
    assert.equal(existsSync(join(dir, 'images')), false)
    assert.equal(existsSync(join(dir, 'documents')), false)
  })

  it('canWrite 是实时谓词：资格恢复后写入照常落盘', async () => {
    let canWrite = false
    const p = new FileSessionPersistence(DIR, { canWrite: () => canWrite })
    p.appendEvent('s1', ev(1))
    await sleep(200)
    assert.equal(existsSync(join(DIR, 's1', 'events.jsonl')), false)

    canWrite = true
    p.appendEvent('s1', ev(2, 'user'))
    await p.flushAllAsync(1_000)

    const lines = readFileSync(join(DIR, 's1', 'events.jsonl'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 1, '撤销期间的事件已丢弃；恢复后只有新事件落盘')
    assert.equal(JSON.parse(lines[0]!).seq, 2)
  })

  it('缺省不注入 canWrite：一切写入照常（兼容存量调用方）', async () => {
    const p = new FileSessionPersistence(DIR)
    p.appendEvent('s1', ev(1, 'user'))
    p.saveRecord(record('s1'))
    await p.flushAllAsync(1_000)
    assert.equal(existsSync(join(DIR, 's1', 'events.jsonl')), true)
    assert.equal(existsSync(join(DIR, 's1', 'index.json')), true)
  })
})
