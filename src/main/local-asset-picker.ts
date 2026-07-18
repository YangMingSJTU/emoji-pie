import { execFile } from 'node:child_process'
import { lstat, readdir } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { BrowserWindow, dialog } from 'electron'
import { LOCAL_ASSET_LIMITS, type LocalAssetErrorCode, type LocalImportSourceKind } from '../shared/local-assets'

const execFileAsync = promisify(execFile)

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
function readFailure(message: string, cause: unknown): Error {
  return Object.assign(new Error(message, { cause }), { code: 'read_failed' as const })
}

export async function readWindowsExcludedLocalAssetPaths(
  directoryPath: string
): Promise<Set<string>> {
  if (process.platform !== 'win32') return new Set()
  const executable = resolve(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const script = [
    '& { param([string] $target)',
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$items = Get-ChildItem -LiteralPath $target -Force -ErrorAction Stop |',
    '  Where-Object {',
    '    ($_.Attributes -band [IO.FileAttributes]::Hidden) -or',
    '    ($_.Attributes -band [IO.FileAttributes]::System) -or',
    '    ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)',
    '  } | ForEach-Object { $_.FullName }',
    '@($items) | ConvertTo-Json -Compress',
    '}'
  ].join("\n")
  try {
    const { stdout } = await execFileAsync(executable, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
      directoryPath
    ], { encoding: 'utf8', timeout: 5_000, maxBuffer: 1024 * 1024, windowsHide: true })
    const parsed: unknown = JSON.parse(stdout.trim() || '[]')
    const paths = Array.isArray(parsed) ? parsed : [parsed]
    return new Set(paths.filter((value): value is string => typeof value === 'string')
      .map((value) => resolve(value).toLowerCase()))
  } catch (error) {
    throw readFailure('无法安全读取 Windows 文件属性', error)
  }
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
  directoryPath: string,
  readExcludedPaths: (directoryPath: string) => Promise<Set<string>> =
    readWindowsExcludedLocalAssetPaths
): Promise<LocalAssetSelection> {
  const entries = (await readdir(directoryPath, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))
  const excludedPaths = await readExcludedPaths(directoryPath)
  const scanLimitReached = entries.length > LOCAL_ASSET_LIMITS.maxScanItems
  const sources: LocalAssetSelectedSource[] = []
  for (const entry of entries.slice(0, LOCAL_ASSET_LIMITS.maxScanItems)) {
    const entryPath = resolve(directoryPath, entry.name)
    if (entry.name.startsWith('.') || excludedPaths.has(entryPath.toLowerCase()) ||
      !entry.isFile() || entry.isSymbolicLink()) continue
    const source = await toRegularSource(entryPath)
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
      toRegularSource(filePath)
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

/** Test-only picker used to exercise typed permission/read failures through real IPC. */
export class FailingLocalAssetPicker implements LocalAssetPicker {
  constructor(
    private readonly code: Extract<LocalAssetErrorCode, 'permission_denied' | 'read_failed'>
  ) {}

  async select(): Promise<never> {
    const systemCode = this.code === 'permission_denied' ? 'EACCES' : this.code
    throw Object.assign(new Error('测试选择器拒绝访问'), { code: systemCode })
  }
}
