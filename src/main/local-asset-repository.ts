import { DatabaseSync } from 'node:sqlite'
import {
  LOCAL_ASSET_LIMITS,
  normalizeLocalAssetText,
  validateLocalAssetMetadata,
  type LocalAssetDto,
  type LocalAssetErrorCode,
  type LocalAssetMimeType,
  type LocalAssetResult,
  type LocalAssetTagDto,
  type LocalImportFinalizeResultDto,
  type LocalImportItemDto,
  type LocalImportSessionDto,
  type LocalImportSourceKind,
  type UpdateLocalAssetMetadataRequest,
  type UpdateLocalImportDraftRequest,
  type FinalizeLocalImportRequest,
  type RetryLocalImportItemsRequest
} from '../shared/local-assets'
import { migrateApplicationDatabase } from './database-schema'
import { LocalImportContractStore } from './local-import-contract'

interface AssetRow {
  id: string
  display_name: string
  original_filename: string
  mime_type: LocalAssetMimeType
  width: number
  height: number
  size_bytes: number
  content_sha256: string
  pixel_sha256: string
  source_rel_path: string
  thumbnail_rel_path: string
  state: 'committing' | 'ready'
  rights_asserted_at: string
  imported_at: string
  updated_at: string
}

interface ImportItemRow {
  id: string
  session_id: string
  original_filename: string
  staging_rel_path: string | null
  display_name: string | null
  normalized_name: string | null
  mime_type: LocalAssetMimeType | null
  width: number | null
  height: number | null
  size_bytes: number | null
  content_sha256: string | null
  pixel_sha256: string | null
  state: LocalImportItemDto['state']
  error_code: LocalAssetErrorCode | null
  imported_asset_id: string | null
}

interface TagRow {
  display_value: string
  normalized_value: string
}

export interface StoredLocalAsset extends LocalAssetDto {
  contentSha256: string
  pixelSha256: string
  sourceRelativePath: string
  thumbnailRelativePath: string
  state: 'committing' | 'ready'
}

export type StoredLocalImportItem = ImportItemRow

function failure<T>(
  code: LocalAssetErrorCode,
  message: string,
  retryable = false
): LocalAssetResult<T> {
  return { ok: false, error: { code, message, retryable } }
}

export class LocalAssetRepositoryError extends Error {
  constructor(readonly code: LocalAssetErrorCode, message: string) {
    super(message)
    this.name = 'LocalAssetRepositoryError'
  }
}

export class LocalAssetRepository {
  private readonly database: DatabaseSync
  private readonly ownsDatabase: boolean
  private readonly importContracts: LocalImportContractStore

  constructor(
    database: DatabaseSync | string,
    private readonly thumbnailUrl: (assetId: string) => string,
    private readonly now: () => string = () => new Date().toISOString()
  ) {
    this.ownsDatabase = typeof database === 'string'
    this.database = typeof database === 'string' ? new DatabaseSync(database) : database
    migrateApplicationDatabase(this.database)
    this.database.exec('PRAGMA journal_mode = WAL;')
    this.importContracts = new LocalImportContractStore(this.database, now)
  }

  list(): LocalAssetDto[] {
    return this.listStored('ready').map((asset) => this.projectAsset(asset))
  }

  listStored(state?: 'committing' | 'ready'): StoredLocalAsset[] {
    const rows = this.database.prepare(`
      SELECT id, display_name, original_filename, mime_type, width, height, size_bytes,
        content_sha256, pixel_sha256, source_rel_path, thumbnail_rel_path, state,
        rights_asserted_at, imported_at, updated_at
      FROM local_assets
      ${state ? 'WHERE state = ?' : ''}
      ORDER BY imported_at DESC, id ASC
    `).all(...(state ? [state] : [])) as unknown as AssetRow[]
    return rows.map((row) => this.mapStoredAsset(row))
  }

  getStoredAsset(assetId: string): StoredLocalAsset | undefined {
    const row = this.database.prepare(`
      SELECT id, display_name, original_filename, mime_type, width, height, size_bytes,
        content_sha256, pixel_sha256, source_rel_path, thumbnail_rel_path, state,
        rights_asserted_at, imported_at, updated_at
      FROM local_assets WHERE id = ?
    `).get(assetId) as unknown as AssetRow | undefined
    return row ? this.mapStoredAsset(row) : undefined
  }

  countReady(): number {
    return (this.database.prepare(`
      SELECT COUNT(*) AS count FROM local_assets WHERE state = 'ready'
    `).get() as { count: number }).count
  }

  findReadyDuplicate(
    contentSha256: string,
    pixelSha256?: string
  ): { assetId: string; code: 'duplicate_content' | 'duplicate_pixels' } | undefined {
    const content = this.database.prepare(`
      SELECT id FROM local_assets WHERE state = 'ready' AND content_sha256 = ? LIMIT 1
    `).get(contentSha256) as { id: string } | undefined
    if (content) return { assetId: content.id, code: 'duplicate_content' }
    if (!pixelSha256) return undefined
    const pixels = this.database.prepare(`
      SELECT id FROM local_assets WHERE state = 'ready' AND pixel_sha256 = ? LIMIT 1
    `).get(pixelSha256) as { id: string } | undefined
    return pixels ? { assetId: pixels.id, code: 'duplicate_pixels' } : undefined
  }

  hasImportDuplicate(
    itemId: string,
    contentSha256: string,
    pixelSha256?: string
  ): 'duplicate_content' | 'duplicate_pixels' | undefined {
    const content = this.database.prepare(`
      SELECT 1 FROM local_import_items
      WHERE id != ? AND content_sha256 = ?
        AND state IN ('staged', 'processing', 'committing', 'ready', 'duplicate')
      LIMIT 1
    `).get(itemId, contentSha256)
    if (content) return 'duplicate_content'
    if (!pixelSha256) return undefined
    const pixels = this.database.prepare(`
      SELECT 1 FROM local_import_items
      WHERE id != ? AND pixel_sha256 = ?
        AND state IN ('staged', 'processing', 'committing', 'ready', 'duplicate')
      LIMIT 1
    `).get(itemId, pixelSha256)
    return pixels ? 'duplicate_pixels' : undefined
  }

  createImportSession(
    id: string,
    sourceKind: LocalImportSourceKind,
    rightsAssertedAt: string
  ): void {
    const timestamp = this.now()
    this.database.prepare(`
      INSERT INTO local_import_sessions (
        id, source_kind, state, rights_asserted_at, created_at, updated_at
      ) VALUES (?, ?, 'active', ?, ?, ?)
    `).run(id, sourceKind, rightsAssertedAt, timestamp, timestamp)
  }

  addImportItem(input: {
    id: string
    sessionId: string
    originalFilename: string
    stagingRelativePath: string
    displayName: string
  }): void {
    const timestamp = this.now()
    this.database.prepare(`
      INSERT INTO local_import_items (
        id, session_id, original_filename, staging_rel_path, display_name,
        normalized_name, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'processing', ?, ?)
    `).run(
      input.id,
      input.sessionId,
      input.originalFilename,
      input.stagingRelativePath,
      input.displayName,
      normalizeLocalAssetText(input.displayName),
      timestamp,
      timestamp
    )
  }

  getImportItem(itemId: string): StoredLocalImportItem | undefined {
    return this.database.prepare(`
      SELECT id, session_id, original_filename, staging_rel_path, display_name,
        normalized_name, mime_type, width, height, size_bytes, content_sha256,
        pixel_sha256, state, error_code, imported_asset_id
      FROM local_import_items WHERE id = ?
    `).get(itemId) as unknown as StoredLocalImportItem | undefined
  }

  setProcessingContentHash(itemId: string, contentSha256: string): void {
    this.database.prepare(`
      UPDATE local_import_items SET content_sha256 = ?, updated_at = ?
      WHERE id = ? AND state = 'processing'
    `).run(contentSha256, this.now(), itemId)
  }

  setProcessingPixelHash(itemId: string, pixelSha256: string): void {
    this.database.prepare(`
      UPDATE local_import_items SET pixel_sha256 = ?, updated_at = ?
      WHERE id = ? AND state = 'processing'
    `).run(pixelSha256, this.now(), itemId)
  }


  findImportItemByAssetId(assetId: string): StoredLocalImportItem | undefined {
    return this.database.prepare(`
      SELECT id, session_id, original_filename, staging_rel_path, display_name,
        normalized_name, mime_type, width, height, size_bytes, content_sha256,
        pixel_sha256, state, error_code, imported_asset_id
      FROM local_import_items WHERE imported_asset_id = ? OR (
        state = 'committing' AND EXISTS (
          SELECT 1 FROM local_assets
          WHERE local_assets.id = ?
            AND local_assets.content_sha256 = local_import_items.content_sha256
            AND local_assets.pixel_sha256 = local_import_items.pixel_sha256
        )
      )
      LIMIT 1
    `).get(assetId, assetId) as unknown as StoredLocalImportItem | undefined
  }

  getSession(sessionId: string): LocalAssetResult<LocalImportSessionDto> {
    return this.importContracts.getSession(sessionId)
  }

  updateDraft(
    request: UpdateLocalImportDraftRequest
  ): LocalAssetResult<LocalImportItemDto> {
    return this.importContracts.updateDraft(request)
  }

  finalizeDraft(
    request: FinalizeLocalImportRequest
  ): LocalAssetResult<LocalImportFinalizeResultDto> {
    return this.importContracts.finalize(request)
  }

  retryFailed(
    request: RetryLocalImportItemsRequest
  ): LocalAssetResult<LocalImportSessionDto> {
    return this.importContracts.retryFailed(request)
  }

  cancel(sessionId: string): LocalAssetResult<LocalImportSessionDto> {
    return this.importContracts.cancel(sessionId)
  }

  markProcessing(itemIds: readonly string[]): void {
    const timestamp = this.now()
    const update = this.database.prepare(`
      UPDATE local_import_items
      SET state = 'processing', error_code = NULL, updated_at = ?
      WHERE id = ? AND state = 'staged'
    `)
    this.transaction(() => {
      for (const itemId of itemIds) update.run(timestamp, itemId)
    })
  }

  markItemStaged(input: {
    itemId: string
    mimeType: LocalAssetMimeType
    width: number
    height: number
    sizeBytes: number
    contentSha256: string
    pixelSha256: string
  }): void {
    this.database.prepare(`
      UPDATE local_import_items
      SET mime_type = ?, width = ?, height = ?, size_bytes = ?, content_sha256 = ?,
        pixel_sha256 = ?, state = 'staged', error_code = NULL, updated_at = ?
      WHERE id = ? AND state = 'processing'
    `).run(
      input.mimeType,
      input.width,
      input.height,
      input.sizeBytes,
      input.contentSha256,
      input.pixelSha256,
      this.now(),
      input.itemId
    )
  }

  markItemDuplicate(
    itemId: string,
    code: 'duplicate_content' | 'duplicate_pixels',
    duplicateAssetId: string | undefined,
    hashes: { contentSha256: string; pixelSha256?: string }
  ): void {
    this.database.prepare(`
      UPDATE local_import_items
      SET state = 'duplicate', error_code = ?, duplicate_asset_id = ?,
        content_sha256 = ?, pixel_sha256 = COALESCE(?, pixel_sha256),
        staging_rel_path = NULL, updated_at = ?
      WHERE id = ? AND state = 'processing'
    `).run(
      code,
      duplicateAssetId ?? null,
      hashes.contentSha256,
      hashes.pixelSha256 ?? null,
      this.now(),
      itemId
    )
  }

  markItemFailed(itemId: string, code: LocalAssetErrorCode): void {
    this.database.prepare(`
      UPDATE local_import_items
      SET state = 'failed', error_code = ?, finalized_at = NULL, updated_at = ?
      WHERE id = ? AND state IN ('processing', 'staged', 'committing')
    `).run(code, this.now(), itemId)
  }

  prepareAssetCommit(input: {
    itemId: string
    assetId: string
    sourceRelativePath: string
    thumbnailRelativePath: string
  }): void {
    const item = this.getImportItem(input.itemId)
    if (!item || item.state !== 'committing' || !item.display_name || !item.normalized_name ||
      !item.mime_type || item.width === null || item.height === null || item.size_bytes === null ||
      !item.content_sha256 || !item.pixel_sha256) {
      throw new Error('Import item is not ready for commit')
    }
    const session = this.database.prepare(`
      SELECT rights_asserted_at FROM local_import_sessions WHERE id = ?
    `).get(item.session_id) as { rights_asserted_at: string } | undefined
    if (!session) throw new Error('Import session is missing')
    const tags = this.readImportTags(item.id)
    const timestamp = this.now()
    this.transaction(() => {
      const storedCount = (this.database.prepare(`
        SELECT COUNT(*) AS count FROM local_assets
      `).get() as { count: number }).count
      if (storedCount >= LOCAL_ASSET_LIMITS.maxReadyAssets) {
        throw new LocalAssetRepositoryError(
          'library_capacity_reached',
          '本地素材库已达到 500 张上限'
        )
      }
      this.database.prepare(`
        INSERT INTO local_assets (
          id, display_name, normalized_name, original_filename, mime_type, width,
          height, size_bytes, content_sha256, pixel_sha256, source_rel_path,
          thumbnail_rel_path, state, rights_asserted_at, imported_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'committing', ?, ?, ?)
      `).run(
        input.assetId,
        item.display_name,
        item.normalized_name,
        item.original_filename,
        item.mime_type,
        item.width,
        item.height,
        item.size_bytes,
        item.content_sha256,
        item.pixel_sha256,
        input.sourceRelativePath,
        input.thumbnailRelativePath,
        session.rights_asserted_at,
        timestamp,
        timestamp
      )
      const insertTag = this.database.prepare(`
        INSERT INTO local_asset_tags (
          asset_id, display_value, normalized_value, ordinal
        ) VALUES (?, ?, ?, ?)
      `)
      tags.forEach((tag, ordinal) => {
        insertTag.run(input.assetId, tag.displayValue, tag.normalizedValue, ordinal)
      })
    })
  }

  finishAssetCommit(assetId: string, itemId: string): LocalAssetDto {
    const timestamp = this.now()
    this.transaction(() => {
      this.database.prepare(`
        UPDATE local_assets SET state = 'ready', updated_at = ?
        WHERE id = ? AND state = 'committing'
      `).run(timestamp, assetId)
      this.database.prepare(`
        UPDATE local_import_items
        SET state = 'ready', imported_asset_id = ?, staging_rel_path = NULL,
          error_code = NULL, updated_at = ?
        WHERE id = ? AND state = 'committing'
      `).run(assetId, timestamp, itemId)
      this.completeSessionIfTerminal(itemId, timestamp)
    })
    const asset = this.getStoredAsset(assetId)
    if (!asset) throw new Error('Committed local asset is missing')
    return this.projectAsset(asset)
  }

  rollbackAssetCommit(assetId: string, itemId: string, code: LocalAssetErrorCode): void {
    const timestamp = this.now()
    this.transaction(() => {
      this.database.prepare(`DELETE FROM local_assets WHERE id = ? AND state = 'committing'`)
        .run(assetId)
      this.database.prepare(`
        UPDATE local_import_items
        SET state = 'failed', error_code = ?, finalized_at = NULL, updated_at = ?
        WHERE id = ? AND state = 'committing'
      `).run(code, timestamp, itemId)
    })
  }

  updateMetadata(
    request: UpdateLocalAssetMetadataRequest
  ): LocalAssetResult<LocalAssetDto> {
    const issues = validateLocalAssetMetadata(request.displayName, request.tags)
    if (issues.length > 0) return failure(issues[0].code, '素材名称或标签无效')
    const asset = this.getStoredAsset(request.assetId)
    if (!asset) return failure('asset_not_found', '找不到本地素材')
    if (asset.state !== 'ready') return failure('asset_not_ready', '本地素材尚未就绪')
    const displayName = request.displayName.normalize('NFKC').trim()
    const tags = request.tags.map((tag) => ({
      displayValue: tag.normalize('NFKC').trim(),
      normalizedValue: normalizeLocalAssetText(tag)
    }))
    const timestamp = this.now()
    this.transaction(() => {
      this.database.prepare(`UPDATE local_assets SET state = 'committing' WHERE id = ?`)
        .run(request.assetId)
      this.database.prepare(`DELETE FROM local_asset_tags WHERE asset_id = ?`)
        .run(request.assetId)
      const insertTag = this.database.prepare(`
        INSERT INTO local_asset_tags (
          asset_id, display_value, normalized_value, ordinal
        ) VALUES (?, ?, ?, ?)
      `)
      tags.forEach((tag, ordinal) => {
        insertTag.run(request.assetId, tag.displayValue, tag.normalizedValue, ordinal)
      })
      this.database.prepare(`
        UPDATE local_assets
        SET display_name = ?, normalized_name = ?, state = 'ready', updated_at = ?
        WHERE id = ?
      `).run(displayName, normalizeLocalAssetText(displayName), timestamp, request.assetId)
    })
    return { ok: true, value: this.projectAsset(this.getStoredAsset(request.assetId)!) }
  }

  deleteAssetRecord(assetId: string): boolean {
    return this.database.prepare(`DELETE FROM local_assets WHERE id = ? AND state = 'ready'`)
      .run(assetId).changes === 1
  }

  restoreAsset(asset: StoredLocalAsset): void {
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO local_assets (
          id, display_name, normalized_name, original_filename, mime_type, width,
          height, size_bytes, content_sha256, pixel_sha256, source_rel_path,
          thumbnail_rel_path, state, rights_asserted_at, imported_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'committing', ?, ?, ?)
      `).run(
        asset.id,
        asset.displayName,
        normalizeLocalAssetText(asset.displayName),
        asset.originalFilename,
        asset.mimeType,
        asset.width,
        asset.height,
        asset.sizeBytes,
        asset.contentSha256,
        asset.pixelSha256,
        asset.sourceRelativePath,
        asset.thumbnailRelativePath,
        asset.rightsAssertedAt,
        asset.importedAt,
        asset.updatedAt
      )
      const insertTag = this.database.prepare(`
        INSERT INTO local_asset_tags (
          asset_id, display_value, normalized_value, ordinal
        ) VALUES (?, ?, ?, ?)
      `)
      asset.tags.forEach((tag, ordinal) => {
        insertTag.run(asset.id, tag.displayValue, tag.normalizedValue, ordinal)
      })
      this.database.prepare(`UPDATE local_assets SET state = 'ready' WHERE id = ?`)
        .run(asset.id)
    })
  }

  close(): void {
    if (this.ownsDatabase) this.database.close()
  }

  private mapStoredAsset(row: AssetRow): StoredLocalAsset {
    return {
      id: row.id,
      source: 'user',
      contentState: 'ready',
      canEdit: true,
      canDelete: true,
      displayName: row.display_name,
      originalFilename: row.original_filename,
      mimeType: row.mime_type,
      width: row.width,
      height: row.height,
      sizeBytes: row.size_bytes,
      tags: this.readAssetTags(row.id),
      thumbnailUrl: this.thumbnailUrl(row.id),
      rightsAssertedAt: row.rights_asserted_at,
      importedAt: row.imported_at,
      updatedAt: row.updated_at,
      contentSha256: row.content_sha256,
      pixelSha256: row.pixel_sha256,
      sourceRelativePath: row.source_rel_path,
      thumbnailRelativePath: row.thumbnail_rel_path,
      state: row.state
    }
  }

  private projectAsset(asset: StoredLocalAsset): LocalAssetDto {
    return {
      id: asset.id,
      source: asset.source,
      contentState: asset.contentState,
      canEdit: asset.canEdit,
      canDelete: asset.canDelete,
      displayName: asset.displayName,
      originalFilename: asset.originalFilename,
      mimeType: asset.mimeType,
      width: asset.width,
      height: asset.height,
      sizeBytes: asset.sizeBytes,
      tags: asset.tags,
      thumbnailUrl: asset.thumbnailUrl,
      rightsAssertedAt: asset.rightsAssertedAt,
      importedAt: asset.importedAt,
      updatedAt: asset.updatedAt
    }
  }

  private readAssetTags(assetId: string): LocalAssetTagDto[] {
    return (this.database.prepare(`
      SELECT display_value, normalized_value FROM local_asset_tags
      WHERE asset_id = ? ORDER BY ordinal ASC
    `).all(assetId) as unknown as TagRow[]).map((row) => ({
      displayValue: row.display_value,
      normalizedValue: row.normalized_value
    }))
  }

  private readImportTags(itemId: string): LocalAssetTagDto[] {
    return (this.database.prepare(`
      SELECT display_value, normalized_value FROM local_import_item_tags
      WHERE item_id = ? ORDER BY ordinal ASC
    `).all(itemId) as unknown as TagRow[]).map((row) => ({
      displayValue: row.display_value,
      normalizedValue: row.normalized_value
    }))
  }

  private completeSessionIfTerminal(itemId: string, timestamp: string): void {
    const session = this.database.prepare(`
      SELECT session_id FROM local_import_items WHERE id = ?
    `).get(itemId) as { session_id: string } | undefined
    if (!session) return
    const pending = this.database.prepare(`
      SELECT 1 FROM local_import_items
      WHERE session_id = ? AND state IN ('staged', 'processing', 'committing', 'failed') LIMIT 1
    `).get(session.session_id)
    if (!pending) {
      this.database.prepare(`
        UPDATE local_import_sessions SET state = 'completed', updated_at = ? WHERE id = ?
      `).run(timestamp, session.session_id)
    }
  }

  private transaction(operation: () => void): void {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      operation()
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }
}
