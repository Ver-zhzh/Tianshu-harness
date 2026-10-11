import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createVolatileSnapshot, createVolatileSnapshotFresh } from '../volatile-snapshot.js'
import { createGitStatusCache } from '../volatile-git.js'

/**
 * 冻结新鲜度不变量（2026-10-11 注入快照滞后事故）：
 * createVolatileSnapshot 用 gitStatusCache.get()（同步、不查 TTL）冻结 gitStatus——
 * 常驻进程（桌面 sidecar）空闲后新建会话会把上次缓存值（可任意旧、且可能落在
 * detached HEAD 等异常窗口）原样冻进会话首屏，且首 2 条用户消息无解冻路径
 * （engine.ts userMessagesSinceGitRefresh >= 3 才触发 refreshGit）。
 * 修复形态：冻结的 git 快照要么新鲜（≤TTL）要么不存在，绝不冻结陈旧值。
 */

describe('createVolatileSnapshotFresh — git 快照新鲜度不变量', () => {
  function makeCache(initialAgeMs: number) {
    const cache = createGitStatusCache({
      ttlMs: 30_000,
      now: () => 100_000,
      load: async () => 'loaded-status',
    })
    cache.prime('/repo', 'stale-value', 100_000 - initialAgeMs)
    return cache
  }

  it('RED 复现：陈旧缓存不得被冻结进快照（旧实现返回 stale-value → 红）', () => {
    const cache = makeCache(10 * 60_000) // 10 分钟前 prime 的值，远超 30s TTL

    const snap = createVolatileSnapshotFresh({ cwd: '/repo', gitCache: cache })

    // 不变量：冻结值要么新鲜要么不存在。陈旧 → undefined，交由轮边界
    // refreshIfStale + volatile.ts:719 的 cache.get 回落路径在首轮注入新值。
    assert.equal(snap.gitStatus, undefined)
  })

  it('新鲜缓存照常冻结', () => {
    const cache = makeCache(5_000) // 5 秒前 prime，TTL 内

    const snap = createVolatileSnapshotFresh({ cwd: '/repo', gitCache: cache })

    assert.equal(snap.gitStatus, 'stale-value')
  })

  it('空缓存（冷进程）行为不变：undefined', () => {
    const cache = createGitStatusCache({
      ttlMs: 30_000,
      now: () => 100_000,
      load: async () => 'loaded-status',
    })
    const snap = createVolatileSnapshotFresh({ cwd: '/repo', gitCache: cache })
    assert.equal(snap.gitStatus, undefined)
  })

  it('显式 getGitStatus 覆盖不受影响（测试/worker 语义保留）', () => {
    const cache = makeCache(10 * 60_000)
    const snap = createVolatileSnapshotFresh({ cwd: '/repo', gitCache: cache, getGitStatus: () => 'explicit' })
    assert.equal(snap.gitStatus, 'explicit')
  })
})
