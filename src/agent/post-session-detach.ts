/**
 * 后台串行链（中止路径的 postSession 收尾专用，见 AgentLoop.schedulePostSessionDetached）。
 *
 * Stop 之后 agent loop 不再等 postSession hooks（telemetry / memory / consolidation
 * 等，含 LLM 侧路，串行可达数秒）跑完才 settle——对齐 Codex 的 async hook +
 * 下一轮 drain。链保证：① 调度同步返回；② 任务按调度顺序执行，不并发；
 * ③ 单任务 reject 被吞（收尾是尽力而为，不能反向炸下一轮）；④ drain 给
 * 进程关停一个有界的收口点。
 */
export class DetachedRunner {
  private chain: Promise<void> = Promise.resolve()
  private pending = 0

  /** 排入一个后台任务；同步返回。 */
  schedule(task: () => Promise<void> | void): Promise<void> {
    this.pending++
    const result = this.chain.then(() => task())
    this.chain = result
      .catch(() => { /* best-effort: 收尾失败不外溢 */ })
      .finally(() => { this.pending-- })
    return result
  }

  /** 在途（含排队）任务数。 */
  get inFlight(): number { return this.pending }

  /** 等链空；超时返回 false（不打断任务本身）。 */
  async drain(timeoutMs: number): Promise<boolean> {
    if (this.pending === 0) return true
    let timer: ReturnType<typeof setTimeout> | undefined
    const settled = await Promise.race([
      this.chain.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs) }),
    ])
    if (timer) clearTimeout(timer)
    return settled && this.pending === 0
  }
}
