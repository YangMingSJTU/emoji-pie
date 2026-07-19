import {
  DEFAULT_AGENT_RUNTIME_SETTINGS,
  DEFAULT_EMOJI_RENDER_SETTINGS,
  DEFAULT_RUNTIME_ENDPOINTS,
  isEmojiStyle,
  normalizeEmojiRenderSettings,
  type AgentRuntimeId,
  type AgentRuntimeSettings,
  type DesktopApi,
  type EmojiRecord,
  type LibraryFilter
} from '../../../shared/types'
import type { LocalAssetApi, LocalAssetResult } from '../../../shared/local-assets'
import { writeTextWithFallback, type TextClipboardWriter } from './clipboard'

const STORAGE_KEY = 'emoji-pie-browser-library-v1'
const SETTINGS_STORAGE_KEY = 'emoji-pie-browser-agent-runtime-v2'
const RENDER_SETTINGS_STORAGE_KEY = 'emoji-pie-browser-render-settings-v1'

const BROWSER_RUNTIME_IDS = new Set<AgentRuntimeId>([
  'ollama',
  'lmstudio',
  'openai-compatible',
  'claude',
  'codex',
  'opencode'
])

function readLibrary(): EmojiRecord[] {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (!value) return []
    return (JSON.parse(value) as Array<Partial<EmojiRecord>>).map((record) => ({
      ...record,
      style: isEmojiStyle(record.style) ? record.style : 'classic',
      layout: record.layout === 'compact' ? 'compact' : 'poster',
      embedCaption: typeof record.embedCaption === 'boolean' ? record.embedCaption : true
    })) as EmojiRecord[]
  } catch {
    return []
  }
}

function readEmojiRenderSettings() {
  try {
    const value = localStorage.getItem(RENDER_SETTINGS_STORAGE_KEY)
    return value
      ? normalizeEmojiRenderSettings(JSON.parse(value))
      : { ...DEFAULT_EMOJI_RENDER_SETTINGS }
  } catch {
    return { ...DEFAULT_EMOJI_RENDER_SETTINGS }
  }
}

function writeLibrary(records: EmojiRecord[]): void {
  const favorites = records.filter((record) => record.favorite)
  const recent = records.filter((record) => !record.favorite).slice(0, 60)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...favorites, ...recent]))
  } catch {
    localStorage.removeItem(STORAGE_KEY)
  }
}

function unavailableLocalAssetResult<T>(): LocalAssetResult<T> {
  return {
    ok: false,
    error: {
      code: 'feature_unavailable',
      message: '浏览器预览不支持本地素材，请使用桌面版',
      retryable: false
    }
  }
}

const browserLocalAssets: LocalAssetApi = {
  list: async () => unavailableLocalAssetResult(),
  beginImport: async () => unavailableLocalAssetResult(),
  getImportSession: async () => unavailableLocalAssetResult(),
  retryImportItems: async () => unavailableLocalAssetResult(),
  cancelImport: async () => unavailableLocalAssetResult(),
  updateImportDraft: async () => unavailableLocalAssetResult(),
  finalizeImport: async () => unavailableLocalAssetResult(),
  updateMetadata: async () => unavailableLocalAssetResult(),
  generatePosters: async () => unavailableLocalAssetResult(),
  delete: async () => unavailableLocalAssetResult()
}

function readAgentRuntimeSettings(): AgentRuntimeSettings {
  try {
    const value = localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (!value) return { ...DEFAULT_AGENT_RUNTIME_SETTINGS }
    const candidate = JSON.parse(value) as Partial<AgentRuntimeSettings>
    const runtimeId = candidate.runtimeId && BROWSER_RUNTIME_IDS.has(candidate.runtimeId)
      ? candidate.runtimeId
      : DEFAULT_AGENT_RUNTIME_SETTINGS.runtimeId
    return {
      enabled: candidate.enabled === true,
      runtimeId,
      executablePath: typeof candidate.executablePath === 'string' ? candidate.executablePath : '',
      endpoint: typeof candidate.endpoint === 'string'
        ? candidate.endpoint
        : DEFAULT_RUNTIME_ENDPOINTS[runtimeId],
      model: typeof candidate.model === 'string' ? candidate.model : ''
    }
  } catch {
    return { ...DEFAULT_AGENT_RUNTIME_SETTINGS }
  }
}

function getBrowserClipboardWriter(): TextClipboardWriter | undefined {
  if (typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') {
    return undefined
  }
  const clipboard = navigator.clipboard
  return (value) => clipboard.writeText(value)
}

async function writeTextWithSelection(value: string): Promise<void> {
  if (
    typeof document === 'undefined' ||
    !document.body ||
    typeof document.execCommand !== 'function'
  ) {
    throw new Error('当前环境不支持文本剪贴板')
  }

  const activeElement = document.activeElement
  const field = document.createElement('textarea')
  field.value = value
  field.readOnly = true
  field.setAttribute('aria-hidden', 'true')
  Object.assign(field.style, {
    position: 'fixed',
    top: '0',
    left: '-9999px',
    width: '1px',
    height: '1px',
    opacity: '0'
  })
  document.body.append(field)
  field.focus({ preventScroll: true })
  field.select()
  field.setSelectionRange(0, value.length)

  try {
    if (!document.execCommand('copy')) throw new Error('浏览器拒绝文本复制')
  } finally {
    field.remove()
    if (activeElement instanceof HTMLElement) activeElement.focus({ preventScroll: true })
  }
}

function writeBrowserClipboardText(value: string): Promise<void> {
  return writeTextWithFallback(value, getBrowserClipboardWriter(), writeTextWithSelection)
}

const browserApi: DesktopApi = {
  library: {
    async list(filter: LibraryFilter = 'all') {
      const records = readLibrary().sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      return filter === 'favorites' ? records.filter((record) => record.favorite) : records
    },
    async save(records) {
      const current = readLibrary()
      const incoming = new Map(records.map((record) => [record.id, record]))
      const merged = [
        ...records,
        ...current.filter((record) => !incoming.has(record.id))
      ]
      writeLibrary(merged)
    },
    async toggleFavorite(id, favorite) {
      writeLibrary(readLibrary().map((record) => (record.id === id ? { ...record, favorite } : record)))
    },
    async delete(id) {
      writeLibrary(readLibrary().filter((record) => record.id !== id))
    },
    async clearHistory() {
      writeLibrary(readLibrary().filter((record) => record.favorite))
    }
  },
  clipboard: {
    async writeImage(dataUrl) {
      const blob = await (await fetch(dataUrl)).blob()
      if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
        throw new Error('浏览器不支持图片剪贴板')
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    },
    async writeText(value) {
      await writeBrowserClipboardText(value)
    }
  },
  dialog: {
    async saveImage(dataUrl, suggestedName) {
      const anchor = document.createElement('a')
      anchor.href = dataUrl
      anchor.download = suggestedName.endsWith('.png') ? suggestedName : `${suggestedName}.png`
      anchor.click()
      return true
    }
  },
  app: {
    async getInfo() {
      return { version: '0.1.0-web', platform: 'web' }
    }
  },
  renderSettings: {
    async get() {
      return readEmojiRenderSettings()
    },
    async save(settings) {
      const normalized = normalizeEmojiRenderSettings(settings)
      localStorage.setItem(RENDER_SETTINGS_STORAGE_KEY, JSON.stringify(normalized))
      return normalized
    }
  },
  runtime: {
    async getSettings() {
      return readAgentRuntimeSettings()
    },
    async saveSettings(settings) {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings))
      return settings
    },
    async discover() {
      return {
        runtimes: [
          { id: 'ollama' as const, name: 'Ollama', command: 'ollama', kind: 'local-model' as const },
          { id: 'lmstudio' as const, name: 'LM Studio', command: 'OpenAI API', kind: 'local-model' as const },
          { id: 'openai-compatible' as const, name: 'OpenAI Compatible', command: 'Local API', kind: 'local-model' as const },
          { id: 'claude' as const, name: 'Claude Code', command: 'claude', kind: 'agent-cli' as const },
          { id: 'codex' as const, name: 'Codex', command: 'codex', kind: 'agent-cli' as const },
          { id: 'opencode' as const, name: 'OpenCode', command: 'opencode', kind: 'agent-cli' as const }
        ].map((runtime) => ({
          ...runtime,
          status: 'unavailable' as const,
          installed: false,
          executablePath: '',
          endpoint: DEFAULT_RUNTIME_ENDPOINTS[runtime.id],
          canStart: false,
          runningOwned: false,
          version: '',
          models: [],
          message: '浏览器预览无法探测本机 CLI，请使用桌面版'
        })),
        scannedAt: new Date().toISOString()
      }
    },
    async start() {
      throw new Error('浏览器预览无法启动本机 AI 运行时')
    },
    async generate() {
      throw new Error('浏览器预览无法执行本机 AI 运行时')
    }
  },
  localAssets: browserLocalAssets
}

function createDesktopApi(): DesktopApi {
  const nativeApi = window.emojiPie
  if (!nativeApi) return browserApi

  const nativeClipboard = nativeApi.clipboard as Partial<DesktopApi['clipboard']> | undefined
  return {
    ...nativeApi,
    clipboard: {
      writeImage: nativeClipboard?.writeImage ?? browserApi.clipboard.writeImage,
      writeText: (value) =>
        writeTextWithFallback(value, nativeClipboard?.writeText, browserApi.clipboard.writeText)
    }
  }
}

export const desktopApi: DesktopApi = createDesktopApi()
