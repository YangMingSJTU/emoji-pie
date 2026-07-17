import type { LocalAssetApi } from './local-assets'

export type GenerationMode = 'express' | 'reply'

export const EMOJI_STYLES = [
  'classic',
  'cute',
  'deadpan',
  'office',
  'sarcastic',
  'spectator',
  'chaos'
] as const

export type EmojiStyle = (typeof EMOJI_STYLES)[number]

export type EmojiStyleSelection = 'smart' | EmojiStyle

export function isEmojiStyle(value: unknown): value is EmojiStyle {
  return typeof value === 'string' && (EMOJI_STYLES as readonly string[]).includes(value)
}

export type EmojiLayout = 'compact' | 'poster'

export type EmojiOutputType = 'inline' | 'image'

export interface EmojiRenderSettings {
  outputType: EmojiOutputType
  layout: EmojiLayout
  embedCaption: boolean
}

export const DEFAULT_EMOJI_RENDER_SETTINGS: EmojiRenderSettings = {
  outputType: 'image',
  layout: 'compact',
  embedCaption: false
}

export function normalizeEmojiRenderSettings(value: unknown): EmojiRenderSettings {
  const candidate = value && typeof value === 'object'
    ? value as Partial<EmojiRenderSettings>
    : {}
  return {
    outputType: candidate.outputType === 'inline' ? 'inline' : 'image',
    layout: candidate.layout === 'poster' ? 'poster' : 'compact',
    embedCaption: candidate.embedCaption === true
  }
}

export type EmotionId =
  | 'happy'
  | 'sad'
  | 'angry'
  | 'speechless'
  | 'tired'
  | 'surprised'
  | 'awkward'
  | 'smug'
  | 'crazy'

export type LibraryFilter = 'all' | 'favorites'

export interface LocalGenerationSourceSnapshot {
  assetId: string
  assetNameSnapshot: string
  matchMode: 'automatic' | 'manual'
  sourceDeleted: boolean
}

export interface TextAnalysis {
  emotion: EmotionId
  emotionLabel: string
  scene: 'daily' | 'work' | 'social'
  tone: string
  intent: string
  keywords: string[]
}

export interface EmojiRecord {
  id: string
  prompt: string
  mode: GenerationMode
  style: EmojiStyle
  layout: EmojiLayout
  embedCaption: boolean
  emotion: EmotionId
  caption: string
  seed: number
  dataUrl: string
  favorite: boolean
  createdAt: string
  localSource?: LocalGenerationSourceSnapshot
}

export interface AppInfo {
  version: string
  platform: string
}

export type AgentRuntimeId =
  | 'ollama'
  | 'lmstudio'
  | 'openai-compatible'
  | 'claude'
  | 'codex'
  | 'opencode'

export type AgentRuntimeKind = 'local-model' | 'agent-cli'

export type AgentRuntimeStatus = 'ready' | 'unavailable' | 'error'

export interface AgentRuntimeModel {
  id: string
  label: string
  provider?: string
  default?: boolean
}

export interface AgentRuntimeSettings {
  enabled: boolean
  runtimeId: AgentRuntimeId
  executablePath: string
  endpoint: string
  model: string
}

export const DEFAULT_RUNTIME_ENDPOINTS: Record<AgentRuntimeId, string> = {
  ollama: 'http://127.0.0.1:11434',
  lmstudio: 'http://127.0.0.1:1234',
  'openai-compatible': 'http://127.0.0.1:8000',
  claude: '',
  codex: '',
  opencode: ''
}

export const DEFAULT_AGENT_RUNTIME_SETTINGS: AgentRuntimeSettings = {
  enabled: false,
  runtimeId: 'claude',
  executablePath: '',
  endpoint: '',
  model: ''
}

export interface AgentRuntimeDescriptor {
  id: AgentRuntimeId
  name: string
  kind: AgentRuntimeKind
  command: string
  status: AgentRuntimeStatus
  installed: boolean
  executablePath: string
  endpoint: string
  canStart: boolean
  runningOwned: boolean
  version: string
  models: AgentRuntimeModel[]
  message: string
}

export interface AgentRuntimeDiscovery {
  runtimes: AgentRuntimeDescriptor[]
  scannedAt: string
}

export interface AgentRuntimeGenerateRequest {
  prompt: string
  mode: GenerationMode
}

export interface RuntimeEmojiVariant {
  emotion: EmotionId
  caption: string
}

export interface AgentRuntimeGenerationResult {
  analysis: TextAnalysis
  variants: RuntimeEmojiVariant[]
  runtimeId: AgentRuntimeId
  runtimeName: string
  model: string
  durationMs: number
}

export interface DesktopApi {
  library: {
    list: (filter?: LibraryFilter) => Promise<EmojiRecord[]>
    save: (records: EmojiRecord[]) => Promise<void>
    toggleFavorite: (id: string, favorite: boolean) => Promise<void>
    delete: (id: string) => Promise<void>
    clearHistory: () => Promise<void>
  }
  clipboard: {
    writeImage: (dataUrl: string) => Promise<void>
    writeText: (value: string) => Promise<void>
  }
  dialog: {
    saveImage: (dataUrl: string, suggestedName: string) => Promise<boolean>
  }
  app: {
    getInfo: () => Promise<AppInfo>
  }
  renderSettings: {
    get: () => Promise<EmojiRenderSettings>
    save: (settings: EmojiRenderSettings) => Promise<EmojiRenderSettings>
  }
  runtime: {
    getSettings: () => Promise<AgentRuntimeSettings>
    saveSettings: (settings: AgentRuntimeSettings) => Promise<AgentRuntimeSettings>
    discover: (settings?: AgentRuntimeSettings) => Promise<AgentRuntimeDiscovery>
    start: (settings: AgentRuntimeSettings) => Promise<AgentRuntimeDescriptor>
    generate: (request: AgentRuntimeGenerateRequest) => Promise<AgentRuntimeGenerationResult>
  }
  localAssets: LocalAssetApi
}
