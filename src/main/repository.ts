import { DatabaseSync } from 'node:sqlite'
import { countGraphemes, normalizeLocalAssetId } from '../shared/local-assets'
import { isEmojiStyle, type EmojiRecord, type LibraryFilter } from '../shared/types'
import { migrateApplicationDatabase } from './database-schema'

interface StoredEmojiRow {
  id: string
  prompt: string
  mode: EmojiRecord['mode']
  style: EmojiRecord['style']
  layout: string
  embed_caption: number
  emotion: EmojiRecord['emotion']
  caption: string
  seed: number
  image: Uint8Array
  favorite: number
  created_at: string
  local_asset_id: string | null
  local_asset_name_snapshot: string | null
  local_match_mode: string | null
  batch_id: string | null
  selection_ordinal: number | null
  asset_source: 'user' | 'starter_pack' | null
  pack_id: string | null
  pack_version: string | null
  pack_asset_key: string | null
  background_source: string
  local_source_available: number
}

const DATA_URL_PREFIX = 'data:image/png;base64,'
const PACK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const PACK_VERSION_PATTERN = /^\d+\.\d+\.\d+$/
const PACK_ASSET_KEY_PATTERN = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/

function decodePng(dataUrl: string): Buffer {
  if (!dataUrl.startsWith(DATA_URL_PREFIX)) {
    throw new Error('只支持 PNG 图片数据')
  }

  const buffer = Buffer.from(dataUrl.slice(DATA_URL_PREFIX.length), 'base64')
  if (buffer.length === 0 || buffer.length > 10 * 1024 * 1024) {
    throw new Error('图片数据为空或超过 10MB')
  }

  return buffer
}

function mapRow(row: StoredEmojiRow): EmojiRecord {
  const record: EmojiRecord = {
    id: row.id,
    prompt: row.prompt,
    mode: row.mode,
    style: isEmojiStyle(row.style) ? row.style : 'classic',
    layout: row.layout === 'compact' ? 'compact' : 'poster',
    embedCaption: row.embed_caption === 1,
    emotion: row.emotion,
    caption: row.caption,
    seed: row.seed,
    dataUrl: `${DATA_URL_PREFIX}${Buffer.from(row.image).toString('base64')}`,
    favorite: row.favorite === 1,
    createdAt: row.created_at
  }
  if (
    row.background_source === 'local' &&
    row.local_asset_id &&
    row.local_asset_name_snapshot &&
    (row.local_match_mode === 'automatic' || row.local_match_mode === 'manual')
  ) {
    record.localSource = {
      assetId: row.local_asset_id,
      assetNameSnapshot: row.local_asset_name_snapshot,
      matchMode: row.local_match_mode,
      assetSource: row.asset_source ?? 'user',
      ...(row.batch_id ? { batchId: row.batch_id } : {}),
      ...(row.selection_ordinal ? { selectionOrdinal: row.selection_ordinal } : {}),
      ...(row.pack_id ? { packId: row.pack_id } : {}),
      ...(row.pack_version ? { packVersion: row.pack_version } : {}),
      ...(row.pack_asset_key ? { packAssetKey: row.pack_asset_key } : {}),
      sourceDeleted: row.local_source_available !== 1
    }
  }
  return record
}

export class EmojiRepository {
  private readonly database: DatabaseSync

  constructor(databasePath: string) {
    this.database = new DatabaseSync(databasePath)
    try {
      migrateApplicationDatabase(this.database)
      this.database.exec('PRAGMA journal_mode = WAL;')
    } catch (error) {
      this.database.close()
      throw error
    }
  }

  list(filter: LibraryFilter = 'all'): EmojiRecord[] {
    const statement = this.database.prepare(
      filter === 'favorites'
        ? `SELECT generations.*, CASE
             WHEN asset_source = 'starter_pack' AND NOT EXISTS (
               SELECT 1 FROM starter_pack_asset_state
               WHERE starter_pack_asset_state.pack_id = generations.pack_id
                 AND starter_pack_asset_state.pack_asset_key = generations.pack_asset_key
             ) THEN 1
             WHEN asset_source = 'user' AND local_asset_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM local_assets
               WHERE local_assets.id = generations.local_asset_id
                 AND local_assets.state = 'ready'
             ) THEN 1 ELSE 0 END AS local_source_available
           FROM generations WHERE favorite = 1 ORDER BY created_at DESC LIMIT 240`
        : `SELECT generations.*, CASE
             WHEN asset_source = 'starter_pack' AND NOT EXISTS (
               SELECT 1 FROM starter_pack_asset_state
               WHERE starter_pack_asset_state.pack_id = generations.pack_id
                 AND starter_pack_asset_state.pack_asset_key = generations.pack_asset_key
             ) THEN 1
             WHEN asset_source = 'user' AND local_asset_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM local_assets
               WHERE local_assets.id = generations.local_asset_id
                 AND local_assets.state = 'ready'
             ) THEN 1 ELSE 0 END AS local_source_available
           FROM generations ORDER BY created_at DESC LIMIT 240`
    )
    return (statement.all() as unknown as StoredEmojiRow[]).map(mapRow)
  }

  save(records: EmojiRecord[]): void {
    const statement = this.database.prepare(`
      INSERT INTO generations (
        id, prompt, mode, style, layout, embed_caption, emotion, caption,
        seed, image, favorite, created_at, local_asset_id,
        local_asset_name_snapshot, local_match_mode, background_source,
        batch_id, selection_ordinal, asset_source, pack_id, pack_version, pack_asset_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        prompt = excluded.prompt,
        mode = excluded.mode,
        style = excluded.style,
        layout = excluded.layout,
        embed_caption = excluded.embed_caption,
        emotion = excluded.emotion,
        caption = excluded.caption,
        seed = excluded.seed,
        image = excluded.image,
        favorite = MAX(generations.favorite, excluded.favorite),
        created_at = excluded.created_at,
        local_asset_id = excluded.local_asset_id,
        local_asset_name_snapshot = excluded.local_asset_name_snapshot,
        local_match_mode = excluded.local_match_mode,
        background_source = excluded.background_source,
        batch_id = excluded.batch_id,
        selection_ordinal = excluded.selection_ordinal,
        asset_source = excluded.asset_source,
        pack_id = excluded.pack_id,
        pack_version = excluded.pack_version,
        pack_asset_key = excluded.pack_asset_key
    `)

    this.database.exec('BEGIN')
    try {
      for (const record of records) {
        const localAssetId = record.localSource
          ? normalizeLocalAssetId(record.localSource.assetId)
          : undefined
        if (record.localSource && (
          !localAssetId ||
          countGraphemes(record.localSource.assetNameSnapshot.trim()) < 1 ||
          countGraphemes(record.localSource.assetNameSnapshot.trim()) > 60 ||
          (record.localSource.batchId !== undefined &&
            !normalizeLocalAssetId(record.localSource.batchId)) ||
          (record.localSource.selectionOrdinal !== undefined &&
            (!Number.isInteger(record.localSource.selectionOrdinal) ||
              record.localSource.selectionOrdinal < 1 ||
              record.localSource.selectionOrdinal > 9)) ||
          (record.localSource.assetSource === 'user' && (
            record.localSource.packId !== undefined ||
            record.localSource.packVersion !== undefined ||
            record.localSource.packAssetKey !== undefined
          )) ||
          (record.localSource.assetSource === 'starter_pack' && (
            !record.localSource.packId ||
            !PACK_ID_PATTERN.test(record.localSource.packId) ||
            !record.localSource.packVersion ||
            !PACK_VERSION_PATTERN.test(record.localSource.packVersion) ||
            !record.localSource.packAssetKey ||
            !PACK_ASSET_KEY_PATTERN.test(record.localSource.packAssetKey)
          ))
        )) {
          throw new Error('本地素材生成快照格式无效')
        }
        statement.run(
          record.id,
          record.prompt,
          record.mode,
          record.style,
          record.layout,
          record.embedCaption ? 1 : 0,
          record.emotion,
          record.caption,
          record.seed,
          decodePng(record.dataUrl),
          record.favorite ? 1 : 0,
          record.createdAt,
          localAssetId ?? null,
          record.localSource?.assetNameSnapshot ?? null,
          record.localSource?.matchMode ?? null,
          record.localSource ? 'local' : 'original',
          record.localSource?.batchId ?? null,
          record.localSource?.selectionOrdinal ?? null,
          record.localSource?.assetSource ?? null,
          record.localSource?.packId ?? null,
          record.localSource?.packVersion ?? null,
          record.localSource?.packAssetKey ?? null
        )
      }
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  toggleFavorite(id: string, favorite: boolean): void {
    this.database
      .prepare('UPDATE generations SET favorite = ? WHERE id = ?')
      .run(favorite ? 1 : 0, id)
  }

  delete(id: string): void {
    this.database.prepare('DELETE FROM generations WHERE id = ?').run(id)
  }

  clearHistory(): void {
    this.database.prepare('DELETE FROM generations WHERE favorite = 0').run()
  }

  getPreference<T>(key: string): T | undefined {
    const row = this.database
      .prepare('SELECT value FROM preferences WHERE key = ?')
      .get(key) as { value: string } | undefined
    if (!row) return undefined
    try {
      return JSON.parse(row.value) as T
    } catch {
      return undefined
    }
  }

  setPreference<T>(key: string, value: T): void {
    this.database
      .prepare(`
        INSERT INTO preferences (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `)
      .run(key, JSON.stringify(value), new Date().toISOString())
  }

  close(): void {
    this.database.close()
  }
}
