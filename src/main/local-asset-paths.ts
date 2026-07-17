import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { normalizeLocalAssetId } from '../shared/local-assets'

export const LOCAL_ASSET_DIRECTORY = 'local-assets'
export const LOCAL_ASSET_PATH_SCOPES = ['staging', 'originals', 'thumbnails'] as const

export type LocalAssetPathScope = (typeof LOCAL_ASSET_PATH_SCOPES)[number]
export type ManagedLocalAssetPath =
  | { scope: 'originals'; assetId: string; extension: string }
  | { scope: 'thumbnails'; assetId: string; extension: 'webp' }
  | { scope: 'staging'; sessionId: string; itemId: string; extension: string }
export type LocalAssetPathOwner =
  | { scope: 'originals'; assetId: string }
  | { scope: 'thumbnails'; assetId: string }
  | { scope: 'staging'; sessionId: string; itemId: string }

const SUPPORTED_ORIGINAL_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp'])
const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const ORIGINAL_PATH_PATTERN = new RegExp(`^originals/(${UUID_SOURCE})\\.(png|jpg|jpeg|webp)$`)
const THUMBNAIL_PATH_PATTERN = new RegExp(`^thumbnails/(${UUID_SOURCE})\\.webp$`)
const STAGING_PATH_PATTERN = new RegExp(
  `^staging/(${UUID_SOURCE})/(${UUID_SOURCE})\\.(png|jpg|jpeg|webp)$`
)

function normalizeUuid(value: string, label: string): string {
  const normalized = normalizeLocalAssetId(value)
  if (!normalized) throw new Error(`${label} must be a UUID`)
  return normalized
}

export function parseManagedLocalAssetRelativePath(
  value: string
): ManagedLocalAssetPath | undefined {
  if (!value || isAbsolute(value) || value.includes('\\')) return undefined
  const original = ORIGINAL_PATH_PATTERN.exec(value)
  if (original) return { scope: 'originals', assetId: original[1], extension: original[2] }
  const thumbnail = THUMBNAIL_PATH_PATTERN.exec(value)
  if (thumbnail) return { scope: 'thumbnails', assetId: thumbnail[1], extension: 'webp' }
  const staging = STAGING_PATH_PATTERN.exec(value)
  if (staging) {
    return {
      scope: 'staging',
      sessionId: staging[1],
      itemId: staging[2],
      extension: staging[3]
    }
  }
  return undefined
}

export function isManagedLocalAssetRelativePath(value: string): boolean {
  return parseManagedLocalAssetRelativePath(value) !== undefined
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

  stagingThumbnailPath(sessionId: string, itemId: string): string {
    const session = normalizeUuid(sessionId, 'sessionId')
    const item = normalizeUuid(itemId, 'itemId')
    return this.resolveInternal(`staging/${session}/${item}.thumbnail.webp`)
  }

  deletionStagingPath(
    assetId: string,
    operationId: string,
    kind: 'source' | 'thumbnail'
  ): string {
    const asset = normalizeUuid(assetId, 'assetId')
    const operation = normalizeUuid(operationId, 'operationId')
    return this.resolveInternal(`staging/deletions/${asset}.${operation}.${kind}`)
  }

  resolve(relativePath: string): string {
    if (!parseManagedLocalAssetRelativePath(relativePath)) {
      throw new Error('Managed local-asset path must be canonical and relative')
    }
    return this.resolveContained(relativePath)
  }

  resolveAssetSource(assetId: string, relativePath: string): string {
    const ownerId = normalizeUuid(assetId, 'assetId')
    const parsed = parseManagedLocalAssetRelativePath(relativePath)
    if (parsed?.scope !== 'originals' || parsed.assetId !== ownerId) {
      throw new Error('Managed source path does not belong to the asset')
    }
    return this.resolveContained(relativePath)
  }

  resolveAssetThumbnail(assetId: string, relativePath: string): string {
    const ownerId = normalizeUuid(assetId, 'assetId')
    const parsed = parseManagedLocalAssetRelativePath(relativePath)
    if (parsed?.scope !== 'thumbnails' || parsed.assetId !== ownerId) {
      throw new Error('Managed thumbnail path does not belong to the asset')
    }
    return this.resolveContained(relativePath)
  }

  resolveStagingItem(sessionId: string, itemId: string, relativePath: string): string {
    const ownerSessionId = normalizeUuid(sessionId, 'sessionId')
    const ownerItemId = normalizeUuid(itemId, 'itemId')
    const parsed = parseManagedLocalAssetRelativePath(relativePath)
    if (parsed?.scope !== 'staging' ||
      parsed.sessionId !== ownerSessionId || parsed.itemId !== ownerItemId) {
      throw new Error('Managed staging path does not belong to the import item')
    }
    return this.resolveContained(relativePath)
  }

  async assertOwnedRegularFile(
    relativePath: string,
    owner: LocalAssetPathOwner
  ): Promise<string> {
    const absolutePath = owner.scope === 'staging'
      ? this.resolveStagingItem(owner.sessionId, owner.itemId, relativePath)
      : owner.scope === 'originals'
        ? this.resolveAssetSource(owner.assetId, relativePath)
        : this.resolveAssetThumbnail(owner.assetId, relativePath)
    const stat = await lstat(absolutePath)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Managed local-asset path must be a regular non-link file')
    }
    const canonicalRoot = await realpath(this.rootDirectory)
    const canonicalFile = await realpath(absolutePath)
    this.assertContained(canonicalRoot, canonicalFile)
    return canonicalFile
  }

  async assertInternalRegularFile(absolutePath: string): Promise<string> {
    const lexicalPath = resolve(absolutePath)
    this.assertContained(this.rootDirectory, lexicalPath)
    const stat = await lstat(lexicalPath)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Internal local-asset path must be a regular non-link file')
    }
    const canonicalRoot = await realpath(this.rootDirectory)
    const canonicalFile = await realpath(lexicalPath)
    this.assertContained(canonicalRoot, canonicalFile)
    return canonicalFile
  }

  async assertCanonicalParent(absolutePath: string): Promise<string> {
    const lexicalPath = resolve(absolutePath)
    this.assertContained(this.rootDirectory, lexicalPath)
    const lexicalParent = dirname(lexicalPath)
    const stat = await lstat(lexicalParent)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Managed local-asset parent must be a regular directory')
    }
    const canonicalRoot = await realpath(this.rootDirectory)
    const canonicalParent = await realpath(lexicalParent)
    this.assertContained(canonicalRoot, canonicalParent)
    return canonicalParent
  }

  private resolveContained(relativePath: string): string {
    const absolutePath = resolve(this.rootDirectory, ...relativePath.split('/'))
    this.assertContained(this.rootDirectory, absolutePath)
    return absolutePath
  }

  private resolveInternal(relativePath: string): string {
    if (!relativePath || isAbsolute(relativePath) || relativePath.includes('\\')) {
      throw new Error('Internal local-asset path must be relative')
    }
    const absolutePath = resolve(this.rootDirectory, ...relativePath.split('/'))
    this.assertContained(this.rootDirectory, absolutePath)
    return absolutePath
  }

  toRelative(absolutePath: string): string {
    if (!isAbsolute(absolutePath)) {
      throw new Error('Managed local-asset path must be absolute')
    }
    const fromRoot = relative(this.rootDirectory, resolve(absolutePath))
    const canonical = fromRoot.split(sep).join('/')
    if (!parseManagedLocalAssetRelativePath(canonical)) {
      throw new Error('Path is outside the managed local-asset root')
    }
    return canonical
  }

  private assertContained(root: string, target: string): void {
    const fromRoot = relative(root, target)
    if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error('Managed local-asset path escapes its root')
    }
  }

  private normalizeOriginalExtension(extension: string): string {
    const normalized = extension.replace(/^\./u, '').toLowerCase()
    if (!SUPPORTED_ORIGINAL_EXTENSIONS.has(normalized)) {
      throw new Error('Unsupported local-asset extension')
    }
    return normalized
  }
}
