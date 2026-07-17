import { readFile } from 'node:fs/promises'
import type { LocalAssetPathService } from './local-asset-paths'
import type { LocalAssetRepository } from './local-asset-repository'

export const LOCAL_ASSET_PROTOCOL = 'emoji-pie-local-asset'

export function localAssetThumbnailUrl(assetId: string): string {
  return `${LOCAL_ASSET_PROTOCOL}://thumbnail/${assetId}`
}

export function readThumbnailAssetId(urlValue: string): string | undefined {
  try {
    const url = new URL(urlValue)
    if (url.protocol !== `${LOCAL_ASSET_PROTOCOL}:` || url.hostname !== 'thumbnail') {
      return undefined
    }
    const assetId = url.pathname.replace(/^\//u, '')
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
      .test(assetId) ? assetId : undefined
  } catch {
    return undefined
  }
}

export function createLocalAssetProtocolHandler(
  repository: LocalAssetRepository,
  paths: LocalAssetPathService
): (request: Request) => Promise<Response> {
  return async (request) => {
    const assetId = readThumbnailAssetId(request.url)
    if (!assetId) return new Response('Not found', { status: 404 })
    const asset = repository.getStoredAsset(assetId)
    if (!asset || asset.state !== 'ready') return new Response('Not found', { status: 404 })
    try {
      const filePath = await paths.assertOwnedRegularFile(asset.thumbnailRelativePath, {
        scope: 'thumbnails',
        assetId
      })
      return new Response(await readFile(filePath), {
        status: 200,
        headers: {
          'Content-Type': 'image/webp',
          'Cache-Control': 'private, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff'
        }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  }
}
