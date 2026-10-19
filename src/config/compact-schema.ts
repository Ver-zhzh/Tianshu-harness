import { z } from 'zod'

export const compactSchema = z.object({
  /** Master switch for discretionary compaction (ratio tiers, 1M LLM compact).
   *  Emergency paths (session split, 95% ceiling) ignore this. */
  enabled: z.boolean().default(true),
  /** @deprecated Superseded by ratio-based policy (compactPolicyRatios).
   *  Retained for config compatibility; not read by the runtime. */
  autoThreshold: z.number().int().positive().default(800_000),
  /** @deprecated Superseded by ratio-based policy (compactPolicyRatios).
   *  Retained for config compatibility; not read by the runtime. */
  autoFloor: z.number().int().positive().default(500_000),
  /** Model that performs the compaction summarization (LLM compact / partial
   *  compact). When the model exists on the primary (or any configured)
   *  provider, a dedicated cheap client is built even if `provider` is unset
   *  — see resolveCompactProviderName(). Pair with `provider` to force a
   *  specific host. Without a resolvable provider+credentials, compaction
   *  uses the session's primary model (backward compatible). */
  model: z.string().default('deepseek-flash'),
  /** Provider hosting the compaction model (must exist in provider.providers).
   *  Optional: when omitted, the runtime infers a provider that lists `model`
   *  (preferring the session primary). Set explicitly to pin compaction onto
   *  an isolated cheap model. Unknown provider / missing model / no
   *  credentials → silent fallback to the session primary. */
  provider: z.string().optional(),
  /** T9 turn-0 quality-compaction trigger ratios (provider cost-aware).
   *  Only the turn-0, phase-gated quality lever — mid-turn delay guards are
   *  unaffected. Per-token cache-preserving providers (DeepSeek) skip T9
   *  entirely regardless of these. */
  qualityCompact: z.object({
    /** Context ratio to trigger T9 on per-token providers (e.g. openai). */
    perTokenThreshold: z.number().min(0).max(1).default(0.55),
    /** Leaner ratio for cost-insensitive subscription providers (GLM/MiMo/Codex/Claude). */
    subscriptionThreshold: z.number().min(0).max(1).default(0.45),
    /** Ceiling ratio that fires T9 for subscription providers even with no phase transition. */
    subscriptionCeiling: z.number().min(0).max(1).default(0.6),
  }).default({}),
})
