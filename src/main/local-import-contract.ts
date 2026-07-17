import type { DatabaseSync } from 'node:sqlite'
import {
  normalizeLocalAssetId,
  normalizeLocalAssetText,
  validateLocalAssetMetadata,
  type LocalAssetErrorCode,
  type LocalAssetOperationError,
  type LocalAssetResult,
  type LocalAssetTagDto,
  type LocalImportFinalizeResultDto,
  type LocalImportItemDto,
  type LocalImportSessionDto,
  type RetryLocalImportItemsRequest,
  type UpdateLocalImportDraftRequest,
  type FinalizeLocalImportRequest
} from '../shared/local-assets'

interface ImportSessionRow {
  id: string
  source_kind: 'files' | 'directory'
  state: 'active' | 'completed' | 'cancelled'
  rights_asserted_at: string
  created_at: string
  updated_at: string
}

interface ImportItemRow {
  id: string
  original_filename: string
  state: LocalImportItemDto['state']
  display_name: string | null
  mime_type: LocalImportItemDto['mimeType'] | null
  width: number | null
  height: number | null
  size_bytes: number | null
  finalized_at: string | null
  error_code: LocalAssetErrorCode | null
  duplicate_asset_id: string | null
  imported_asset_id: string | null
}

interface TagRow {
  display_value: string
  normalized_value: string
}

function failure<T>(
  code: LocalAssetErrorCode,
  message: string,
  retryable = false
): LocalAssetResult<T> {
  return { ok: false, error: { code, message, retryable } }
}

function operationError(
  code: LocalAssetErrorCode,
  message: string,
  retryable = false
): LocalAssetOperationError {
  return { code, message, retryable }
}

/**
 * F0's durable import-state contract. File discovery and image processing remain F1 concerns;
 * this store owns only editable draft metadata and the transition into the commit boundary.
 */
export class LocalImportContractStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  getSession(sessionId: string): LocalAssetResult<LocalImportSessionDto> {
    const normalizedSessionId = normalizeLocalAssetId(sessionId)
    if (!normalizedSessionId) return failure('invalid_request', '导入会话编号无效')
    const session = this.readSession(normalizedSessionId)
    return session
      ? { ok: true, value: this.mapSession(session) }
      : failure('import_session_not_found', '找不到导入会话')
  }

  updateDraft(
    request: UpdateLocalImportDraftRequest
  ): LocalAssetResult<LocalImportItemDto> {
    const sessionId = normalizeLocalAssetId(request.sessionId)
    const itemId = normalizeLocalAssetId(request.itemId)
    if (!sessionId || !itemId) return failure('invalid_request', '导入草稿编号无效')
    const session = this.readSession(sessionId)
    if (!session) return failure('import_session_not_found', '找不到导入会话')
    if (session.state !== 'active') return failure('invalid_import_state', '导入会话不可编辑')
    const item = this.readItem(sessionId, itemId)
    if (!item) return failure('import_item_not_found', '找不到导入条目')
    if (item.state !== 'staged' && item.state !== 'failed') {
      return failure('invalid_import_state', '只有待处理或失败条目可以编辑')
    }

    const issues = validateLocalAssetMetadata(request.displayName, request.tags)
    if (issues.length > 0) return failure(issues[0].code, '导入草稿名称或标签无效')
    const displayName = request.displayName.normalize('NFKC').trim()
    const tags = request.tags.map((tag) => ({
      displayValue: tag.normalize('NFKC').trim(),
      normalizedValue: normalizeLocalAssetText(tag)
    }))
    const timestamp = this.now()

    this.transaction(() => {
      this.database.prepare('DELETE FROM local_import_item_tags WHERE item_id = ?').run(itemId)
      const insertTag = this.database.prepare(`
        INSERT INTO local_import_item_tags (
          item_id, display_value, normalized_value, ordinal
        ) VALUES (?, ?, ?, ?)
      `)
      tags.forEach((tag, ordinal) => {
        insertTag.run(itemId, tag.displayValue, tag.normalizedValue, ordinal)
      })
      this.database.prepare(`
        UPDATE local_import_items
        SET display_name = ?, normalized_name = ?, finalized_at = NULL, updated_at = ?
        WHERE id = ? AND session_id = ?
      `).run(displayName, normalizeLocalAssetText(displayName), timestamp, itemId, sessionId)
      this.database.prepare(`
        UPDATE local_import_sessions SET updated_at = ? WHERE id = ?
      `).run(timestamp, sessionId)
    })

    return { ok: true, value: this.mapItem(this.readItem(sessionId, itemId)!) }
  }

  finalize(request: FinalizeLocalImportRequest): LocalAssetResult<LocalImportFinalizeResultDto> {
    const sessionId = normalizeLocalAssetId(request.sessionId)
    const itemIds = request.itemIds.map(normalizeLocalAssetId)
    if (!sessionId || itemIds.length < 1 || itemIds.some((id) => !id) ||
      new Set(itemIds).size !== itemIds.length) {
      return failure('invalid_request', '待提交条目编号无效')
    }
    const session = this.readSession(sessionId)
    if (!session) return failure('import_session_not_found', '找不到导入会话')
    if (session.state !== 'active') return failure('invalid_import_state', '导入会话不可提交')

    const finalizedItemIds: string[] = []
    const rejectedItems: LocalImportFinalizeResultDto['rejectedItems'] = []
    const timestamp = this.now()
    this.transaction(() => {
      for (const itemId of itemIds as string[]) {
        const item = this.readItem(sessionId, itemId)
        if (!item) {
          rejectedItems.push({
            itemId,
            error: operationError('import_item_not_found', '找不到导入条目')
          })
          continue
        }
        if (item.state !== 'staged') {
          rejectedItems.push({
            itemId,
            error: operationError('invalid_import_state', '只有待处理条目可以提交')
          })
          continue
        }
        const tags = this.readTags(itemId)
        const issues = validateLocalAssetMetadata(
          item.display_name ?? '',
          tags.map(({ displayValue }) => displayValue)
        )
        if (issues.length > 0) {
          rejectedItems.push({
            itemId,
            error: operationError(issues[0].code, '条目名称或标签未通过校验')
          })
          continue
        }
        this.database.prepare(`
          UPDATE local_import_items
          SET state = 'committing', finalized_at = ?, error_code = NULL, updated_at = ?
          WHERE id = ? AND session_id = ? AND state = 'staged'
        `).run(timestamp, timestamp, itemId, sessionId)
        finalizedItemIds.push(itemId)
      }
      this.database.prepare(`
        UPDATE local_import_sessions SET updated_at = ? WHERE id = ?
      `).run(timestamp, sessionId)
    })

    return {
      ok: true,
      value: {
        session: this.mapSession(this.readSession(sessionId)!),
        finalizedItemIds,
        rejectedItems
      }
    }
  }

  retryFailed(request: RetryLocalImportItemsRequest): LocalAssetResult<LocalImportSessionDto> {
    const sessionId = normalizeLocalAssetId(request.sessionId)
    const itemIds = request.itemIds.map(normalizeLocalAssetId)
    if (!sessionId || itemIds.length < 1 || itemIds.some((id) => !id) ||
      new Set(itemIds).size !== itemIds.length) {
      return failure('invalid_request', '重试条目编号无效')
    }
    const session = this.readSession(sessionId)
    if (!session) return failure('import_session_not_found', '找不到导入会话')
    if (session.state !== 'active') return failure('invalid_import_state', '导入会话不可重试')
    for (const itemId of itemIds as string[]) {
      const item = this.database.prepare(`
        SELECT state, staging_rel_path FROM local_import_items
        WHERE id = ? AND session_id = ?
      `).get(itemId, sessionId) as unknown as {
        state: LocalImportItemDto['state']
        staging_rel_path: string | null
      } | undefined
      if (!item) return failure('import_item_not_found', '找不到导入条目')
      if (item.state !== 'failed') {
        return failure('invalid_import_state', '只有失败条目可以重试')
      }
      if (!item.staging_rel_path) {
        return failure('staging_unavailable', '导入暂存文件不可用')
      }
    }
    const timestamp = this.now()
    this.transaction(() => {
      for (const itemId of itemIds as string[]) {
        const result = this.database.prepare(`
          UPDATE local_import_items
          SET state = 'staged', error_code = NULL, finalized_at = NULL, updated_at = ?
          WHERE id = ? AND session_id = ? AND state = 'failed'
            AND staging_rel_path IS NOT NULL
        `).run(timestamp, itemId, sessionId)
        if (result.changes !== 1) throw new Error('Retry state changed during transaction')
      }
      this.database.prepare(`
        UPDATE local_import_sessions SET updated_at = ? WHERE id = ?
      `).run(timestamp, sessionId)
    })
    return { ok: true, value: this.mapSession(this.readSession(sessionId)!) }
  }

  cancel(sessionIdValue: string): LocalAssetResult<LocalImportSessionDto> {
    const sessionId = normalizeLocalAssetId(sessionIdValue)
    if (!sessionId) return failure('invalid_request', '导入会话编号无效')
    const session = this.readSession(sessionId)
    if (!session) return failure('import_session_not_found', '找不到导入会话')
    if (session.state !== 'active') return failure('invalid_import_state', '导入会话不可取消')
    const committed = this.database.prepare(`
      SELECT 1 FROM local_import_items
      WHERE session_id = ? AND state IN ('committing', 'ready') LIMIT 1
    `).get(sessionId)
    if (committed) return failure('invalid_import_state', '提交中的导入会话不可取消')
    const timestamp = this.now()
    this.transaction(() => {
      this.database.prepare(`
        UPDATE local_import_items SET state = 'cancelled', updated_at = ?
        WHERE session_id = ? AND state != 'cancelled'
      `).run(timestamp, sessionId)
      this.database.prepare(`
        UPDATE local_import_sessions SET state = 'cancelled', updated_at = ? WHERE id = ?
      `).run(timestamp, sessionId)
    })
    return { ok: true, value: this.mapSession(this.readSession(sessionId)!) }
  }

  private readSession(sessionId: string): ImportSessionRow | undefined {
    return this.database.prepare(`
      SELECT id, source_kind, state, rights_asserted_at, created_at, updated_at
      FROM local_import_sessions WHERE id = ?
    `).get(sessionId) as unknown as ImportSessionRow | undefined
  }

  private readItem(sessionId: string, itemId: string): ImportItemRow | undefined {
    return this.database.prepare(`
      SELECT id, original_filename, state, display_name, mime_type, width, height,
        size_bytes, finalized_at, error_code, duplicate_asset_id, imported_asset_id
      FROM local_import_items WHERE session_id = ? AND id = ?
    `).get(sessionId, itemId) as unknown as ImportItemRow | undefined
  }

  private readTags(itemId: string): LocalAssetTagDto[] {
    return (this.database.prepare(`
      SELECT display_value, normalized_value FROM local_import_item_tags
      WHERE item_id = ? ORDER BY ordinal ASC
    `).all(itemId) as unknown as TagRow[]).map((tag) => ({
      displayValue: tag.display_value,
      normalizedValue: tag.normalized_value
    }))
  }

  private mapItem(item: ImportItemRow): LocalImportItemDto {
    return {
      id: item.id,
      originalFilename: item.original_filename,
      state: item.state,
      ...(item.display_name ? { displayName: item.display_name } : {}),
      tags: this.readTags(item.id),
      ...(item.mime_type ? { mimeType: item.mime_type } : {}),
      ...(item.width !== null ? { width: item.width } : {}),
      ...(item.height !== null ? { height: item.height } : {}),
      ...(item.size_bytes !== null ? { sizeBytes: item.size_bytes } : {}),
      ...(item.finalized_at ? { finalizedAt: item.finalized_at } : {}),
      ...(item.error_code ? {
        error: operationError(item.error_code, '导入条目处理失败', true)
      } : {}),
      ...(item.duplicate_asset_id ? { duplicateAssetId: item.duplicate_asset_id } : {}),
      ...(item.imported_asset_id ? { importedAssetId: item.imported_asset_id } : {})
    }
  }

  private mapSession(session: ImportSessionRow): LocalImportSessionDto {
    const items = this.database.prepare(`
      SELECT id, original_filename, state, display_name, mime_type, width, height,
        size_bytes, finalized_at, error_code, duplicate_asset_id, imported_asset_id
      FROM local_import_items WHERE session_id = ? ORDER BY created_at ASC, id ASC
    `).all(session.id) as unknown as ImportItemRow[]
    return {
      id: session.id,
      sourceKind: session.source_kind,
      state: session.state,
      items: items.map((item) => this.mapItem(item)),
      rightsAssertedAt: session.rights_asserted_at,
      createdAt: session.created_at,
      updatedAt: session.updated_at
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
