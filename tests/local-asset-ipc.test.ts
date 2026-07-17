import { describe, expect, it, vi } from 'vitest'
import {
  registerLocalAssetIpcHandlers,
  type LocalAssetIpcRegistrar,
  type LocalAssetIpcService
} from '../src/main/local-asset-ipc'
import {
  LOCAL_ASSET_TEST_FIXTURE_VERSION,
  type LocalAssetTestFixtureManifest
} from '../src/main/local-asset-test-fixtures'
import { createLocalAssetApi } from '../src/preload/local-asset-api'
import { LOCAL_ASSET_IPC_CHANNELS } from '../src/shared/local-asset-ipc'

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

const SESSION_ID = '123E4567-E89B-42D3-A456-426614174000'
const ITEM_ID = '123E4567-E89B-42D3-A456-426614174001'

function failedResult() {
  return {
    ok: false as const,
    error: { code: 'import_failed' as const, message: 'fixture', retryable: true }
  }
}

function createService(): LocalAssetIpcService {
  return {
    list: vi.fn(async () => failedResult()),
    beginImport: vi.fn(async () => failedResult()),
    getImportSession: vi.fn(async () => failedResult()),
    retryImportItems: vi.fn(async () => failedResult()),
    cancelImport: vi.fn(async () => failedResult()),
    updateImportDraft: vi.fn(async () => failedResult()),
    finalizeImport: vi.fn(async () => failedResult()),
    updateMetadata: vi.fn(async () => failedResult()),
    delete: vi.fn(async () => failedResult())
  }
}

describe('local asset typed IPC', () => {
  it('registers the frozen channel set and lowercases UUIDs before the service boundary', async () => {
    const handlers = new Map<string, RegisteredHandler>()
    const registrar: LocalAssetIpcRegistrar = {
      handle: (channel, handler) => {
        handlers.set(channel, handler)
      }
    }
    const service = createService()
    registerLocalAssetIpcHandlers(registrar, service)

    expect([...handlers.keys()]).toEqual(Object.values(LOCAL_ASSET_IPC_CHANNELS))
    await handlers.get(LOCAL_ASSET_IPC_CHANNELS.retryImportItems)?.(undefined, {
      sessionId: SESSION_ID,
      itemIds: [ITEM_ID]
    })
    expect(service.retryImportItems).toHaveBeenCalledWith({
      sessionId: SESSION_ID.toLowerCase(),
      itemIds: [ITEM_ID.toLowerCase()]
    })
  })

  it('rejects malformed and duplicate item requests before invoking the service', async () => {
    const handlers = new Map<string, RegisteredHandler>()
    const service = createService()
    registerLocalAssetIpcHandlers({
      handle: (channel, handler) => {
        handlers.set(channel, handler)
      }
    }, service)

    const result = await handlers.get(LOCAL_ASSET_IPC_CHANNELS.retryImportItems)?.(undefined, {
      sessionId: SESSION_ID,
      itemIds: [ITEM_ID, ITEM_ID.toLowerCase()]
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect(service.retryImportItems).not.toHaveBeenCalled()
  })

  it('creates a preload adapter that forwards only typed channels and DTOs', async () => {
    const invoke = vi.fn(async () => failedResult())
    const api = createLocalAssetApi({ invoke })

    await api.delete({ assetId: SESSION_ID })
    expect(invoke).toHaveBeenCalledWith(
      LOCAL_ASSET_IPC_CHANNELS.delete,
      { assetId: SESSION_ID }
    )
  })
})

describe('local asset test fixture contract', () => {
  it('keeps fixture source paths in the main-process-only manifest', () => {
    const fixture: LocalAssetTestFixtureManifest = {
      version: LOCAL_ASSET_TEST_FIXTURE_VERSION,
      rightsAssertedAt: '2026-07-17T00:00:00.000Z',
      items: [{
        id: SESSION_ID.toLowerCase(),
        sourcePath: 'D:\\fixtures\\asset.png',
        originalFilename: 'asset.png',
        displayName: '素材',
        tags: ['测试'],
        mimeType: 'image/png',
        expectedOutcome: {
          kind: 'ready',
          contentSha256: 'a'.repeat(64),
          pixelSha256: 'b'.repeat(64)
        }
      }]
    }
    expect(fixture.version).toBe(1)
    expect(fixture.items[0].sourcePath).toContain('fixtures')
  })
})
