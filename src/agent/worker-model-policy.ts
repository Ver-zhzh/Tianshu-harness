import type { Config, ModelTarget } from '../config/schema.js'
import type { WorkOrder } from './work-order.js'
import { mapWorkOrderKindToCapabilityTask } from './work-order.js'

export interface WorkerModelPolicy {
  target: ModelTarget
  source: 'order' | 'role' | 'task' | 'default'
  unavailableReason?: 'route_deleted'
}

export function workerModelPolicy(config: Config, order: WorkOrder): WorkerModelPolicy {
  if (order.modelOverride) return { target: order.modelOverride, source: 'order' }
  const role = config.agent.review.profiles[order.profile]
  if (role) return { target: role, source: 'role' }
  const route = config.workers.routing[mapWorkOrderKindToCapabilityTask(order.kind)]
  if (route && typeof route !== 'string') return { target: route, source: 'task' }
  if (route) {
    const target = config.workers.profiles[route]
    // A deleted named profile is an invalid explicit binding, never an auto request.
    return { target: target ?? { provider: '', model: route }, source: 'task', ...(target ? {} : { unavailableReason: 'route_deleted' }) }
  }
  return { target: { strategy: config.workers.defaultStrategy ?? 'session' }, source: 'default' }
}
