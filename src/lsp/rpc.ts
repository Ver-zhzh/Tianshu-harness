import { type Readable, type Writable } from 'node:stream'
import { decodeFrames, LspMessageDecoder } from './rpc-framing.js'
export { MAX_LSP_MESSAGE_BYTES, MAX_LSP_HEADER_BYTES } from './rpc-framing.js'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification

export interface RpcClient {
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
  notify(method: string, params?: Record<string, unknown>): void
  onNotification(method: string, handler: (params: Record<string, unknown>) => void): void
  /** Reject every in-flight request. Used on process exit/error so no caller waits forever. */
  abortAllPending(error: Error): void
  dispose(): void
}

export interface RpcClientOptions {
  /** Default per-request timeout. Requests are never allowed to pend forever. */
  requestTimeoutMs?: number
}

export const DEFAULT_LSP_REQUEST_TIMEOUT_MS = 45_000

export function encodeMessage(msg: JsonRpcMessage): string {
  const body = JSON.stringify(msg)
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
}

export function decodeMessages(input: string | Buffer): { messages: JsonRpcMessage[]; rest: string } {
  const { messages, rest } = decodeFrames(Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8'))
  return { messages: messages as unknown as JsonRpcMessage[], rest: rest.toString('utf8') }
}

export function createRpcClient(
  readable: Readable,
  writable: Writable,
  options: RpcClientOptions = {},
): RpcClient {
  const defaultTimeoutMs = options.requestTimeoutMs ?? DEFAULT_LSP_REQUEST_TIMEOUT_MS
  let nextId = 1
  type Pending = {
    resolve(v: unknown): void
    reject(e: Error): void
    timer: ReturnType<typeof setTimeout> | null
  }
  const pending = new Map<number, Pending>()
  const notificationHandlers = new Map<string, Array<(params: Record<string, unknown>) => void>>()
  const decoder = new LspMessageDecoder()
  let terminalError: Error | undefined

  const settle = (id: number, fn: (p: Pending) => void): void => {
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    if (p.timer !== null) clearTimeout(p.timer)
    fn(p)
  }

  const abortAllPending = (error: Error): void => {
    const all = [...pending.values()]
    pending.clear()
    for (const p of all) {
      if (p.timer !== null) clearTimeout(p.timer)
      p.reject(error)
    }
  }

  const failTransport = (error: Error): void => {
    if (terminalError) return
    terminalError = error
    decoder.clear()
    readable.removeListener('data', onData)
    abortAllPending(error)
  }

  const onData = (chunk: Buffer): void => {
    if (terminalError) return
    try {
      decoder.push(chunk, message => {
        const msg = message as unknown as JsonRpcMessage
        if ('id' in msg && 'result' in msg && !('method' in msg)) {
          settle(msg.id, p => p.resolve(msg.result))
        } else if ('id' in msg && 'error' in msg && !('method' in msg)) {
          settle(msg.id, p => p.reject(new Error(msg.error!.message)))
        } else if ('method' in msg && !('id' in msg)) {
          const handlers = notificationHandlers.get(msg.method)
          if (handlers) for (const handler of handlers) handler((msg as JsonRpcNotification).params ?? {})
        }
      })
    } catch (error) {
      failTransport(new Error(`LSP transport failed: ${error instanceof Error ? error.message : String(error)}`))
    }
  }
  const readError = (error: Error) => failTransport(new Error(`LSP transport read error: ${error.message}`))
  const writeError = (error: Error) => failTransport(new Error(`LSP transport write error: ${error.message}`))
  const closed = () => failTransport(new Error('LSP transport closed'))
  readable.on('data', onData)
  readable.on('error', readError)
  writable.on('error', writeError)
  readable.on('close', closed)
  writable.on('close', closed)

  return {
    request(method, params, timeoutMs = defaultTimeoutMs) {
      if (terminalError) return Promise.reject(terminalError)
      const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : defaultTimeoutMs
      return new Promise((resolve, reject) => {
        const id = nextId++
        const timer = setTimeout(() => {
          if (pending.delete(id)) {
            reject(new Error(`LSP request ${method} timed out after ${effectiveTimeout / 1000}s`))
          }
        }, effectiveTimeout)
        timer.unref?.()
        pending.set(id, { resolve, reject, timer })
        const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
        try {
          writable.write(encodeMessage(msg))
        } catch (err) {
          settle(id, p => p.reject(err instanceof Error ? err : new Error(String(err))))
        }
      })
    },
    notify(method, params) {
      if (terminalError) return
      const msg: JsonRpcNotification = {
        jsonrpc: '2.0' as const,
        method,
        params,
      }
      writable.write(encodeMessage(msg))
    },
    onNotification(method, handler) {
      const existing = notificationHandlers.get(method)
      if (existing) {
        existing.push(handler)
      } else {
        notificationHandlers.set(method, [handler])
      }
    },
    abortAllPending,
    dispose() {
      failTransport(new Error('LSP RPC client disposed'))
      notificationHandlers.clear()
      readable.removeListener('data', onData)
      readable.removeListener('error', readError)
      readable.removeListener('close', closed)
      writable.removeListener('error', writeError)
      writable.removeListener('close', closed)
    },
  }
}
