/**
 * Discipline Eligibility — 统一资格推导层
 *
 * 从 TurnMode（连续性分类）+ IntentTaskKind（语义分类）+ TaskContract + 明示约束
 * 生成统一的 DisciplineEligibility，消除下游各自解释 isActionable 的碎片化。
 *
 * 架构约定：
 * - TurnMode 负责会话连续性（chat / followUp / task），不负责任务语义。
 * - IntentTaskKind 负责语义分类，复用现有 intent router，不新建分类器。
 * - 本模块是纯推导层：输入 → 资格对象，无副作用，不调用 LLM。
 *
 * 安全相关类型（security_safety）保持独立的 fail-closed 安全门控，
 * 不受 requiresEngineeringDiscipline / requiresCodeVerification 控制。
 */

import type { IntentTaskKind } from './intent-retrieval-route.js'
import type { TurnMode, ProjectionMode } from '../context/task-contract.js'
import { debugLog } from '../utils/debug.js'

// ── 类型定义 ──────────────────────────────────────────────────

export type { ProjectionMode }

export interface DisciplineEligibility {
  /** 本轮是否需要回应（非 social_idle） */
  responseActionable: boolean
  /** 是否需要工程纪律（TDD / delivery / verification 门控） */
  requiresEngineeringDiscipline: boolean
  /** 是否需要代码验证（写测试 / RED→GREEN） */
  requiresCodeVerification: boolean
  /** 是否允许证据审查（verification / audit 的 evidence projection） */
  allowsEvidenceReview: boolean
  /** 是否可建议进入 plan mode */
  canSuggestPlan: boolean
  /** 是否可派发 worker */
  canDispatch: boolean
  /** 认知投影模式 */
  projectionMode: ProjectionMode
}

export interface DisciplineEligibilityInput {
  turnMode: TurnMode
  taskKinds: readonly IntentTaskKind[]
  /** 用户原始输入中是否存在显式否定词（如"不要修改""只解释""只分析"） */
  explicitNoMutation?: boolean
  /** 本轮提到的代码文件数量——用于空 taskKinds 安全网：
   *  当 intent router 漏判但用户明确提到了代码文件时，
   *  保守升级为工程纪律，避免工程任务静默丢失 TDD。 */
  mentionedCodeFileCount?: number
  /** 输入含问题信号词（报错/不对/有问题/error/bug…）——空 taskKinds 安全网
   *  的次级触发：单文件 + 问题信号即升级工程纪律，覆盖"单文件 bug 报告"
   *  漏网窗口（纯提及文件的解释类输入无信号词，不误升级）。 */
  problemSignal?: boolean
}

// ── 语义分类 → 资格映射 ─────────────────────────────────────

/** 工程任务类型：需要代码修改和完整工程纪律（含 TDD / code verification） */
const ENGINEERING_KINDS: ReadonlySet<IntentTaskKind> = new Set([
  'bug_fix',
  'refactor',
  'new_feature',
])

/** 诊断分析类型：需要工程纪律但不需要强制写测试（可读重于写） */
const DIAGNOSIS_KIND: IntentTaskKind = 'performance_diagnosis'

/** 只读代码理解类型：允许仓库检索，不触发工程纪律 */
const READ_ONLY_KINDS: ReadonlySet<IntentTaskKind> = new Set([
  'code_explanation',
  'usage_question',
  'codebase_overview',
  'architecture_design',
])

/** 证据审查类型：允许 evidence projection，不默认要求新增测试 */
const EVIDENCE_KINDS: ReadonlySet<IntentTaskKind> = new Set([
  'review_audit',
  'verification',
])

/** 安全类型：独立 fail-closed 安全门控，不走通用工程纪律路径 */
const SECURITY_KIND: IntentTaskKind = 'security_safety'

/** 社交空闲类型 */
const SOCIAL_KIND: IntentTaskKind = 'social_idle'

// ── 推导函数 ──────────────────────────────────────────────────

/**
 * 从 TurnMode + IntentTaskKind 推导统一资格对象。
 *
 * 默认策略是保守减负而非工程升级：
 * - 没有明确代码变更目标时，requiresEngineeringDiscipline=false
 * - verification/review_audit 可进入 evidence projection，但不自动等同于新增代码测试
 * - security_safety 的安全门控单独保持 fail-closed
 * - explicitNoMutation 优先于文件提及和 task kind
 */
export function deriveDisciplineEligibility(
  input: DisciplineEligibilityInput,
): DisciplineEligibility {
  const { turnMode, taskKinds, explicitNoMutation = false } = input

  // chat → 全 false
  if (turnMode === 'chat') {
    return {
      responseActionable: false,
      requiresEngineeringDiscipline: false,
      requiresCodeVerification: false,
      allowsEvidenceReview: false,
      canSuggestPlan: false,
      canDispatch: false,
      projectionMode: 'none',
    }
  }

  // 确定主导语义类型
  // social_idle 和非空种类取交集：只要有任何非 social 种类就不是 social
  const nonSocialKinds = taskKinds.filter(k => k !== SOCIAL_KIND)
  const hasAnyKind = nonSocialKinds.length > 0

  // social_idle 或无种类
  // 安全网：当 intent router 漏判但用户提到了代码文件时，保守升级为工程
  // 纪律——不静默丢失 TDD。两级触发：≥2 文件直接升级；1 文件需问题信号词
  // （"看看 src/auth.ts 登录有点怪"类单文件 bug 报告不再漏网，而
  //  "解释 src/auth.ts" 无信号词，保持 light）。
  // 明示只读约束必须先于漏判兜底，不能因文件数或错误信号被升级。
  if (!hasAnyKind && !explicitNoMutation) {
    const fileCount = input.mentionedCodeFileCount ?? 0
    const hasCodeFiles = fileCount >= 2 || (fileCount >= 1 && input.problemSignal === true)
    return {
      responseActionable: true,
      requiresEngineeringDiscipline: hasCodeFiles,
      requiresCodeVerification: hasCodeFiles,
      allowsEvidenceReview: false,
      canSuggestPlan: hasCodeFiles,
      canDispatch: hasCodeFiles,
      projectionMode: hasCodeFiles ? 'engineering' : 'light',
    }
  }

  // 合并能力：种类组合时取并集而非只选第一个
  const hasEngineering = nonSocialKinds.some(k => ENGINEERING_KINDS.has(k))
  const hasDiagnosis = nonSocialKinds.includes(DIAGNOSIS_KIND)
  const hasSecurity = nonSocialKinds.includes(SECURITY_KIND)
  const hasEvidence = nonSocialKinds.some(k => EVIDENCE_KINDS.has(k))
  const hasReadOnly = nonSocialKinds.some(k => READ_ONLY_KINDS.has(k))

  // explicitNoMutation 优先：用户明确说"不要修改""只解释""只分析"
  // → 降级为只读分析，只保留 evidence review（如果是审查/验证类）
  if (explicitNoMutation) {
    return {
      responseActionable: true,
      requiresEngineeringDiscipline: false,
      requiresCodeVerification: false,
      allowsEvidenceReview: hasEvidence || hasSecurity,
      canSuggestPlan: false,
      canDispatch: false,
      projectionMode: hasEvidence || hasSecurity ? 'evidence' : 'light',
    }
  }

  // security_safety 与工程种类混合 → 工程 + evidence
  // 安全种类单独出现 → evidence only
  if (hasSecurity && !hasEngineering && !hasDiagnosis) {
    return {
      responseActionable: true,
      requiresEngineeringDiscipline: false,
      requiresCodeVerification: false,
      allowsEvidenceReview: true,
      canSuggestPlan: false,
      canDispatch: false,
      projectionMode: 'evidence',
    }
  }

  // 工程任务（含 security + engineering 混合）
  if (hasEngineering || hasDiagnosis) {
    return {
      responseActionable: true,
      requiresEngineeringDiscipline: true,
      requiresCodeVerification: hasEngineering, // diagnosis: engineering yes, code verification no
      allowsEvidenceReview: hasEvidence || hasSecurity,
      canSuggestPlan: true,
      canDispatch: !hasSecurity, // security 不自动派发 worker
      projectionMode: 'engineering',
    }
  }

  // 证据审查（含 review_audit 与只读种类混合）
  if (hasEvidence) {
    return {
      responseActionable: true,
      requiresEngineeringDiscipline: false,
      requiresCodeVerification: false,
      allowsEvidenceReview: true,
      canSuggestPlan: false,
      canDispatch: false,
      projectionMode: 'evidence',
    }
  }

  // 只读理解
  if (hasReadOnly) {
    return {
      responseActionable: true,
      requiresEngineeringDiscipline: false,
      requiresCodeVerification: false,
      allowsEvidenceReview: false,
      canSuggestPlan: false,
      canDispatch: false,
      projectionMode: 'light',
    }
  }

  // 兜底：低置信输入不升级为工程任务，保守降级为 light
  return {
    responseActionable: true,
    requiresEngineeringDiscipline: false,
    requiresCodeVerification: false,
    allowsEvidenceReview: false,
    canSuggestPlan: false,
    canDispatch: false,
    projectionMode: 'light',
  }
}

// ── 否定词检测 ────────────────────────────────────────────────

/**
 * 检测用户输入中是否包含显式否定词——用户明确说"不要修改""只解释""只分析"等。
 *
 * 输入样本（来自 src/agent/intent-sanitizer.ts 的 VERB_INTENT_MAP）：
 * - "解释 src/agent/loop.ts 的作用，不要修改"
 * - "只分析架构，不改代码"
 * - "看一下这个文件，不需要改"
 */
const EXPLICIT_NO_MUTATION_RE =
  /(?:不要修改|不改|别改|不需要改|不用改|只解释|只分析|只看|只读|仅解释|仅分析|explain only|read only|don'?t\s+(?:modify|change|edit|write|implement|fix|refactor)|no\s+(?:modification|changes|edits))/i

/**
 * 从用户输入中检测是否包含显式否定变异词。
 * 应优先于 task kind 推导，确保用户明确意图不被工程路径接管。
 */
export function detectExplicitNoMutation(userMessage: string): boolean {
  return EXPLICIT_NO_MUTATION_RE.test(userMessage.trim())
}

// ── 问题信号检测 ────────────────────────────────────────────────

/** 问题信号词：用户报告"有什么不对"的措辞。只用于空 taskKinds 安全网的
 *  次级触发，不做语义分类。保守取舍：不含"看看/检查/审查"等中性词。 */
const PROBLEM_SIGNAL_RE =
  /(?:报错|异常|错误|失败|崩溃|卡死|不对劲|不对|有问题|有点怪|不工作|不能用|无法|不生效|没生效|丢了|丢失|\berror\b|\bbug\b|\bfail(?:ed|ure|s)?\b|\bbroken\b|\bweird\b|\bwrong\b|\bcrash(?:ed|es)?\b)/i

/** 检测用户输入是否含问题信号（"有什么不对"的直觉报告）。 */
export function detectProblemSignal(userMessage: string): boolean {
  return PROBLEM_SIGNAL_RE.test(userMessage.trim())
}

// ── eligibility 缺省遥测 ────────────────────────────────────────

/** b853616a 移除 isActionable 回退后，消费方缺省 eligibility 即全 false
 *  （fail-closed）——这是设计选择，但缺省必须可观测：任何未接线的新
 *  消费点静默降级时，RIVET_DEBUG 下要能看到是谁在缺省。每 source
 *  每进程只报一次。返回 true 表示本次是新 source（测试用）。 */
const missingEligibilitySeen = new Set<string>()

export function noteEligibilityMissing(source: string): boolean {
  if (missingEligibilitySeen.has(source)) return false
  missingEligibilitySeen.add(source)
  debugLog(`[eligibility] consumer "${source}" ran without eligibility — defaulting to fail-closed (all false). Wire deriveDisciplineEligibility at this callsite.`)
  return true
}

/** Test-only: clear the once-per-source dedup set. */
export function __resetEligibilityMissingForTest(): void {
  missingEligibilitySeen.clear()
}
