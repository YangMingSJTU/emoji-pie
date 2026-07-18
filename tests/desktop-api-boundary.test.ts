import { describe, expect, it, vi } from 'vitest'
import { createDesktopApi } from '../src/preload/desktop-api'
import { LOCAL_ASSET_IPC_CHANNELS } from '../src/shared/local-asset-ipc'

const ASSET_ID = '123e4567-e89b-42d3-a456-426614174000'

describe('real DesktopApi preload composition', () => {
  it('exposes exactly the frozen local asset methods through typed channels', async () => {
    const invoke = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'feature_unavailable' as const, message: 'disabled', retryable: false }
    }))
    const api = createDesktopApi({ invoke })

    expect(Object.keys(api.localAssets)).toEqual(Object.keys(LOCAL_ASSET_IPC_CHANNELS))
    await api.localAssets.finalizeImport({ sessionId: ASSET_ID, itemIds: [ASSET_ID] })
    expect(invoke).toHaveBeenCalledWith(
      LOCAL_ASSET_IPC_CHANNELS.finalizeImport,
      { sessionId: ASSET_ID, itemIds: [ASSET_ID] }
    )
  })

  it('projects renderer-safe DTOs and drops managed paths and hashes', async () => {
    const invoke = vi.fn(async () => ({
      ok: true as const,
      value: [{
        id: ASSET_ID,
        displayName: '素材',
        originalFilename: 'asset.png',
        mimeType: 'image/png' as const,
        width: 64,
        height: 64,
        sizeBytes: 128,
        tags: [{ displayValue: '标签', normalizedValue: '标签', internal: 'drop' }],
        thumbnailUrl: 'emoji-pie-local://thumbnail',
        rightsAssertedAt: '2026-07-17T00:00:00.000Z',
        importedAt: '2026-07-17T00:00:00.000Z',
        updatedAt: '2026-07-17T00:00:00.000Z',
        sourceRelPath: `originals/${ASSET_ID}.png`,
        thumbnailRelPath: `thumbnails/${ASSET_ID}.webp`,
        contentSha256: 'a'.repeat(64),
        pixelSha256: 'b'.repeat(64)
      }]
    }))
    const result = await createDesktopApi({ invoke }).localAssets.list()

    expect(result).toEqual({
      ok: true,
      value: [{
        id: ASSET_ID,
        displayName: '素材',
        originalFilename: 'asset.png',
        mimeType: 'image/png',
        width: 64,
        height: 64,
        sizeBytes: 128,
        tags: [{ displayValue: '标签', normalizedValue: '标签' }],
        thumbnailUrl: 'emoji-pie-local://thumbnail',
        rightsAssertedAt: '2026-07-17T00:00:00.000Z',
        importedAt: '2026-07-17T00:00:00.000Z',
        updatedAt: '2026-07-17T00:00:00.000Z'
      }]
    })
  })
})
