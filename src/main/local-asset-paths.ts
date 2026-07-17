import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { normalizeLocalAssetId } from '../shared/local-assets'

export const LOCAL_ASSET_DIRECTORY = 'local-assets'
export const LOCAL_ASSET_PATH_SCOPES = ['staging', 'originals', 'thumbnails'] as const

export type LocalAssetPathScope = (typeof LOCAL_ASSET_PATH_SCOPES)[number]

const SUPPORTED_ORIGINAL_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp'])

function normalizeUuid(value: string, label: string): string {
  const normalized = normalizeLocalAssetId(value)
  if (!normalized) throw new Error(`${label} must be a UUID`)
  return normalized
}

export function isManagedLocalAssetRelativePath(value: string): boolean {
  if (!value || isAbsolute(value) || value.includes('\\')) return false
  const parts = value.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) return false
  if (parts[0] === 'staging') return parts.length === 3
  if (parts[0] === 'originals' || parts[0] === 'thumbnails') return parts.length === 2
  return false
}

export class LocalAssetPathService {
  readonly rootDirectory: string

  constructor(userDataDirectory: string) {
    this.rootDirectory = resolve(userDataDirectory, LOCAL_ASSET_DIRECTORY)
  }

  directory(scope: LocalAssetPathScope): string {
    return join(this.rootDirectory, scope)
  }

  stagingRelativePath(sessionId: string, itemId: string, extension: string): string {
    const session = normalizeUuid(sessionId, 'sessionId')
    const item = normalizeUuid(itemId, 'itemId')
    return `staging/${session}/${item}.${this.normalizeOriginalExtension(extension)}`
  }

  originalRelativePath(assetId: string, extension: string): string {
    const asset = normalizeUuid(assetId, 'assetId')
    return `originals/${asset}.${this.normalizeOriginalExtension(extension)}`
  }

  thumbnailRelativePath(assetId: string): string {
    const asset = normalizeUuid(assetId, 'assetId')
    return `thumbnails/${asset}.webp`
  }

  resolve(relativePath: string): string {
    if (!isManagedLocalAssetRelativePath(relativePath)) {
      throw new Error('Managed local-asset path must be canonical and relative')
    }
    const absolutePath = resolve(this.rootDirectory, ...relativePath.split('/'))
    const fromRoot = relative(this.rootDirectory, absolutePath)
    if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error('Managed local-asset path escapes its root')
    }
    return absolutePath
  }

  toRelative(absolutePath: string): string {
    if (!isAbsolute(absolutePath)) {
      throw new Error('Managed local-asset path must be absolute')
    }
    const fromRoot = relative(this.rootDirectory, resolve(absolutePath))
    const canonical = fromRoot.split(sep).join('/')
    if (!isManagedLocalAssetRelativePath(canonical)) {
      throw new Error('Path is outside the managed local-asset root')
    }
    return canonical
  }

  private normalizeOriginalExtension(extension: string): string {
    const normalized = extension.replace(/^\./u, '').toLowerCase()
    if (!SUPPORTED_ORIGINAL_EXTENSIONS.has(normalized)) {
      throw new Error('Unsupported local-asset extension')
    }
    return normalized
  }
}
