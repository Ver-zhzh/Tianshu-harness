import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { denyRuntimeProAuthorization, registerManagedProDenial, runtimeProAuthorizationDenied } from '../config/pro-license.js'
import { currentProviderRequirements, propagateProviderRequirements } from './execution-continuity.js'

export interface ManagedProAuthorization {
  denied: boolean
  requiredProviders: string[]
}

export function captureManagedProAuthorization(): ManagedProAuthorization {
  return { denied: runtimeProAuthorizationDenied(), requiredProviders: [...currentProviderRequirements()] }
}

export function withManagedProAuthorization<T>(authorization: ManagedProAuthorization | undefined, operation: () => T): T {
  if (authorization?.denied) void denyRuntimeProAuthorization().catch(() => {})
  return propagateProviderRequirements(authorization?.requiredProviders ?? [], operation)
}

export async function acknowledgeManagedProDenial(acknowledge: () => void): Promise<void> {
  await denyRuntimeProAuthorization()
  acknowledge()
}

export function manageProChild(child: ChildProcess, send: (id: string) => void) {
  let acknowledged = false
  let exited = false
  let pending: Promise<void> | undefined
  let requestId: string | undefined
  let resolveAck: (() => void) | undefined
  const deny = (timeoutMs = 5000): Promise<void> => {
    if (acknowledged) return Promise.resolve()
    if (exited) return Promise.reject(new Error('Managed Pro child exited without an authenticated drain acknowledgement'))
    if (pending) return pending
    requestId = randomUUID()
    pending = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { pending = undefined; reject(new Error('Managed Pro child denial was not acknowledged')) }, timeoutMs)
      resolveAck = () => { clearTimeout(timer); resolve() }
      try { send(requestId!) } catch (error) { clearTimeout(timer); pending = undefined; reject(error) }
    })
    return pending
  }
  const unregister = registerManagedProDenial(deny)
  child.once('exit', () => { exited = true; if (acknowledged) unregister() })
  child.once('error', () => { if (!child.pid) unregister() })
  return {
    deny,
    acknowledge(id?: string, drained = false): void {
      if (!drained && id !== requestId) return
      acknowledged = true
      resolveAck?.()
      if (exited) unregister()
    },
  }
}
