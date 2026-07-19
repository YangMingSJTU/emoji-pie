import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import {
  normalizeStarterPackRuntimeManifest,
  type AssetContentState,
  type StarterPackErrorCode,
  type StarterPackRuntimeAsset,
  type StarterPackRuntimeManifest
} from '../shared/starter-packs'
import { StarterPackPathError, StarterPackPathService } from './starter-pack-paths'

const MAX_RUNTIME_MANIFEST_BYTES = 1024 * 1024

export interface StarterPackCatalogAsset extends StarterPackRuntimeAsset {
  contentState: AssetContentState
  originalPath?: string
  thumbnailPath?: string
}

export interface StarterPackCatalogSnapshot {
  manifest: StarterPackRuntimeManifest
  assets: StarterPackCatalogAsset[]
  readyCount: number
}

export class StarterPackCatalogError extends Error {
  constructor(readonly code: StarterPackErrorCode, message: string) {
    super(message)
    this.name = 'StarterPackCatalogError'
  }
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return hash.digest('hex')
}

export class StarterPackCatalog {
  constructor(private readonly paths: StarterPackPathService) {}

  async load(packId: string, expectedVersion: string): Promise<StarterPackCatalogSnapshot> {
    const manifestPath = await this.paths.resolveRegularPackFile(packId, 'manifest.json')
    const manifestStat = await stat(manifestPath)
    if (manifestStat.size <= 0 || manifestStat.size > MAX_RUNTIME_MANIFEST_BYTES) {
      throw new StarterPackCatalogError(
        'starter_pack_manifest_invalid',
        'Starter Pack runtime manifest size is invalid'
      )
    }
    let manifest: StarterPackRuntimeManifest | undefined
    try {
      const chunks: Buffer[] = []
      await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(manifestPath)
        stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        stream.on('error', reject)
        stream.on('end', resolve)
      })
      manifest = normalizeStarterPackRuntimeManifest(
        JSON.parse(Buffer.concat(chunks).toString('utf8'))
      )
    } catch {
      manifest = undefined
    }
    if (!manifest || manifest.packId !== packId || manifest.packVersion !== expectedVersion) {
      throw new StarterPackCatalogError(
        'starter_pack_manifest_invalid',
        'Starter Pack runtime manifest is invalid or has the wrong identity'
      )
    }

    const assets: StarterPackCatalogAsset[] = []
    for (const asset of manifest.assets) {
      assets.push(await this.verifyAsset(packId, asset))
    }
    return {
      manifest,
      assets,
      readyCount: assets.filter(({ contentState }) => contentState === 'ready').length
    }
  }

  private async verifyAsset(
    packId: string,
    asset: StarterPackRuntimeAsset
  ): Promise<StarterPackCatalogAsset> {
    let originalPath: string
    let thumbnailPath: string
    try {
      [originalPath, thumbnailPath] = await Promise.all([
        this.paths.resolveRegularPackFile(packId, asset.file),
        this.paths.resolveRegularPackFile(packId, asset.thumbnailFile)
      ])
    } catch (error) {
      if (
        error instanceof StarterPackPathError &&
        error.code === 'starter_pack_file_missing'
      ) {
        return { ...asset, contentState: 'missing' }
      }
      return { ...asset, contentState: 'corrupt' }
    }

    const [originalStat, thumbnailStat] = await Promise.all([
      stat(originalPath),
      stat(thumbnailPath)
    ])
    if (
      originalStat.size !== asset.sizeBytes ||
      thumbnailStat.size !== asset.thumbnailBytes
    ) {
      return { ...asset, contentState: 'corrupt' }
    }
    const [originalHash, thumbnailHash] = await Promise.all([
      fileSha256(originalPath),
      fileSha256(thumbnailPath)
    ])
    if (originalHash !== asset.sha256 || thumbnailHash !== asset.thumbnailSha256) {
      return { ...asset, contentState: 'corrupt' }
    }
    return {
      ...asset,
      contentState: 'ready',
      originalPath,
      thumbnailPath
    }
  }
}
