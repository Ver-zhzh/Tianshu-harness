import { createHash } from 'node:crypto'
import { FROZEN_BLOCK_CAPS, type VolatileContext } from './volatile.js'
import { selectProjectInstructions } from './project-instructions.js'
import { DISABLED_USER_INSTRUCTIONS, renderUserInstructions, userInstructionsMatch, type UserInstructionsSnapshot, type AppliedUserInstructions } from './user-instructions.js'
import type { BudgetInput } from './prefix-budget.js'
import type { ToolDefinition } from '../api/types.js'

/** Counts actual published boundary copies; pending bytes do not enter the frozen total. */
export function enginePrefixBudget(input: {
  ctx: VolatileContext; systemPrompt: string; tools: readonly ToolDefinition[]; appendix?: string
  prefixes: Iterable<string>; userInstructions: UserInstructionsSnapshot; applied?: AppliedUserInstructions
}): BudgetInput[] {
  const ctx = input.ctx
  const caps = { ...FROZEN_BLOCK_CAPS, ...ctx.blockCaps }
  const publishedRules = [...input.prefixes]
    .flatMap(prefix => prefix.match(/<user-instructions(?: state="disabled")?>[\s\S]*?<\/user-instructions>/g) ?? [])
    .map(block => block + '\n\n').join('')
  const pendingRules = renderUserInstructions(input.userInstructions, !!input.applied)
  return [
    { name: 'static.ts BASE_PROMPT', category: 'brake', content: input.systemPrompt },
    { name: 'star-domain volatileBlock', category: 'brake', content: ctx.activeDomain?.volatileBlock },
    { name: '工具 schema (JSON)', category: 'tools', content: JSON.stringify(input.tools) },
    { name: 'user-instructions (published)', category: 'brake', content: publishedRules },
    ...(!userInstructionsMatch(input.userInstructions, input.applied)
      ? [{ name: 'user-instructions (pending)', category: 'appendix' as const, content: pendingRules ? pendingRules + '\n\n' : undefined }] : []),
    // 与渲染层同一套按节选取——`slice(0, cap)` 会把报告写成「按前 N 字符收录」，
    // 而实际收录的是另一组章节，归因数字对不上真实前缀。
    { name: 'project-instructions', category: 'reference', content: ctx.rivetMd ? selectProjectInstructions(ctx.rivetMd, caps.projectInstructions).text : undefined, cap: caps.projectInstructions, rawChars: ctx.rivetMd?.length },
    { name: 'project-memory', category: 'reference', content: ctx.projectMemoryBlock?.slice(0, caps.projectMemory), cap: caps.projectMemory, rawChars: ctx.projectMemoryBlock?.length },
    { name: 'knowledge-manifest', category: 'reference', content: ctx.knowledgeManifestBlock?.slice(0, caps.knowledgeManifest), cap: caps.knowledgeManifest, rawChars: ctx.knowledgeManifestBlock?.length },
    { name: 'codebase-index', category: 'reference', content: ctx.projectIndexBlock?.slice(0, caps.codebaseIndex), cap: caps.codebaseIndex, rawChars: ctx.projectIndexBlock?.length },
    { name: 'seed-capsule 索引', category: 'reference', content: ctx.seedCapsuleBlock },
    { name: 'session-memory', category: 'reference', content: ctx.sessionMemoryBlock },
    { name: 'appendix（每轮动态）', category: 'appendix', content: input.appendix },
  ]
}

export function publishedUserInstructionsBlock(applied: AppliedUserInstructions | undefined, prefixes: Iterable<string>): string | undefined {
  if (applied?.state === 'revoked') return renderUserInstructions(DISABLED_USER_INSTRUCTIONS, true)
  if (!applied) return undefined
  for (const prefix of [...prefixes].reverse()) {
    const block = prefix.match(/<user-instructions>[\s\S]*?<\/user-instructions>/)?.[0]
    if (block && createHash('sha256').update(block).digest('hex') === applied.digest) return block
  }
  return undefined
}

export function userInstructionsStatus(snapshot: UserInstructionsSnapshot, applied: AppliedUserInstructions | undefined, prefixes: Iterable<string>) {
  const block = publishedUserInstructionsBlock(applied, prefixes)
  return {
    requested: snapshot.state, applied: applied?.state ?? 'absent', pending: !userInstructionsMatch(snapshot, applied),
    ...(snapshot.state === 'active' ? { digest: snapshot.digest, pendingChars: renderUserInstructions(snapshot)!.length + 2 } : {}),
    ...(applied?.state === 'active' ? { appliedDigest: applied.digest } : {}),
    chars: block ? block.length + 2 : 0,
  }
}
