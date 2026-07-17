import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc'
import type {
  AgentRuntimeGenerateRequest,
  AgentRuntimeSettings,
  EmojiRecord,
  EmojiRenderSettings,
  LibraryFilter
} from '../shared/types'
import { isEmojiStyle, normalizeEmojiRenderSettings } from '../shared/types'
import { countGraphemes, normalizeLocalAssetId } from '../shared/local-assets'
import { AgentRuntimeManager, normalizeAgentRuntimeSettings } from './agent-runtime'
import {
  createUnavailableLocalAssetIpcService,
  registerLocalAssetIpcHandlers
} from './local-asset-ipc'
import { EmojiRepository } from './repository'

const MAX_SAVE_BATCH = 24
const AGENT_RUNTIME_SETTINGS_KEY = 'agent-runtime-settings-v2'
const EMOJI_RENDER_SETTINGS_KEY = 'emoji-render-settings-v1'
let mainWindow: BrowserWindow | null = null
let repository: EmojiRepository | null = null
let agentRuntime: AgentRuntimeManager | null = null

if (process.env.EMOJI_PIE_USER_DATA) {
  app.setPath('userData', process.env.EMOJI_PIE_USER_DATA)
}

function isEmojiRecord(record: unknown): record is EmojiRecord {
  if (!record || typeof record !== 'object') return false
  const candidate = record as Partial<EmojiRecord>
  const hasValidLocalSource = candidate.localSource === undefined || (
    candidate.localSource !== null &&
    typeof candidate.localSource === 'object' &&
    typeof candidate.localSource.assetId === 'string' &&
    normalizeLocalAssetId(candidate.localSource.assetId) !== undefined &&
    typeof candidate.localSource.assetNameSnapshot === 'string' &&
    countGraphemes(candidate.localSource.assetNameSnapshot.trim()) > 0 &&
    countGraphemes(candidate.localSource.assetNameSnapshot.trim()) <= 60 &&
    (candidate.localSource.matchMode === 'automatic' ||
      candidate.localSource.matchMode === 'manual') &&
    typeof candidate.localSource.sourceDeleted === 'boolean'
  )
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length <= 120 &&
    typeof candidate.prompt === 'string' &&
    candidate.prompt.length <= 500 &&
    typeof candidate.caption === 'string' &&
    isEmojiStyle(candidate.style) &&
    (candidate.layout === 'compact' || candidate.layout === 'poster') &&
    typeof candidate.embedCaption === 'boolean' &&
    typeof candidate.dataUrl === 'string' &&
    typeof candidate.seed === 'number' &&
    typeof candidate.createdAt === 'string' &&
    hasValidLocalSource
  )
}

function requireRepository(): EmojiRepository {
  if (!repository) throw new Error('本地资料库尚未初始化')
  return repository
}

function requireAgentRuntime(): AgentRuntimeManager {
  if (!agentRuntime) throw new Error('AI 运行时尚未初始化')
  return agentRuntime
}

function getAgentRuntimeSettings(): AgentRuntimeSettings {
  return normalizeAgentRuntimeSettings(
    requireRepository().getPreference<AgentRuntimeSettings>(AGENT_RUNTIME_SETTINGS_KEY)
  )
}

function getEmojiRenderSettings(): EmojiRenderSettings {
  return normalizeEmojiRenderSettings(
    requireRepository().getPreference<EmojiRenderSettings>(EMOJI_RENDER_SETTINGS_KEY)
  )
}

function safeFileName(value: string): string {
  const forbidden = '<>:"/\\|?*'
  const normalized = [...value]
    .map((character) =>
      character.charCodeAt(0) < 32 || forbidden.includes(character) ? '-' : character
    )
    .join('')
    .trim()
  const base = normalized.slice(0, 48) || 'emoji-pie'
  return base.toLowerCase().endsWith('.png') ? base : `${base}.png`
}

function parseImage(dataUrl: string): Electron.NativeImage {
  if (!dataUrl.startsWith('data:image/png;base64,') || dataUrl.length > 15_000_000) {
    throw new Error('图片数据无效')
  }
  const image = nativeImage.createFromDataURL(dataUrl)
  if (image.isEmpty()) throw new Error('无法读取图片')
  return image
}

function isInlineEmojiValue(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() !== value) return false
  const codePoints = [...value]
  return (
    codePoints.length >= 1 &&
    codePoints.length <= 2 &&
    codePoints.every((codePoint) => /^\p{Emoji_Presentation}$/u.test(codePoint))
  )
}

function registerIpcHandlers(): void {
  registerLocalAssetIpcHandlers(ipcMain, createUnavailableLocalAssetIpcService())

  ipcMain.handle(IPC_CHANNELS.libraryList, (_event, filter: LibraryFilter = 'all') => {
    return requireRepository().list(filter === 'favorites' ? 'favorites' : 'all')
  })

  ipcMain.handle(IPC_CHANNELS.librarySave, (_event, records: unknown) => {
    if (!Array.isArray(records) || records.length > MAX_SAVE_BATCH || !records.every(isEmojiRecord)) {
      throw new Error('生成记录格式无效')
    }
    requireRepository().save(records)
  })

  ipcMain.handle(IPC_CHANNELS.libraryFavorite, (_event, id: unknown, favorite: unknown) => {
    if (typeof id !== 'string' || typeof favorite !== 'boolean') throw new Error('收藏参数无效')
    requireRepository().toggleFavorite(id, favorite)
  })

  ipcMain.handle(IPC_CHANNELS.libraryDelete, (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('记录编号无效')
    requireRepository().delete(id)
  })

  ipcMain.handle(IPC_CHANNELS.libraryClearHistory, () => {
    requireRepository().clearHistory()
  })

  ipcMain.handle(IPC_CHANNELS.clipboardWriteImage, (_event, dataUrl: unknown) => {
    if (typeof dataUrl !== 'string') throw new Error('图片数据无效')
    clipboard.writeImage(parseImage(dataUrl))
  })

  ipcMain.handle(IPC_CHANNELS.clipboardWriteText, (_event, value: unknown) => {
    if (!isInlineEmojiValue(value)) throw new Error('行内 Emoji 数据无效')
    clipboard.writeText(value)
  })

  ipcMain.handle(
    IPC_CHANNELS.dialogSaveImage,
    async (_event, dataUrl: unknown, suggestedName: unknown): Promise<boolean> => {
      if (typeof dataUrl !== 'string' || typeof suggestedName !== 'string') {
        throw new Error('保存参数无效')
      }
      const image = parseImage(dataUrl)
      const options: Electron.SaveDialogOptions = {
        title: '保存表情图片',
        defaultPath: join(app.getPath('pictures'), safeFileName(suggestedName)),
        filters: [{ name: 'PNG 图片', extensions: ['png'] }]
      }
      const result = mainWindow
        ? await dialog.showSaveDialog(mainWindow, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return false
      await writeFile(result.filePath, image.toPNG())
      return true
    }
  )

  ipcMain.handle(IPC_CHANNELS.appGetInfo, () => ({
    version: app.getVersion(),
    platform: process.platform
  }))

  ipcMain.handle(IPC_CHANNELS.renderSettingsGet, () => getEmojiRenderSettings())

  ipcMain.handle(IPC_CHANNELS.renderSettingsSave, (_event, value: unknown) => {
    const settings = normalizeEmojiRenderSettings(value)
    requireRepository().setPreference(EMOJI_RENDER_SETTINGS_KEY, settings)
    return settings
  })

  ipcMain.handle(IPC_CHANNELS.runtimeGetSettings, () => getAgentRuntimeSettings())

  ipcMain.handle(IPC_CHANNELS.runtimeSaveSettings, (_event, value: unknown) => {
    const settings = normalizeAgentRuntimeSettings(value)
    requireRepository().setPreference(AGENT_RUNTIME_SETTINGS_KEY, settings)
    return settings
  })

  ipcMain.handle(IPC_CHANNELS.runtimeDiscover, (_event, value?: unknown) => {
    const settings = value === undefined
      ? getAgentRuntimeSettings()
      : normalizeAgentRuntimeSettings(value)
    return requireAgentRuntime().discover(settings)
  })

  ipcMain.handle(IPC_CHANNELS.runtimeStart, (_event, value: unknown) => {
    return requireAgentRuntime().start(value)
  })

  ipcMain.handle(IPC_CHANNELS.runtimeGenerate, (_event, value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error('AI 运行时生成参数无效')
    return requireAgentRuntime().generate(
      getAgentRuntimeSettings(),
      value as AgentRuntimeGenerateRequest
    )
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#f6f4ee',
    title: '表情派 EmojiPie',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay:
      process.platform === 'darwin'
        ? undefined
        : { color: '#f6f4ee', symbolColor: '#282722', height: 44 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    app.setAppUserModelId('com.emojipie.desktop')
    repository = new EmojiRepository(join(app.getPath('userData'), 'emoji-pie.sqlite'))
    agentRuntime = new AgentRuntimeManager()
    registerIpcHandlers()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  agentRuntime?.dispose()
  agentRuntime = null
  repository?.close()
  repository = null
})
