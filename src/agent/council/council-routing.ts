// 议事会席位多模型路由 —— 纯函数 + append-only shadow。
// 铁律：routeCouncilSeat 零 I/O、零 Date，给定输入输出唯一。
// shadow 记录本身仍是旁路（绝不影响派发）；但瑶光门（tierHint+noDowngrade）
// 的路由结果经 council-orchestrator 的 seatTierFloor 接线到真实派发，
// 作为 WorkOrder.tierFloor 下限生效（事故链缺口 1 修复）。

import { recommendModelTier, type ModelTier, type ModelRiskTier } from '../model-tier-policy.js'

/** 议事会席位 —— 权能 + 章程 + 路由偏好。 */
export interface CouncilSeat {
  /** 星域权能 id（tianquan/tianfu/tianxuan/...），驱动 authority→tier 升级。 */
  authority: string
  /** 席位章程简述（注入 objective，可缺）。 */
  charter?: string
  /** 期望 tier 提示。无 noDowngrade 时仅作 shadow 记录，不改判。 */
  tierHint?: ModelTier
  /** 瑶光门：true 时把 tierHint 升格为硬地板，final tier 不得低于它。 */
  noDowngrade?: boolean
  /** 席位专属 provider（须在 config.provider.providers 中存在）。与 model 同时
   *  设置时,该席位 worker 跑在独立 provider/model 上(独立服务端缓存),实现
   *  异构议事会(如天权用 DeepSeek Pro、天府用 GLM)。缺失/无凭据时静默回退会话模型。 */
  provider?: string
  /** 席位专属 model（须在 provider 的 models 列表中）。需与 provider 同时设置。 */
  model?: string
  keyId?: string
  modelStrategy?: 'session' | 'auto'
}

/** 缺省席位 —— 天权领航 · 天府护栏 · 天璇探索。调用方可经 seats 覆盖。
 *  置于路由层（CouncilSeat 定义所在）以便工具层与 workflow 层共享，避免
 *  workflow → tools 反向依赖。 */
export const DEFAULT_COUNCIL_SEATS: readonly CouncilSeat[] = [
  { authority: 'tianquan', charter: '领航：把握方向与优先级' },
  { authority: 'tianfu', charter: '护栏：风险、边界与安全', tierHint: 'strong', noDowngrade: true },
  { authority: 'tianxuan', charter: '探索：方案空间与替代路径' },
]

// ── 三柱对抗拓扑（织命议事会 Phase 2）─────────────────────────────────────
// 卡巴拉结构机制：扩张与约束必须分属独立席位，禁止同席「又给又砍」；
// 平衡柱是第三算子（合成裁决），不是折中平均。

export type CouncilPillar = 'expansion' | 'constraint' | 'balance'

/** 星域 → 柱归属。未列出的 authority（自定义域）不参与柱级检测。 */
const PILLAR_OF_AUTHORITY: Record<string, CouncilPillar> = {
  // 扩张柱：激进方案、空位方案、前提质疑
  pojun: 'expansion',
  tianji: 'expansion',
  tianxuan: 'expansion',
  // 约束柱：风险称量、边界防守、变更守护
  tianquan: 'constraint',
  huagai: 'constraint',
  tianfu: 'constraint',
  tianliang: 'constraint',
  // 七杀只减不加，是最纯粹的约束算子——同席「又给又砍」的禁令对它天然成立。
  // 不进默认席位，仅在用户显式配置 qisha 席时按约束柱参与柱级检测。
  qisha: 'constraint',
  // 平衡柱：合成裁决（唯一）
  yaoguang: 'balance',
}

export function pillarOf(authority: string): CouncilPillar | undefined {
  return PILLAR_OF_AUTHORITY[authority]
}

/** 三柱旗舰席位（council max，`pillars:true` 启用）——制度化对抗结构：
 *  扩张柱（破军激进 + 天机质疑）× 约束柱（天权称量 + 华盖否决）× 平衡柱（瑶光合成）。
 *  约束柱与平衡柱带瑶光门（strong 硬地板）：否决与合成的质量不容降档。 */
export const THREE_PILLAR_COUNCIL_SEATS: readonly CouncilSeat[] = [
  { authority: 'pojun', charter: '扩张柱·锋刃：给出最大杠杆的激进方案与被主流忽视的空位方案，宁可激进后被砍，不可平庸。' },
  { authority: 'tianji', charter: '扩张柱·天机：质疑草案的隐含前提，给出替代路径；每条质疑附可验证依据。' },
  { authority: 'tianquan', charter: '约束柱·称量：架构层次、优先级与代价称量；对过度设计与范围膨胀提出 challenge。', tierHint: 'strong', noDowngrade: true },
  { authority: 'huagai', charter: '约束柱·华盖：边界防守与否决审查——发现不可接受的风险时发 blocking challenge（附具体依据与化解条件），并为关键断言声明 gate 验收命令。', tierHint: 'strong', noDowngrade: true },
  { authority: 'yaoguang', charter: '平衡柱·瑶光：合成裁决——产出「扩张与约束双方仍有效」的单一方案，禁止两边各砍一半的折中平均；为最终方案声明验收 gate。', tierHint: 'strong', noDowngrade: true },
]

/** 配置席位按 authority 覆盖三柱席的 provider/model/tierHint（异构模型接线）：
 *  用户在 agent.council.seats 里给某星域配了专属模型时，pillars 模式沿用该绑定。
 *  未匹配的配置席忽略；柱席章程与结构不受覆盖影响。 */
export function mergeSeatOverrides(
  pillarSeats: readonly CouncilSeat[],
  overrides: readonly CouncilSeat[],
): CouncilSeat[] {
  return pillarSeats.map(seat => {
    const o = overrides.find(x => x.authority === seat.authority)
    if (!o) return { ...seat }
    return {
      ...seat,
      ...(o.tierHint ? { tierHint: o.tierHint } : {}),
      ...(o.noDowngrade !== undefined ? { noDowngrade: o.noDowngrade } : {}),
      ...(o.provider && o.model ? { provider: o.provider, model: o.model } : {}),
    }
  })
}

export interface CouncilSeatRoute {
  authority: string
  /** 最终生效 tier。 */
  tier: ModelTier
  /** policy 依 authority/riskTier 给出的推荐 tier。 */
  recommendedTier: ModelTier
  /** policy 硬地板（天府/天璇高风险护栏），始终强制。 */
  hardFloor?: ModelTier
  /** 是否因 noDowngrade+tierHint 触发瑶光门抬升。 */
  gated: boolean
  reason: string
}

export interface RouteCouncilSeatOpts {
  riskTier?: ModelRiskTier
  objective?: string
}

const TIER_ORDER: Record<ModelTier, number> = { cheap: 0, balanced: 1, strong: 2 }

/** 取更高 tier（瑶光门只抬升、绝不降级推荐 tier）。 */
function maxTier(a: ModelTier, b: ModelTier): ModelTier {
  return TIER_ORDER[a] >= TIER_ORDER[b] ? a : b
}

/**
 * 席位路由：用 council_expert profile（无 tierLock）走 authority→tier 升级路径，
 * 叠加 policy hardFloor 与瑶光门 noDowngrade 硬地板。
 *
 * 瑶光门语义：noDowngrade=true 时 tierHint 是「不得低于」的硬地板；
 * noDowngrade 缺省时 tierHint 仅作 shadow 记录，不改判（议事会绝不自动降级
 * 推荐 tier —— 宁可贵，不可错）。
 */
export function routeCouncilSeat(seat: CouncilSeat, opts?: RouteCouncilSeatOpts): CouncilSeatRoute {
  const rec = recommendModelTier({
    profile: 'council_expert',
    authority: seat.authority,
    kind: 'plan',
    ...(opts?.riskTier ? { riskTier: opts.riskTier } : {}),
    objective: opts?.objective ?? `${seat.authority} council seat`,
  })

  let tier = rec.tier
  if (rec.hardFloor) tier = maxTier(tier, rec.hardFloor)

  const gated = Boolean(seat.noDowngrade && seat.tierHint)
  if (gated) tier = maxTier(tier, seat.tierHint!)

  const reason = gated
    ? `瑶光门: tier=max(recommended ${rec.tier}${rec.hardFloor ? `, floor ${rec.hardFloor}` : ''}, hint ${seat.tierHint})`
    : rec.reason

  return {
    authority: seat.authority,
    tier,
    recommendedTier: rec.tier,
    ...(rec.hardFloor ? { hardFloor: rec.hardFloor } : {}),
    gated,
    reason,
  }
}

export interface CouncilRoutingShadowEvent {
  schemaVersion: 1
  sessionId: string
  objectiveHash: string
  seat: string
  recommendedTier: ModelTier
  finalTier: ModelTier
  hardFloor?: ModelTier
  gated: boolean
  reason: string
  timestamp: number
}

export interface CouncilRoutingShadowStore {
  saveBanditState(kind: string, json: string): void
}

/** append-only key —— 含 seat+timestamp，保证同 objective 多席多次会诊不互相覆盖
 *  (saveBanditState 是 ON CONFLICT(kind) UPSERT)。 */
export function councilRoutingShadowKind(
  e: Pick<CouncilRoutingShadowEvent, 'sessionId' | 'objectiveHash' | 'seat' | 'timestamp'>,
): string {
  return `council_routing_shadow:${e.sessionId}:${e.objectiveHash}:${e.seat}:${e.timestamp}`
}

export interface BuildCouncilRoutingShadowInput {
  sessionId: string
  objectiveHash: string
  route: CouncilSeatRoute
  timestamp: number
}

export function buildCouncilRoutingShadow(input: BuildCouncilRoutingShadowInput): CouncilRoutingShadowEvent {
  return {
    schemaVersion: 1,
    sessionId: input.sessionId,
    objectiveHash: input.objectiveHash,
    seat: input.route.authority,
    recommendedTier: input.route.recommendedTier,
    finalTier: input.route.tier,
    ...(input.route.hardFloor ? { hardFloor: input.route.hardFloor } : {}),
    gated: input.route.gated,
    reason: input.route.reason,
    timestamp: input.timestamp,
  }
}

export function persistCouncilRoutingShadow(
  store: CouncilRoutingShadowStore | undefined | null,
  event: CouncilRoutingShadowEvent,
): void {
  if (!store) return
  try {
    store.saveBanditState(councilRoutingShadowKind(event), JSON.stringify(event))
  } catch {
    // shadow 遥测绝不影响会诊派发。
  }
}
