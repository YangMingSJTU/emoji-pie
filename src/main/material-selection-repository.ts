import { DatabaseSync } from 'node:sqlite'
import {
  MATERIAL_SELECTION_DRAFT_LIMIT,
  MATERIAL_SELECTION_PREFERENCE_KEY,
  MATERIAL_SELECTION_STATE_VERSION,
  createDefaultMaterialSelectionState,
  normalizeMaterialSelectionState,
  type MaterialSelectionErrorCode,
  type MaterialSelectionDraftItem,
  type MaterialSelectionState,
  type MaterialSelectionStateInput
} from '../shared/starter-packs'
import { migrateApplicationDatabase } from './database-schema'

export class MaterialSelectionRepositoryError extends Error {
  constructor(
    readonly code: MaterialSelectionErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'MaterialSelectionRepositoryError'
  }
}

export class MaterialSelectionRepository {
  private readonly database: DatabaseSync
  private readonly ownsDatabase: boolean

  constructor(
    database: DatabaseSync | string,
    private readonly now: () => string = () => new Date().toISOString()
  ) {
    this.ownsDatabase = typeof database === 'string'
    this.database = typeof database === 'string' ? new DatabaseSync(database) : database
    migrateApplicationDatabase(this.database)
    this.database.exec('PRAGMA journal_mode = WAL;')
  }

  load(): MaterialSelectionState {
    const row = this.database.prepare(
      'SELECT value FROM preferences WHERE key = ?'
    ).get(MATERIAL_SELECTION_PREFERENCE_KEY) as { value: string } | undefined
    if (!row) return createDefaultMaterialSelectionState(this.now())

    let parsed: unknown
    try {
      parsed = JSON.parse(row.value)
    } catch {
      this.resetInvalidPreference()
      return createDefaultMaterialSelectionState(this.now())
    }
    const normalized = normalizeMaterialSelectionState(parsed)
    if (normalized) return normalized
    this.resetInvalidPreference()
    return createDefaultMaterialSelectionState(this.now())
  }

  save(input: MaterialSelectionStateInput): MaterialSelectionState {
    if (input.manualDraft.length > MATERIAL_SELECTION_DRAFT_LIMIT) {
      throw new MaterialSelectionRepositoryError(
        'invalid_selection_state',
        '手动素材草稿最多保存 9 项'
      )
    }
    const manualDraft = this.deduplicate(input.manualDraft)
    const state = normalizeMaterialSelectionState({
      version: MATERIAL_SELECTION_STATE_VERSION,
      mode: input.mode,
      autoScope: input.autoScope,
      manualDraft,
      updatedAt: this.now()
    })
    if (!state) {
      throw new MaterialSelectionRepositoryError(
        'invalid_selection_state',
        '素材选择草稿格式无效'
      )
    }

    try {
      this.database.prepare(
        'INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
      ).run(MATERIAL_SELECTION_PREFERENCE_KEY, JSON.stringify(state), state.updatedAt)
    } catch {
      throw new MaterialSelectionRepositoryError(
        'selection_state_write_failed',
        '素材选择草稿保存失败'
      )
    }
    return state
  }

  close(): void {
    if (this.ownsDatabase) this.database.close()
  }

  private deduplicate(items: readonly MaterialSelectionDraftItem[]): MaterialSelectionDraftItem[] {
    const seen = new Set<string>()
    const unique: MaterialSelectionDraftItem[] = []
    for (const item of items) {
      const normalizedId = item.assetId.toLowerCase()
      if (seen.has(normalizedId)) continue
      seen.add(normalizedId)
      unique.push({ ...item, assetId: normalizedId })
    }
    return unique
  }

  private resetInvalidPreference(): void {
    this.database.prepare('DELETE FROM preferences WHERE key = ?')
      .run(MATERIAL_SELECTION_PREFERENCE_KEY)
  }
}
