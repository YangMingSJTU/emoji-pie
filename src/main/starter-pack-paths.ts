import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { StarterPackErrorCode } from '../shared/starter-packs'

const PACK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const PACK_FILE_PATTERN = /^(?:manifest\.json|originals\/[a-z0-9]+(?:-[a-z0-9]+)*\.png|thumbnails\/[a-z0-9]+(?:-[a-z0-9]+)*\.webp)$/

export interface StarterPackRuntimeLocation {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
}

export class StarterPackPathError extends Error {
  constructor(readonly code: StarterPackErrorCode, message: string) {
    super(message)
    this.name = 'StarterPackPathError'
  }
}

export function resolveStarterPackRoot(location: StarterPackRuntimeLocation): string {
  return location.isPackaged
    ? resolve(location.resourcesPath, 'starter-packs')
    : resolve(location.appPath, '.generated', 'starter-packs')
}

export class StarterPackPathService {
  readonly rootDirectory: string

  constructor(location: StarterPackRuntimeLocation) {
    this.rootDirectory = resolveStarterPackRoot(location)
  }

  packDirectory(packId: string): string {
    this.assertPackId(packId)
    return this.resolveContained(packId)
  }

  manifestPath(packId: string): string {
    return this.resolvePackFile(packId, 'manifest.json')
  }

  resolvePackFile(packId: string, relativePath: string): string {
    this.assertPackId(packId)
    if (
      !relativePath ||
      isAbsolute(relativePath) ||
      relativePath.includes('\\') ||
      !PACK_FILE_PATTERN.test(relativePath)
    ) {
      throw new StarterPackPathError(
        'starter_pack_path_invalid',
        'Starter Pack path must be canonical and relative'
      )
    }
    return this.resolveContained(`${packId}/${relativePath}`)
  }

  async resolveRegularPackFile(packId: string, relativePath: string): Promise<string> {
    const candidate = this.resolvePackFile(packId, relativePath)
    let fileStat
    try {
      fileStat = await lstat(candidate)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new StarterPackPathError('starter_pack_file_missing', 'Starter Pack file is missing')
      }
      throw error
    }
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new StarterPackPathError(
        'starter_pack_file_not_regular',
        'Starter Pack resource must be a regular file'
      )
    }
    const [canonicalRoot, canonicalFile] = await Promise.all([
      realpath(this.rootDirectory),
      realpath(candidate)
    ])
    if (!this.isContained(canonicalRoot, canonicalFile)) {
      throw new StarterPackPathError(
        'starter_pack_path_escape',
        'Starter Pack resource escapes the read-only resource root'
      )
    }
    return canonicalFile
  }

  private assertPackId(packId: string): void {
    if (!PACK_ID_PATTERN.test(packId)) {
      throw new StarterPackPathError('starter_pack_path_invalid', 'Starter Pack ID is invalid')
    }
  }

  private resolveContained(relativePath: string): string {
    const candidate = resolve(this.rootDirectory, ...relativePath.split('/'))
    if (!this.isContained(this.rootDirectory, candidate)) {
      throw new StarterPackPathError(
        'starter_pack_path_escape',
        'Starter Pack resource escapes the read-only resource root'
      )
    }
    return candidate
  }

  private isContained(root: string, candidate: string): boolean {
    const child = relative(root, candidate)
    return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
  }
}
