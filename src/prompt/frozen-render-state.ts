import { FrozenAnchors, type FrozenAnchor } from './frozen-anchors.js'
import type { FrozenSnapshotData } from './frozen-snapshot.js'
import { proveRewindHistory, LocalWorkerPolicyError } from '../api/continuation-prefix.js'
import { wireOaiMessage, type OaiMessage } from '../api/oai-types.js'

export interface FrozenRenderCandidate {
  revision: number
  epoch: number
  snapshot: FrozenSnapshotData
}

/** Only publication can replace the durable render. Builds own independent drafts. */
export class FrozenRenderState {
  private committed?: FrozenSnapshotData
  private anchors = new FrozenAnchors()
  private anchorIndex = new Map<string, FrozenAnchor>()
  private revision = 0
  private publishedRevision = 0
  private epoch = 0
  get buildRevision(): number { return this.revision }
  private commits: Promise<void> = Promise.resolve()
  restore(snapshot: FrozenSnapshotData): void {
    this.committed = structuredClone(snapshot)
    this.anchors = new FrozenAnchors(this.committed.anchors)
    this.anchorIndex = new Map(this.committed.anchors?.map(anchor => [anchor.key, anchor]))
  }
  reset(): void { this.epoch++; this.committed = undefined; this.anchors = new FrozenAnchors(); this.anchorIndex.clear(); this.publishedRevision = 0 }
  export(): FrozenSnapshotData | undefined {
    return this.committed ? { ...structuredClone(this.committed), executionSnapshot: this.committed.executionSnapshot } : undefined
  }
  capture(snapshot: FrozenSnapshotData, renderedHistory: FrozenSnapshotData['renderedHistory']): FrozenRenderCandidate {
    return { revision: ++this.revision, epoch: this.epoch, snapshot: { ...structuredClone(snapshot), renderedHistory } }
  }
  validate(candidate: FrozenRenderCandidate): void {
    if (candidate.epoch !== this.epoch || candidate.revision < this.publishedRevision) {
      throw new LocalWorkerPolicyError('冻结构建已过期；请求未发送')
    }
  }
  publish(candidate: FrozenRenderCandidate, snapshot: FrozenSnapshotData): void {
    this.validate(candidate)
    this.publishedRevision = candidate.revision
    this.restore(snapshot)
    this.committed!.executionSnapshot = snapshot.executionSnapshot
  }
  anchor(key: string) { return this.anchorIndex.get(key) }
  comparePublishedRender(history: NonNullable<FrozenSnapshotData['renderedHistory']>): import('../api/continuation-prefix.js').PrefixComparison {
    const prior = this.committed?.renderedHistory
    return !prior ? 'unknown' : prior.some((entry, index) => history[index]?.hash !== entry.hash) ? 'changed' : 'same'
  }
  *publishedPrefixes(): IterableIterator<string> {
    for (const anchor of this.committed?.anchors ?? []) yield anchor.prefix
  }
  commit(candidate: FrozenRenderCandidate, snapshot: FrozenSnapshotData, durable: ((snapshot: FrozenSnapshotData) => Promise<void>) | undefined, finish: () => void): void | Promise<void> {
    const publish = () => { this.publish(candidate, snapshot); finish() }
    if (!durable) { publish(); return }
    const commit = this.commits.then(async () => {
      this.validate(candidate)
      await durable(snapshot)
      publish()
    })
    this.commits = commit.catch(() => {})
    return commit
  }
  render(key: string, message: OaiMessage, sourceIndex: number): OaiMessage['content'] {
    const snapshot = this.committed!
    const anchored = this.anchors.render(key, message)
    const expected = snapshot.renderedHistory?.[sourceIndex + 1]?.hash
    const matches = (content: OaiMessage['content'], hash = expected): boolean => !!hash
      && proveRewindHistory([wireOaiMessage({ role: 'user', content } as OaiMessage)])[0]!.hash === hash
    if (anchored !== undefined) {
      if (expected && !matches(anchored)) throw new LocalWorkerPolicyError('已发布锚点与冻结投影不一致；需要显式修复前缀')
      return anchored
    }
    const occurrence = Number(key.slice(key.lastIndexOf(':') + 1))
    const text = typeof message.content === 'string' ? message.content : undefined
    const legacy = text === undefined ? undefined : new Map(snapshot.frozenUserMerged).get(text)?.[occurrence]
    const pending = text === undefined ? undefined : new Map(snapshot.frozenPendingMerged).get(text)
    const hash = expected ?? snapshot.executionSnapshot?.canonicalSource?.[sourceIndex + 1]
      ?? snapshot.executionSnapshot?.messages[sourceIndex + 1]?.hash
    for (const candidate of [legacy, pending]) if (candidate !== undefined && matches(candidate, hash)) return candidate
    throw new LocalWorkerPolicyError('已发布锚点缺失且无法核对原始字节；需要显式修复前缀')
  }
  protects(key: string, sourceIndex: number): boolean {
    const snapshot = this.committed
    return !!snapshot?.executionSnapshot && (snapshot.publishedHistory
      ? sourceIndex < snapshot.publishedHistory.length : snapshot.userKeys?.includes(key) === true)
  }
}
