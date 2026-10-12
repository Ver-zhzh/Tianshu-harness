import type { FrontendLanguage } from './types/index.js'

export interface BuilderInitPayload {
  filePath: string
  fileName: string
  relativePath: string
  language: FrontendLanguage
  content: string
}

export type HostToWebviewMsg =
  | { type: 'initFile'; payload: BuilderInitPayload }
  | { type: 'fileContentUpdate'; content: string }
  | { type: 'noFileLoaded' }

export type WebviewToHostMsg =
  | { type: 'ready' }
  | { type: 'updateCode'; content: string; path?: string }
  | { type: 'revealLine'; line: number }
  | { type: 'askAgent'; prompt: string; codeSnippet?: string; componentName?: string }
  | { type: 'pickWorkspaceFile' }
  | { type: 'copyToClipboard'; text: string }

interface VsCodeApi {
  postMessage(message: unknown): void
  getState(): unknown
  setState(state: unknown): void
}

declare function acquireVsCodeApi(): VsCodeApi

let vscodeApiInstance: VsCodeApi | undefined

export function getVsCodeApi(): VsCodeApi {
  if (!vscodeApiInstance) {
    if (typeof acquireVsCodeApi === 'function') {
      vscodeApiInstance = acquireVsCodeApi()
    } else {
      // 本地浏览器或测试环境 mock
      vscodeApiInstance = {
        postMessage: (msg: unknown) => console.log('[Host PostMessage]', msg),
        getState: () => ({}),
        setState: () => {},
      }
    }
  }
  return vscodeApiInstance
}

export function sendToHost(msg: WebviewToHostMsg): void {
  getVsCodeApi().postMessage(msg)
}

export function onHostMessage(handler: (msg: HostToWebviewMsg) => void): () => void {
  const listener = (event: MessageEvent<HostToWebviewMsg>) => {
    if (event.data && typeof event.data === 'object' && 'type' in event.data) {
      handler(event.data)
    }
  }
  window.addEventListener('message', listener)
  return () => window.removeEventListener('message', listener)
}
