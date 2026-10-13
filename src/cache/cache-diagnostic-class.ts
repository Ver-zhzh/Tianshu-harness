/** Evidence labels, never guesses about provider TTL or eviction. */
export function cacheDiagnosticClass(entry: Record<string, unknown>): string {
  const fields = entry.usageFields as Record<string, unknown> | undefined
  if (fields && (!fields.input_tokens || !fields.cache_read_input_tokens)) return 'usage_unknown'
  if (['generation_changed', 'configuration_changed'].includes((entry.wire as { comparison?: string } | undefined)?.comparison ?? '')) return 'model_or_config_change'
  if (entry.archiveId) return 'explicit_compaction'
  if (entry.toolsUpdated || (entry.wireDiverged as { role?: string } | undefined)?.role === 'tools') return 'model_or_config_change'
  if (entry.frozenRestoreReason) return 'restore_rebuild'
  if (entry.wireDiverged || entry.historyRewritten) return 'client_history_rewrite'
  if (typeof entry.diagnose === 'string' && entry.diagnose.startsWith('provider_unknown')) return 'provider_hit_decline_unknown'
  return 'append_or_unchanged'
}
