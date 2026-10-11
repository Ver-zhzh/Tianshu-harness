/** Runtime/UI address; logical workOrderId remains the dependency and resume key. */
export function workerDispatchKey(worker: { workOrderId: string; dispatchId?: string; attemptId?: string }): string {
  return worker.attemptId ?? worker.dispatchId ?? worker.workOrderId
}
