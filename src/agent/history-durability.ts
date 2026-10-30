import { rejectOnAbort } from './turn-boundary-abort.js'
import { LocalWorkerPolicyError, isLocalWorkerPolicyError } from '../api/continuation-prefix.js'

export async function waitForHistoryDurability(drain: () => Promise<void>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  try { await rejectOnAbort(drain(), signal, 'history-persistence') }
  catch (error) {
    if (signal?.aborted || isLocalWorkerPolicyError(error)) throw error
    throw Object.assign(new LocalWorkerPolicyError('会话历史耐久提交失败，已暂停后续执行；请保持会话打开，检查磁盘空间、权限和文件占用后重试。'), { cause: error })
  }
  signal?.throwIfAborted()
}

/** Abort releases the run, while the same owner's write queue remains alive. */
export async function settleInterruptedHistory(drain: Promise<void>, signal?: AbortSignal): Promise<void> {
  const observed = drain.catch(() => {})
  if (!signal?.aborted) return observed
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await Promise.race([observed, new Promise<void>(resolve => { timer = setTimeout(resolve, 250) })]) }
  finally { clearTimeout(timer) }
}
