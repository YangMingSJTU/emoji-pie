import { lstat, readdir } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import { LOCAL_ASSET_LIMITS, type LocalImportSourceKind } from '../shared/local-assets'

export interface LocalAssetSelectedSource {
  sourcePath: string
  originalFilename: string
  itemId?: string
}

export interface LocalAssetSelection {
  sources: LocalAssetSelectedSource[]
  scanLimitReached: boolean
}

export interface LocalAssetPicker {
  select: (sourceKind: LocalImportSourceKind) => Promise<LocalAssetSelection | undefined>
}

const SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

function isSupportedFileName(fileName: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extname(fileName).toLowerCase())
}

async function toRegularSource(sourcePath: string): Promise<LocalAssetSelectedSource | undefined> {
  const stat = await lstat(sourcePath)
  if (!stat.isFile() || stat.isSymbolicLink()) return undefined
  const originalFilename = basename(sourcePath)
  if (!isSupportedFileName(originalFilename)) return undefined
  return { sourcePath: resolve(sourcePath), originalFilename }
}

export async function selectLocalAssetDirectory(
  directoryPath: string
): Promise<LocalAssetSelection> {
  const entries = (await readdir(directoryPath, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))
  const scanLimitReached = entries.length > LOCAL_ASSET_LIMITS.maxScanItems
  const sources: LocalAssetSelectedSource[] = []
  for (const entry of entries.slice(0, LOCAL_ASSET_LIMITS.maxScanItems)) {
    if (entry.name.startsWith('.') || !entry.isFile() || entry.isSymbolicLink()) continue
    const source = await toRegularSource(resolve(directoryPath, entry.name)).catch(() => undefined)
    if (source) sources.push(source)
  }
  return { sources, scanLimitReached }
}

export class ElectronLocalAssetPicker implements LocalAssetPicker {
  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  async select(sourceKind: LocalImportSourceKind): Promise<LocalAssetSelection | undefined> {
    const options: Electron.OpenDialogOptions = sourceKind === 'directory'
      ? {
          title: '选择本地素材文件夹',
          properties: ['openDirectory', 'dontAddToRecent']
        }
      : {
          title: '选择本地素材图片',
          properties: ['openFile', 'multiSelections', 'dontAddToRecent'],
          filters: [{ name: 'PNG、JPEG、WebP 图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
        }
    const window = this.getWindow()
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return undefined
    if (sourceKind === 'directory') return selectLocalAssetDirectory(result.filePaths[0])
    const sources = (await Promise.all(result.filePaths.map((filePath) =>
      toRegularSource(filePath).catch(() => undefined)
    ))).filter((source): source is LocalAssetSelectedSource => source !== undefined)
    return { sources, scanLimitReached: false }
  }
}

/** Test-only picker used by Electron E2E without exposing absolute paths over IPC. */
export class FixedDirectoryLocalAssetPicker implements LocalAssetPicker {
  constructor(private readonly directoryPath: string) {}

  select(): Promise<LocalAssetSelection> {
    return selectLocalAssetDirectory(this.directoryPath)
  }
}
