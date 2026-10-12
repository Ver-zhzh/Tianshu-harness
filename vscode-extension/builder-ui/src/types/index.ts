export type FrontendLanguage = 'html' | 'react-tsx' | 'react-jsx' | 'vue' | 'svelte' | 'css' | 'unknown'

export type ViewportMode = 'responsive' | 'desktop' | 'tablet' | 'mobile'

export type BuilderMode = 'builder' | 'preview'

export interface SelectedElement {
  id?: string
  tagName: string
  className: string
  textContent: string
  attributes: Record<string, string>
  line?: number
  selector?: string
  rect?: {
    top: number
    left: number
    width: number
    height: number
  }
}

export interface ConsoleLog {
  id: string
  level: 'log' | 'info' | 'warn' | 'error'
  message: string
  timestamp: number
}

export interface ComponentMaterial {
  id: string
  category: 'layout' | 'basic' | 'form' | 'sections'
  name: string
  icon: string
  description: string
  snippet: string
}
