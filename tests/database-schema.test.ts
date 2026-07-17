import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  APPLICATION_SCHEMA_VERSION,
  migrateApplicationDatabase
} from '../src/main/database-schema'

function tableNames(database: DatabaseSync): string[] {
  return (database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as unknown as Array<{ name: string }>).map(({ name }) => name)
}

describe('application database migration', () => {
  it('versions an unversioned legacy database without changing historical generation data', () => {
    const database = new DatabaseSync(':memory:')
    database.exec(`
      CREATE TABLE generations (
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
      INSERT INTO generations (
        id, prompt, mode, style, emotion, caption, seed, image, favorite, created_at
      ) VALUES (
        'legacy', '旧记录', 'express', 'office', 'tired', '旧记录', 7,
        X'01', 1, '2026-07-01T00:00:00.000Z'
      );
    `)

    migrateApplicationDatabase(database)

    expect(database.prepare('PRAGMA user_version').get()).toEqual({
      user_version: APPLICATION_SCHEMA_VERSION
    })
    expect(tableNames(database)).toEqual(expect.arrayContaining([
      'generations',
      'preferences',
      'local_assets',
      'local_asset_tags',
      'local_import_sessions',
      'local_import_items'
    ]))
    expect(database.prepare(`
      SELECT id, favorite, layout, embed_caption, background_source,
        local_asset_id, local_asset_name_snapshot, local_match_mode
      FROM generations WHERE id = 'legacy'
    `).get()).toEqual({
      id: 'legacy',
      favorite: 1,
      layout: 'poster',
      embed_caption: 1,
      background_source: 'original',
      local_asset_id: null,
      local_asset_name_snapshot: null,
      local_match_mode: null
    })

    migrateApplicationDatabase(database)
    expect(database.prepare('SELECT COUNT(*) AS count FROM generations').get()).toEqual({ count: 1 })
    database.close()
  })

  it('cascades owned tags and import items but preserves generation snapshots', () => {
    const database = new DatabaseSync(':memory:')
    migrateApplicationDatabase(database)
    const assetId = '00000000-0000-4000-8000-000000000001'
    const sessionId = '00000000-0000-4000-8000-000000000002'
    const itemId = '00000000-0000-4000-8000-000000000003'
    database.prepare(`
      INSERT INTO local_assets (
        id, display_name, normalized_name, original_filename, mime_type,
        width, height, size_bytes, content_sha256, pixel_sha256,
        source_rel_path, thumbnail_rel_path, state, rights_asserted_at,
        imported_at, updated_at
      ) VALUES (?, '素材 A', '素材 a', 'a.png', 'image/png', 640, 640, 100,
        ?, ?, ?, ?, 'ready', ?, ?, ?)
    `).run(
      assetId,
      'a'.repeat(64),
      'b'.repeat(64),
      `originals/${assetId}.png`,
      `thumbnails/${assetId}.webp`,
      '2026-07-17T00:00:00.000Z',
      '2026-07-17T00:00:00.000Z',
      '2026-07-17T00:00:00.000Z'
    )
    database.prepare(`
      INSERT INTO local_asset_tags (asset_id, display_value, normalized_value, ordinal)
      VALUES (?, '加班', '加班', 0)
    `).run(assetId)
    expect(() => database.prepare(`
      INSERT INTO local_asset_tags (asset_id, display_value, normalized_value, ordinal)
      VALUES (?, '工作', '工作', 0)
    `).run(assetId)).toThrow()
    expect(() => database.prepare(`
      UPDATE local_assets SET content_sha256 = ? WHERE id = ?
    `).run('g'.repeat(64), assetId)).toThrow()
    expect(() => database.prepare(`
      UPDATE local_assets SET width = 8192, height = 8192 WHERE id = ?
    `).run(assetId)).toThrow()
    expect(() => database.prepare(`
      INSERT INTO local_import_sessions (
        id, source_kind, state, rights_asserted_at, created_at, updated_at
      ) VALUES (?, 'files', 'active', ?, ?, ?)
    `).run('zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz', 'now', 'now', 'now')).toThrow()
    database.prepare(`
      INSERT INTO generations (
        id, prompt, mode, style, emotion, caption, seed, image, favorite, created_at,
        local_asset_id, local_asset_name_snapshot, local_match_mode, background_source
      ) VALUES ('local-generation', '加班', 'express', 'office', 'tired', '加班', 1,
        X'01', 1, '2026-07-17T00:00:00.000Z', ?, '素材 A', 'automatic', 'local')
    `).run(assetId)
    database.prepare(`
      INSERT INTO local_import_sessions (
        id, source_kind, state, rights_asserted_at, created_at, updated_at
      ) VALUES (?, 'files', 'active', ?, ?, ?)
    `).run(
      sessionId,
      '2026-07-17T00:00:00.000Z',
      '2026-07-17T00:00:00.000Z',
      '2026-07-17T00:00:00.000Z'
    )
    database.prepare(`
      INSERT INTO local_import_items (
        id, session_id, original_filename, state, created_at, updated_at
      ) VALUES (?, ?, 'a.png', 'staged', ?, ?)
    `).run(
      itemId,
      sessionId,
      '2026-07-17T00:00:00.000Z',
      '2026-07-17T00:00:00.000Z'
    )

    database.prepare('DELETE FROM local_assets WHERE id = ?').run(assetId)
    expect(database.prepare('SELECT COUNT(*) AS count FROM local_asset_tags').get())
      .toEqual({ count: 0 })
    expect(database.prepare(`
      SELECT local_asset_id, local_asset_name_snapshot, favorite
      FROM generations WHERE id = 'local-generation'
    `).get()).toEqual({
      local_asset_id: assetId,
      local_asset_name_snapshot: '素材 A',
      favorite: 1
    })

    database.prepare('DELETE FROM local_import_sessions WHERE id = ?').run(sessionId)
    expect(database.prepare('SELECT COUNT(*) AS count FROM local_import_items').get())
      .toEqual({ count: 0 })
    database.close()
  })

  it('refuses to open a database created by a newer application schema', () => {
    const database = new DatabaseSync(':memory:')
    database.exec(`PRAGMA user_version = ${APPLICATION_SCHEMA_VERSION + 1}`)
    expect(() => migrateApplicationDatabase(database)).toThrow(/newer than this application/u)
    expect(tableNames(database)).not.toContain('local_assets')
    database.close()
  })
})
