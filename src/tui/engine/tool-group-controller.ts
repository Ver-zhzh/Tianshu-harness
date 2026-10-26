import { CollapsedReadSearchBuffer, isCollapsibleTool, type CollapsedReadSearchEntry, type CollapsedReadSearchGroup } from '../format/collapsed-read-search.js'
import { CollapsedBashBuffer, type CollapsedBashGroup } from '../format/collapsed-bash.js'
import { collapsedProcessToolCount, type CollapsedProcessGroup, type CollapsedProcessSegment } from '../format/collapsed-process.js'
import { capToolAccumulator, TOOL_ACCUMULATOR_MAX_BYTES } from './tool-accumulator.js'

export interface PendingToolMeta {
  name: string
  input: Record<string, unknown>
  startMs: number
  _approvalMode?: string
}

export interface TruncatedToolInfo {
  toolName: string
  content: string
  isError: boolean
  rawPath?: string
  toolInput?: Record<string, unknown>
}

export type ToolDetailTarget =
  | { kind: 'read-search'; group: CollapsedReadSearchGroup; active: boolean }
  | { kind: 'bash'; group: CollapsedBashGroup; active: boolean }
  | { kind: 'process'; group: CollapsedProcessGroup; active: false }
  | { kind: 'tool'; tool: TruncatedToolInfo; active: false }

/**
 * Tool lifecycle state manager extracted from TuiApp (W-B1). Commit/render
 * decisions stay in TuiApp; this class manages buffers, metadata and detail recency.
 */
export class ToolGroupController {
  private toolAccumulator = new Map<string, string>()
  private pendingTools = new Map<string, PendingToolMeta>()
  private lastTruncatedTool: TruncatedToolInfo | null = null
  private lastCollapsedGroup: CollapsedReadSearchGroup | null = null
  private toolGroupBuffer = new CollapsedReadSearchBuffer()
  private bashGroupBuffer = new CollapsedBashBuffer()
  private lastCollapsedBashGroup: CollapsedBashGroup | null = null
  private processReadGroups: CollapsedReadSearchGroup[] = []
  private processBashGroups: CollapsedBashGroup[] = []
  private processGroups: CollapsedProcessSegment[] = []
  private processStartMs = 0
  private lastCollapsedProcess: CollapsedProcessGroup | null = null
  private detailSequence = 0
  private lastTruncatedToolSequence = 0
  private lastCollapsedGroupSequence = 0
  private lastCollapsedBashGroupSequence = 0
  private lastCollapsedProcessSequence = 0
  private activeGroupSequence = 0
  private activeBashGroupSequence = 0
  private openedActiveGroupSequence = 0
  private openedActiveBashGroupSequence = 0

  // ── pendingTools ──
  setPending(id: string, meta: PendingToolMeta): void {
    this.pendingTools.set(id, meta)
  }

  getPending(id: string): PendingToolMeta | undefined {
    return this.pendingTools.get(id)
  }

  deletePending(id: string): PendingToolMeta | undefined {
    const meta = this.pendingTools.get(id)
    this.pendingTools.delete(id)
    return meta
  }

  getPendingEntries(): IterableIterator<[string, PendingToolMeta]> {
    return this.pendingTools.entries()
  }

  getPendingSize(): number {
    return this.pendingTools.size
  }

  /** Iterate pending tools that are delegation-type */
  getDelegationPending(): [string, PendingToolMeta][] {
    return [...this.pendingTools.entries()].filter(([, meta]) => {
      // Lazy import to avoid circular — isDelegationTool is a pure filter
      return meta._approvalMode !== undefined || meta.name.startsWith('delegate') || meta.name === 'team_orchestrate'
    })
  }

  // ── toolAccumulator ──
  accumulate(id: string, chunk: string): void {
    const prev = this.toolAccumulator.get(id) ?? ''
    this.toolAccumulator.set(id, capToolAccumulator(prev + chunk, TOOL_ACCUMULATOR_MAX_BYTES))
  }

  getAccumulated(id: string): string | undefined {
    return this.toolAccumulator.get(id)
  }

  deleteAccumulated(id: string): string | undefined {
    const acc = this.toolAccumulator.get(id)
    this.toolAccumulator.delete(id)
    return acc
  }

  private nextDetailSequence(): number {
    return ++this.detailSequence
  }

  stageProcessReadGroup(group: CollapsedReadSearchGroup): void {
    if (!group.entries.some(entry => entry.completed)) return
    this.processReadGroups.push(group)
    this.processGroups.push({ kind: 'read-search', group })
    this.processStartMs = this.processStartMs ? Math.min(this.processStartMs, group.startMs) : group.startMs
    this.publishProcessDetail()
  }

  stageProcessBashGroup(group: CollapsedBashGroup): void {
    if (!group.entries.some(entry => entry.completed)) return
    this.processBashGroups.push(group)
    this.processGroups.push({ kind: 'bash', group })
    this.processStartMs = this.processStartMs ? Math.min(this.processStartMs, group.startMs) : group.startMs
    this.publishProcessDetail()
  }

  private processSnapshot(): CollapsedProcessGroup | null {
    const process = {
      readGroups: [...this.processReadGroups],
      bashGroups: [...this.processBashGroups],
      orderedGroups: [...this.processGroups],
      startMs: this.processStartMs,
    }
    return collapsedProcessToolCount(process) > 0 ? process : null
  }

  private publishProcessDetail(): void {
    const process = this.processSnapshot()
    if (!process) return
    this.lastCollapsedProcess = process
    this.lastCollapsedProcessSequence = this.nextDetailSequence()
  }

  commitProcess(): CollapsedProcessGroup | null {
    const process = this.processSnapshot()
    this.processReadGroups = []
    this.processBashGroups = []
    this.processGroups = []
    this.processStartMs = 0
    if (process) {
      this.lastCollapsedProcess = process
      this.lastCollapsedProcessSequence = this.nextDetailSequence()
    }
    return process
  }

  // ── toolGroupBuffer ──
  pushUse(id: string, name: string, input: Record<string, unknown>): void {
    if (!isCollapsibleTool(name)) return
    this.toolGroupBuffer.pushUse(id, name, input)
    this.activeGroupSequence = this.nextDetailSequence()
  }

  isActiveGroup(): boolean {
    return this.toolGroupBuffer.isActive()
  }

  getActiveGroup(): CollapsedReadSearchGroup | null {
    return this.toolGroupBuffer.getActive()
  }

  flushGroup(): CollapsedReadSearchGroup | null {
    const group = this.toolGroupBuffer.flush()
    this.activeGroupSequence = 0
    this.openedActiveGroupSequence = 0
    if (group) {
      this.lastCollapsedGroup = group
      this.lastCollapsedGroupSequence = this.nextDetailSequence()
    }
    return group
  }

  /** 绑定 terminal result；返回值即「绑上了没」——null 表示组里查无此人，调用方必须处理 */
  attachResult(id: string, content: string, isError: boolean, rawPath?: string): CollapsedReadSearchEntry | null {
    const entry = this.toolGroupBuffer.attachResult(id, content, isError, rawPath)
    if (entry) this.activeGroupSequence = this.nextDetailSequence()
    return entry
  }

  /** 活跃组里是否已有该 id（「有活跃组」≠「当前 id 在组里」） */
  hasGroupEntry(id: string): boolean {
    return this.toolGroupBuffer.hasEntry(id)
  }

  // ── bashGroupBuffer ──
  pushBashUse(id: string, command: string, startMs: number): void {
    this.bashGroupBuffer.pushUse(id, command, startMs)
    this.activeBashGroupSequence = this.nextDetailSequence()
  }

  isActiveBashGroup(): boolean {
    return this.bashGroupBuffer.isActive()
  }

  getActiveBashGroup(): CollapsedBashGroup | null {
    return this.bashGroupBuffer.getActive()
  }

  flushBashGroup(): CollapsedBashGroup | null {
    const group = this.bashGroupBuffer.flush()
    this.activeBashGroupSequence = 0
    this.openedActiveBashGroupSequence = 0
    if (group) {
      this.lastCollapsedBashGroup = group
      this.lastCollapsedBashGroupSequence = this.nextDetailSequence()
    }
    return group
  }

  attachBashResult(id: string, content: string, isError: boolean, rawPath?: string): void {
    const entry = this.bashGroupBuffer.attachResult(id, content, isError, rawPath)
    if (entry) this.activeBashGroupSequence = this.nextDetailSequence()
  }

  hasBashEntry(id: string): boolean {
    return this.bashGroupBuffer.hasEntry(id)
  }

  detachBashEntry(id: string): import('../format/collapsed-bash.js').CollapsedBashEntry | null {
    const entry = this.bashGroupBuffer.detachEntry(id)
    if (entry && this.isActiveBashGroup()) this.activeBashGroupSequence = this.nextDetailSequence()
    else if (entry) {
      this.activeBashGroupSequence = 0
      this.openedActiveBashGroupSequence = 0
    }
    return entry
  }

  // ── lastCollapsedGroup ──
  getLastCollapsedGroup(): CollapsedReadSearchGroup | null {
    return this.lastCollapsedGroup
  }

  clearLastCollapsedGroup(): void {
    this.lastCollapsedGroup = null
    this.lastCollapsedGroupSequence = 0
  }

  // ── lastCollapsedBashGroup ──
  getLastCollapsedBashGroup(): CollapsedBashGroup | null {
    return this.lastCollapsedBashGroup
  }

  clearLastCollapsedBashGroup(): void {
    this.lastCollapsedBashGroup = null
    this.lastCollapsedBashGroupSequence = 0
  }

  // ── lastTruncatedTool ──
  setLastTruncatedTool(info: TruncatedToolInfo): void {
    this.lastTruncatedTool = info
    this.lastTruncatedToolSequence = this.nextDetailSequence()
  }

  getLastTruncatedTool(): TruncatedToolInfo | null {
    return this.lastTruncatedTool
  }

  clearLastTruncatedTool(): void {
    this.lastTruncatedTool = null
    this.lastTruncatedToolSequence = 0
  }

  clearLastCollapsedProcess(): void {
    this.lastCollapsedProcess = null
    this.lastCollapsedProcessSequence = 0
  }

  /** Consume the current detail target. Active groups stay live; only their opened snapshot is consumed. */
  takeLatestToolDetail(): ToolDetailTarget | null {
    const activeGroup = this.getActiveGroup()
    const activeBashGroup = this.getActiveBashGroup()
    const groupSequence = activeGroup && this.activeGroupSequence > this.openedActiveGroupSequence ? this.activeGroupSequence : 0
    const bashSequence = activeBashGroup && this.activeBashGroupSequence > this.openedActiveBashGroupSequence ? this.activeBashGroupSequence : 0
    if (groupSequence > 0 || bashSequence > 0) {
      if (activeGroup && groupSequence >= bashSequence) {
        this.openedActiveGroupSequence = groupSequence
        return { kind: 'read-search', group: activeGroup, active: true }
      }
      if (activeBashGroup) {
        this.openedActiveBashGroupSequence = bashSequence
        return { kind: 'bash', group: activeBashGroup, active: true }
      }
    }

    const latest = Math.max(this.lastCollapsedGroupSequence, this.lastCollapsedBashGroupSequence, this.lastCollapsedProcessSequence, this.lastTruncatedToolSequence)
    if (latest === 0) return null
    if (latest === this.lastTruncatedToolSequence && this.lastTruncatedTool) {
      const tool = this.lastTruncatedTool
      this.clearLastTruncatedTool()
      return { kind: 'tool', tool, active: false }
    }
    if (latest === this.lastCollapsedProcessSequence && this.lastCollapsedProcess) {
      const process = this.lastCollapsedProcess
      this.clearLastCollapsedProcess()
      if (this.lastCollapsedGroup && process.readGroups.includes(this.lastCollapsedGroup)) this.clearLastCollapsedGroup()
      if (this.lastCollapsedBashGroup && process.bashGroups.includes(this.lastCollapsedBashGroup)) this.clearLastCollapsedBashGroup()
      return { kind: 'process', group: process, active: false }
    }
    if (latest === this.lastCollapsedBashGroupSequence && this.lastCollapsedBashGroup) {
      const group = this.lastCollapsedBashGroup
      this.clearLastCollapsedBashGroup()
      return { kind: 'bash', group, active: false }
    }
    if (this.lastCollapsedGroup) {
      const group = this.lastCollapsedGroup
      this.clearLastCollapsedGroup()
      return { kind: 'read-search', group, active: false }
    }
    return null
  }

  // ── bulk lifecycle ──
  clear(): void {
    this.pendingTools.clear()
    this.toolAccumulator.clear()
  }
}
