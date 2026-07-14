import { DatabaseSync } from 'node:sqlite'
import type { EmojiRecord, LibraryFilter } from '../shared/types'

interface StoredEmojiRow {
  id: string
  prompt: string
  mode: EmojiRecord['mode']
  style: EmojiRecord['style']
  emotion: EmojiRecord['emotion']
  caption: string
  seed: number
  image: Uint8Array
  favorite: number
  created_at: string
}

const DATA_URL_PREFIX = 'data:image/png;base64,'

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
  return {
    id: row.id,
    prompt: row.prompt,
    mode: row.mode,
    style: row.style,
    emotion: row.emotion,
    caption: row.caption,
    seed: row.seed,
    dataUrl: `${DATA_URL_PREFIX}${Buffer.from(row.image).toString('base64')}`,
    favorite: row.favorite === 1,
    createdAt: row.created_at
  }
}

export class EmojiRepository {
  private readonly database: DatabaseSync

  constructor(databasePath: string) {
    this.database = new DatabaseSync(databasePath)
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS generations (
        id TEXT PRIMARY KEY,
        prompt TEXT NOT NULL,
        mode TEXT NOT NULL,
        style TEXT NOT NULL,
        emotion TEXT NOT NULL,
        caption TEXT NOT NULL,
        seed INTEGER NOT NULL,
        image BLOB NOT NULL,
        favorite INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_generations_created_at
        ON generations(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_generations_favorite
        ON generations(favorite, created_at DESC);
      CREATE TABLE IF NOT EXISTS preferences (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
  }

  list(filter: LibraryFilter = 'all'): EmojiRecord[] {
    const statement = this.database.prepare(
      filter === 'favorites'
        ? `SELECT * FROM generations WHERE favorite = 1 ORDER BY created_at DESC LIMIT 240`
        : `SELECT * FROM generations ORDER BY created_at DESC LIMIT 240`
    )
    return (statement.all() as unknown as StoredEmojiRow[]).map(mapRow)
  }

  save(records: EmojiRecord[]): void {
    const statement = this.database.prepare(`
      INSERT INTO generations (
        id, prompt, mode, style, emotion, caption, seed, image, favorite, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        prompt = excluded.prompt,
        mode = excluded.mode,
        style = excluded.style,
        emotion = excluded.emotion,
        caption = excluded.caption,
        seed = excluded.seed,
        image = excluded.image,
        favorite = MAX(generations.favorite, excluded.favorite),
        created_at = excluded.created_at
    `)

    this.database.exec('BEGIN')
    try {
      for (const record of records) {
        statement.run(
          record.id,
          record.prompt,
          record.mode,
          record.style,
          record.emotion,
          record.caption,
          record.seed,
          decodePng(record.dataUrl),
          record.favorite ? 1 : 0,
          record.createdAt
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
