import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { migrateApplicationDatabase } from '../src/main/database-schema'

const ASSET_WITH_ONE_TAG = '00000000-0000-4000-8000-000000000101'
const ASSET_WITH_TWELVE_TAGS = '00000000-0000-4000-8000-000000000102'
const EMPTY_COMMITTING_ASSET = '00000000-0000-4000-8000-000000000103'

function insertAsset(
  database: DatabaseSync,
  assetId: string,
  state: 'committing' | 'ready',
  hashCharacter: string
): void {
  database.prepare(`
    INSERT INTO local_assets (
      id, display_name, normalized_name, original_filename, mime_type,
      width, height, size_bytes, content_sha256, pixel_sha256,
      source_rel_path, thumbnail_rel_path, state, rights_asserted_at,
      imported_at, updated_at
    ) VALUES (?, ?, ?, ?, 'image/png', 64, 64, 128, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    assetId,
    `素材 ${hashCharacter}`,
    `素材 ${hashCharacter}`,
    `${assetId}.png`,
    hashCharacter.repeat(64),
    String.fromCharCode(hashCharacter.charCodeAt(0) + 1).repeat(64),
    `originals/${assetId}.png`,
    `thumbnails/${assetId}.webp`,
    state,
    '2026-07-17T00:00:00.000Z',
    '2026-07-17T00:00:00.000Z',
    '2026-07-17T00:00:00.000Z'
  )
}

function insertTags(database: DatabaseSync, assetId: string, count: number): void {
  const insertTag = database.prepare(`
    INSERT INTO local_asset_tags (asset_id, display_value, normalized_value, ordinal)
    VALUES (?, ?, ?, ?)
  `)
  for (let ordinal = 0; ordinal < count; ordinal += 1) {
    insertTag.run(assetId, `标签${ordinal}`, `标签${ordinal}`, ordinal)
  }
}

function seedAssets(database: DatabaseSync, useReadyTransitions: boolean): void {
  insertAsset(database, ASSET_WITH_ONE_TAG, useReadyTransitions ? 'committing' : 'ready', 'a')
  insertAsset(database, ASSET_WITH_TWELVE_TAGS, useReadyTransitions ? 'committing' : 'ready', 'c')
  insertAsset(database, EMPTY_COMMITTING_ASSET, 'committing', 'e')
  insertTags(database, ASSET_WITH_ONE_TAG, 1)
  insertTags(database, ASSET_WITH_TWELVE_TAGS, 12)
  if (useReadyTransitions) {
    database.prepare(`
      UPDATE local_assets SET state = 'ready'
      WHERE id IN (?, ?)
    `).run(ASSET_WITH_ONE_TAG, ASSET_WITH_TWELVE_TAGS)
  }
}

function createFreshV2Database(): DatabaseSync {
  const database = new DatabaseSync(':memory:')
  migrateApplicationDatabase(database)
  seedAssets(database, true)
  return database
}

function createUpgradedV1Database(): DatabaseSync {
  const database = new DatabaseSync(':memory:')
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE local_assets (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      content_sha256 TEXT NOT NULL,
      pixel_sha256 TEXT NOT NULL,
      source_rel_path TEXT NOT NULL,
      thumbnail_rel_path TEXT NOT NULL,
      state TEXT NOT NULL,
      rights_asserted_at TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE local_asset_tags (
      asset_id TEXT NOT NULL REFERENCES local_assets(id) ON DELETE CASCADE,
      display_value TEXT NOT NULL,
      normalized_value TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      PRIMARY KEY (asset_id, normalized_value),
      UNIQUE (asset_id, ordinal)
    );
    CREATE TABLE local_import_sessions (
      id TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL,
      state TEXT NOT NULL,
      rights_asserted_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE local_import_items (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES local_import_sessions(id) ON DELETE CASCADE,
      original_filename TEXT NOT NULL,
      staging_rel_path TEXT,
      display_name TEXT,
      normalized_name TEXT,
      mime_type TEXT,
      width INTEGER,
      height INTEGER,
      size_bytes INTEGER,
      content_sha256 TEXT,
      pixel_sha256 TEXT,
      state TEXT NOT NULL,
      error_code TEXT,
      duplicate_asset_id TEXT,
      imported_asset_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    PRAGMA user_version = 1;
  `)
  seedAssets(database, false)
  migrateApplicationDatabase(database)
  expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 })
  return database
}

const databaseCases = [
  ['fresh v2', createFreshV2Database],
  ['v1 to v2', createUpgradedV1Database]
] as const

describe.each(databaseCases)('local asset tag owner invariant (%s)', (_label, createDatabase) => {
  it('rejects moving the final tag away from a ready asset', () => {
    const database = createDatabase()
    expect(() => database.prepare(`
      UPDATE local_asset_tags SET asset_id = ? WHERE asset_id = ?
    `).run(EMPTY_COMMITTING_ASSET, ASSET_WITH_ONE_TAG)).toThrow(/owner is immutable/u)
    expect(database.prepare(`
      SELECT state,
        (SELECT COUNT(*) FROM local_asset_tags WHERE asset_id = local_assets.id) AS tag_count
      FROM local_assets WHERE id = ?
    `).get(ASSET_WITH_ONE_TAG)).toEqual({ state: 'ready', tag_count: 1 })
    database.close()
  })

  it('rejects moving a tag into an owner that already has twelve tags', () => {
    const database = createDatabase()
    expect(() => database.prepare(`
      UPDATE local_asset_tags SET asset_id = ? WHERE asset_id = ?
    `).run(ASSET_WITH_TWELVE_TAGS, ASSET_WITH_ONE_TAG)).toThrow(/owner is immutable/u)
    expect(database.prepare(`
      SELECT id, state,
        (SELECT COUNT(*) FROM local_asset_tags WHERE asset_id = local_assets.id) AS tag_count
      FROM local_assets WHERE id IN (?, ?) ORDER BY id
    `).all(ASSET_WITH_ONE_TAG, ASSET_WITH_TWELVE_TAGS)).toEqual([
      { id: ASSET_WITH_ONE_TAG, state: 'ready', tag_count: 1 },
      { id: ASSET_WITH_TWELVE_TAGS, state: 'ready', tag_count: 12 }
    ])
    database.close()
  })
})
