/**
 * 天枢前端多语言可视化建造与实时预览窗口 Provider。
 *
 * 挂载于编辑器分屏（ViewColumn.Beside），与代码编辑区实时联动：
 * 1. 监听当前前端源码（HTML, React/TSX, Vue, Svelte 等）变更并向 Webview 派发增量热更。
 * 2. 接收来自 Webview 可视化拖拽/属性编辑的修改，回写 VS Code 文档（支持 Undo/Redo）。
 * 3. 支持组件与源码双向行号高亮联动。
 * 4. 深度衔接天枢 AI Agent：组件一键投递提问、修改流式实时预览。
 */
import * as vscode from 'vscode'
import { basename, extname } from 'node:path'
import type { SidecarClient } from '../sidecar/client.js'

export type FrontendLanguage = 'html' | 'react-tsx' | 'react-jsx' | 'vue' | 'svelte' | 'css' | 'unknown'

export interface BuilderInitPayload {
  filePath: string
  fileName: string
  relativePath: string
  language: FrontendLanguage
  content: string
}

type BuilderInboundMsg =
  | { type: 'ready' }
  | { type: 'updateCode'; content: string; path?: string }
  | { type: 'revealLine'; line: number }
  | { type: 'askAgent'; prompt: string; codeSnippet?: string; componentName?: string }
  | { type: 'pickWorkspaceFile' }
  | { type: 'copyToClipboard'; text: string }

export class VisualBuilderProvider {
  private panel: vscode.WebviewPanel | undefined
  private activeDocumentUri: vscode.Uri | undefined
  private disposables: vscode.Disposable[] = []
  private debounceTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getClient: () => Promise<SidecarClient>,
    private readonly workspaceCwd: string,
    private readonly onAskAgentPrompt?: (promptText: string) => Promise<void> | void,
  ) {}

  /**
   * 打开或聚焦可视化建造窗口。
   * 若指定了 uri 则打开指定文件；未指定则优先取当前活跃编辑器中的文件。
   */
  async open(targetUri?: vscode.Uri): Promise<void> {
    const docUri = targetUri ?? vscode.window.activeTextEditor?.document.uri
    if (docUri) {
      this.activeDocumentUri = docUri
    }

    if (this.panel) {
      this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Beside)
      if (this.activeDocumentUri) {
        await this.syncActiveDocumentToWebview()
      }
      return
    }

    this.panel = vscode.window.createWebviewPanel(
      'tianshu.visualBuilder',
      '天枢 · 前端可视化建造器',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        enableForms: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, 'dist'),
          vscode.Uri.joinPath(this.extensionUri, 'media'),
        ],
      },
    )

    this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.png')
    this.panel.webview.html = this.renderHtml(this.panel.webview)

    this.panel.webview.onDidReceiveMessage(
      (msg: BuilderInboundMsg) => void this.handleWebviewMessage(msg),
      null,
      this.disposables,
    )

    // 监听当前文档变更，防抖投递最新内容
    vscode.workspace.onDidChangeTextDocument(
      (event) => {
        if (this.activeDocumentUri && event.document.uri.toString() === this.activeDocumentUri.toString()) {
          this.scheduleDocumentPush(event.document.getText())
        }
      },
      null,
      this.disposables,
    )

    // 当用户在编辑器切换活动文件时，若同属前端文件，自动提示或平滑更新
    vscode.window.onDidChangeActiveTextEditor(
      (editor) => {
        if (!editor || !this.panel) return
        const ext = extname(editor.document.fileName).toLowerCase()
        if (['.html', '.htm', '.tsx', '.jsx', '.vue', '.svelte', '.css'].includes(ext)) {
          this.activeDocumentUri = editor.document.uri
          void this.syncActiveDocumentToWebview()
        }
      },
      null,
      this.disposables,
    )

    this.panel.onDidDispose(() => {
      this.panel = undefined
      this.disposables.forEach((d) => d.dispose())
      this.disposables = []
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer)
        this.debounceTimer = undefined
      }
    })
  }

  private detectLanguage(fileName: string): FrontendLanguage {
    const ext = extname(fileName).toLowerCase()
    switch (ext) {
      case '.html':
      case '.htm':
        return 'html'
      case '.tsx':
        return 'react-tsx'
      case '.jsx':
        return 'react-jsx'
      case '.vue':
        return 'vue'
      case '.svelte':
        return 'svelte'
      case '.css':
        return 'css'
      default:
        return 'unknown'
    }
  }

  private scheduleDocumentPush(content: string): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.post({
        type: 'fileContentUpdate',
        content,
      })
    }, 150)
  }

  private async syncActiveDocumentToWebview(): Promise<void> {
    if (!this.panel || !this.activeDocumentUri) return
    try {
      const doc = await vscode.workspace.openTextDocument(this.activeDocumentUri)
      const fsPath = doc.fileName
      const fileName = basename(fsPath)
      const relativePath = vscode.workspace.asRelativePath(doc.uri, false)
      const language = this.detectLanguage(fsPath)
      const content = doc.getText()

      this.panel.title = `天枢建造 · ${fileName}`

      this.post({
        type: 'initFile',
        payload: {
          filePath: fsPath,
          fileName,
          relativePath,
          language,
          content,
        } satisfies BuilderInitPayload,
      })
    } catch (err) {
      vscode.window.showErrorMessage(`加载前端文件失败: ${(err as Error).message}`)
    }
  }

  private async handleWebviewMessage(msg: BuilderInboundMsg): Promise<void> {
    switch (msg.type) {
      case 'ready':
        if (this.activeDocumentUri) {
          await this.syncActiveDocumentToWebview()
        } else {
          // 若未打开任何前端文件，自动尝试寻找工作区内的 index.html / App.tsx / App.vue
          await this.tryDetectDefaultFrontendFile()
        }
        break

      case 'updateCode':
        await this.handleCodeUpdate(msg.content, msg.path)
        break

      case 'revealLine':
        await this.revealSourceLine(msg.line)
        break

      case 'askAgent':
        await this.handleAskAgent(msg.prompt, msg.codeSnippet, msg.componentName)
        break

      case 'pickWorkspaceFile':
        await this.promptUserPickFile()
        break

      case 'copyToClipboard':
        await vscode.env.clipboard.writeText(msg.text)
        void vscode.window.showInformationMessage('已复制到剪贴板')
        break
    }
  }

  private async tryDetectDefaultFrontendFile(): Promise<void> {
    const candidates = await vscode.workspace.findFiles('**/{index.html,App.tsx,App.vue,App.svelte,index.tsx,main.tsx}', '**/node_modules/**', 5)
    if (candidates.length > 0) {
      this.activeDocumentUri = candidates[0]
      await this.syncActiveDocumentToWebview()
    } else {
      this.post({
        type: 'noFileLoaded',
      })
    }
  }

  private async promptUserPickFile(): Promise<void> {
    const files = await vscode.workspace.findFiles('**/*.{html,htm,tsx,jsx,vue,svelte,css}', '**/node_modules/**', 100)
    if (files.length === 0) {
      void vscode.window.showInformationMessage('工作区中未发现支持的前端文件')
      return
    }

    const items = files.map((uri) => ({
      label: basename(uri.fsPath),
      description: vscode.workspace.asRelativePath(uri, false),
      uri,
    }))

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: '选择要在此可视化建造窗口中预览/编辑的前端文件',
    })

    if (picked) {
      this.activeDocumentUri = picked.uri
      await this.syncActiveDocumentToWebview()
    }
  }

  private async handleCodeUpdate(content: string, filePath?: string): Promise<void> {
    const targetUri = filePath ? vscode.Uri.file(filePath) : this.activeDocumentUri
    if (!targetUri) return

    try {
      const doc = await vscode.workspace.openTextDocument(targetUri)
      const fullRange = new vscode.Range(
        doc.positionAt(0),
        doc.positionAt(doc.getText().length),
      )
      const edit = new vscode.WorkspaceEdit()
      edit.replace(targetUri, fullRange, content)
      await vscode.workspace.applyEdit(edit)
    } catch (err) {
      vscode.window.showErrorMessage(`写入代码变更失败: ${(err as Error).message}`)
    }
  }

  private async revealSourceLine(line: number): Promise<void> {
    if (!this.activeDocumentUri || line < 1) return
    try {
      const doc = await vscode.workspace.openTextDocument(this.activeDocumentUri)
      const editor = await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: true,
      })
      const pos = new vscode.Position(line - 1, 0)
      editor.selection = new vscode.Selection(pos, pos)
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter)
    } catch {
      // 容错
    }
  }

  private async handleAskAgent(prompt: string, codeSnippet?: string, componentName?: string): Promise<void> {
    let fullPrompt = prompt
    if (componentName) {
      fullPrompt = `[针对组件: ${componentName}]\n${fullPrompt}`
    }
    if (codeSnippet) {
      fullPrompt = `${fullPrompt}\n\n相关源码片段:\n\`\`\`\n${codeSnippet}\n\`\`\``
    }

    if (this.onAskAgentPrompt) {
      await this.onAskAgentPrompt(fullPrompt)
    } else {
      void vscode.window.showInformationMessage(`已发送至天枢 Agent: ${prompt}`)
    }
  }

  private post(msg: Record<string, unknown>): void {
    if (this.panel) {
      void this.panel.webview.postMessage(msg)
    }
  }

  private renderHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'builder.js'))
    const nonce = Math.random().toString(36).slice(2)
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https: ${webview.cspSource}; script-src 'nonce-${nonce}' 'unsafe-eval' https: ${webview.cspSource}; frame-src * blob: data:; img-src * blob: data:; font-src https: data:;" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>天枢前端可视化建造器</title>
<style>
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background-color: var(--vscode-editor-background, #1e1e1e);
    color: var(--vscode-editor-foreground, #d4d4d4);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  #builder-root {
    width: 100%;
    height: 100%;
  }
</style>
</head>
<body>
<div id="builder-root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
  }
}
