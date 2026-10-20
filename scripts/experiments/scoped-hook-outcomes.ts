/** Task contract, not a general interpretation of arbitrary model prose. */
export const DELIVERY_STATUSES = { success: ['committed'], stopped: ['blocked', 'cancelled', 'uncertain', 'timeout', 'timed_out'] } as const
export type DeliveryOutcome = 'success' | 'stopped' | 'unknown'
export function deliveryOutcome(value: unknown): DeliveryOutcome {
  if (typeof value !== 'string') return 'unknown'
  if ((DELIVERY_STATUSES.success as readonly string[]).includes(value)) return 'success'
  if ((DELIVERY_STATUSES.stopped as readonly string[]).includes(value)) return 'stopped'
  return 'unknown'
}
