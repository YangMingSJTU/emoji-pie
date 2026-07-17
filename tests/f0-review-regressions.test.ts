import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { migrateApplicationDatabase } from '../src/main/database-schema'
import {
  registerLocalAssetIpcHandlers,
  type LocalAssetIpcRegistrar,
  type LocalAssetIpcService
} from '../src/main/local-asset-ipc'
import { isManagedLocalAssetRelativePath } from '../src/main/local-asset-paths'
import { LOCAL_ASSET_IPC_CHANNELS } from '../src/shared/local-asset-ipc'

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

const ASSET_ID = '123e4567-e89b-42d3-a456-426614174001'
const OTHER_ASSET_ID = '123e4567-e89b-42d3-a456-426614174002'

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

function registerHandlers(service: LocalAssetIpcService) {
  const handlers = new Map<string, RegisteredHandler>()
  const registrar: LocalAssetIpcRegistrar = {
    handle: (channel, handler) => {
      handlers.set(channel, handler)
    }
  }
  registerLocalAssetIpcHandlers(registrar, service)
  return handlers
}

describe('F0 technical review regressions', () => {
  it('Major 1 exposes durable draft tags and finalize state', () => {
    const database = new DatabaseSync(':memory:')
    migrateApplicationDatabase(database)
    const tables = database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).all() as unknown as Array<{ name: string }>
    const itemColumns = database.prepare(`
      PRAGMA table_info(local_import_items)
    `).all() as unknown as Array<{ name: string }>

    expect(tables.map(({ name }) => name)).toContain('local_import_item_tags')
    expect(itemColumns.map(({ name }) => name)).toContain('finalized_at')
    expect(Object.keys(LOCAL_ASSET_IPC_CHANNELS)).toEqual(expect.arrayContaining([
      'updateImportDraft',
      'finalizeImport'
    ]))
    database.close()
  })

  it('Major 1 prevents ready assets without tags', () => {
    const database = new DatabaseSync(':memory:')
    migrateApplicationDatabase(database)
    expect(() => database.prepare(`
      INSERT INTO local_assets (
        id, display_name, normalized_name, original_filename, mime_type,
        width, height, size_bytes, content_sha256, pixel_sha256,
        source_rel_path, thumbnail_rel_path, state, rights_asserted_at,
        imported_at, updated_at
      ) VALUES (?, '素材', '素材', 'asset.png', 'image/png', 64, 64, 1, ?, ?, ?, ?,
        'ready', 'now', 'now', 'now')
    `).run(
      ASSET_ID,
      'a'.repeat(64),
      'b'.repeat(64),
      `originals/${ASSET_ID}.png`,
      `thumbnails/${ASSET_ID}.webp`
    )).toThrow()
    database.close()
  })

  it('Major 2 strips non-contract fields and rejects unbounded metadata before service', async () => {
    const service = createService()
    const handlers = registerHandlers(service)
    await handlers.get(LOCAL_ASSET_IPC_CHANNELS.beginImport)?.(undefined, {
      sourceKind: 'files',
      rightsConfirmed: true,
      sourcePath: 'C:\\secret.png',
      contentSha256: 'a'.repeat(64)
    })
    expect(service.beginImport).toHaveBeenCalledWith({
      sourceKind: 'files',
      rightsConfirmed: true
    })

    await handlers.get(LOCAL_ASSET_IPC_CHANNELS.updateMetadata)?.(undefined, {
      assetId: ASSET_ID,
      displayName: 'x'.repeat(10_000),
      tags: ['tag']
    })
    expect(service.updateMetadata).not.toHaveBeenCalled()

    await handlers.get(LOCAL_ASSET_IPC_CHANNELS.finalizeImport)?.(undefined, {
      sessionId: ASSET_ID,
      itemIds: Array.from(
        { length: 501 },
        (_, index) => `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`
      )
    })
    expect(service.finalizeImport).not.toHaveBeenCalled()
  })

  it('Major 3 rejects noncanonical grammar and cross-asset database paths', () => {
    expect(isManagedLocalAssetRelativePath('originals/not-a-uuid.exe')).toBe(false)
    expect(isManagedLocalAssetRelativePath('thumbnails/not-a-uuid.txt')).toBe(false)
    expect(isManagedLocalAssetRelativePath('staging/not-a-session/not-an-item.exe')).toBe(false)

    const database = new DatabaseSync(':memory:')
    migrateApplicationDatabase(database)
    expect(() => database.prepare(`
      INSERT INTO local_assets (
        id, display_name, normalized_name, original_filename, mime_type,
        width, height, size_bytes, content_sha256, pixel_sha256,
        source_rel_path, thumbnail_rel_path, state, rights_asserted_at,
        imported_at, updated_at
      ) VALUES (?, '素材', '素材', 'asset.png', 'image/png', 64, 64, 1, ?, ?, ?, ?,
        'committing', 'now', 'now', 'now')
    `).run(
      ASSET_ID,
      'a'.repeat(64),
      'b'.repeat(64),
      `originals/${OTHER_ASSET_ID}.png`,
      `thumbnails/${OTHER_ASSET_ID}.webp`
    )).toThrow()
    database.close()
  })
})
