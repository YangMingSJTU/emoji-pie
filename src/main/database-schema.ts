import type { DatabaseSync } from 'node:sqlite'

export const APPLICATION_SCHEMA_VERSION = 1

interface TableColumn {
  name: string
}

function getColumnNames(database: DatabaseSync, table: string): Set<string> {
  const columns = database
    .prepare(`PRAGMA table_info(${table})`)
    .all() as unknown as TableColumn[]
  return new Set(columns.map(({ name }) => name))
}

function addColumnIfMissing(
  database: DatabaseSync,
  table: string,
  columns: Set<string>,
  column: string,
  definition: string
): void {
  if (columns.has(column)) return
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  columns.add(column)
}

/**
 * Migrates both the original unversioned database and current databases in one
 * transaction. File-system reconciliation intentionally belongs to the F1
 * importer; this migration only establishes durable relational state.
 */
export function migrateApplicationDatabase(database: DatabaseSync): void {
  const versionRow = database
    .prepare('PRAGMA user_version')
    .get() as { user_version: number }
  if (versionRow.user_version > APPLICATION_SCHEMA_VERSION) {
    throw new Error(`Database schema ${versionRow.user_version} is newer than this application`)
  }
  database.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;')
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS generations (
        id TEXT PRIMARY KEY,
        prompt TEXT NOT NULL,
        mode TEXT NOT NULL,
        style TEXT NOT NULL,
        layout TEXT NOT NULL DEFAULT 'poster',
        embed_caption INTEGER NOT NULL DEFAULT 1,
        emotion TEXT NOT NULL,
        caption TEXT NOT NULL,
        seed INTEGER NOT NULL,
        image BLOB NOT NULL,
        favorite INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        local_asset_id TEXT,
        local_asset_name_snapshot TEXT,
        local_match_mode TEXT CHECK (
          local_match_mode IS NULL OR local_match_mode IN ('automatic', 'manual')
        ),
        background_source TEXT NOT NULL DEFAULT 'original' CHECK (
          background_source IN ('original', 'local')
        )
      );
      CREATE TABLE IF NOT EXISTS preferences (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)

    const generationColumns = getColumnNames(database, 'generations')
    addColumnIfMissing(
      database,
      'generations',
      generationColumns,
      'layout',
      "TEXT NOT NULL DEFAULT 'poster'"
    )
    addColumnIfMissing(
      database,
      'generations',
      generationColumns,
      'embed_caption',
      'INTEGER NOT NULL DEFAULT 1'
    )
    addColumnIfMissing(
      database,
      'generations',
      generationColumns,
      'local_asset_id',
      'TEXT'
    )
    addColumnIfMissing(
      database,
      'generations',
      generationColumns,
      'local_asset_name_snapshot',
      'TEXT'
    )
    addColumnIfMissing(
      database,
      'generations',
      generationColumns,
      'local_match_mode',
      "TEXT CHECK (local_match_mode IS NULL OR local_match_mode IN ('automatic', 'manual'))"
    )
    addColumnIfMissing(
      database,
      'generations',
      generationColumns,
      'background_source',
      "TEXT NOT NULL DEFAULT 'original' CHECK (background_source IN ('original', 'local'))"
    )

    database.exec(`
      CREATE TABLE IF NOT EXISTS local_assets (
        id TEXT PRIMARY KEY CHECK (
          length(id) = 36 AND id = lower(id)
            AND id GLOB '????????-????-????-????-????????????'
            AND id NOT GLOB '*[^0-9a-f-]*'
        ),
        display_name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        original_filename TEXT NOT NULL CHECK (
          original_filename NOT LIKE '%/%' AND original_filename NOT LIKE '%\\%'
        ),
        mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
        width INTEGER NOT NULL CHECK (width > 0 AND width <= 8192),
        height INTEGER NOT NULL CHECK (height > 0 AND height <= 8192),
        size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 20971520),
        content_sha256 TEXT NOT NULL CHECK (
          length(content_sha256) = 64 AND content_sha256 = lower(content_sha256)
            AND content_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        pixel_sha256 TEXT NOT NULL CHECK (
          length(pixel_sha256) = 64 AND pixel_sha256 = lower(pixel_sha256)
            AND pixel_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        source_rel_path TEXT NOT NULL,
        thumbnail_rel_path TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('committing', 'ready')),
        rights_asserted_at TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (width * height <= 40000000)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_local_assets_content_sha256
        ON local_assets(content_sha256);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_local_assets_pixel_sha256
        ON local_assets(pixel_sha256);
      CREATE INDEX IF NOT EXISTS idx_local_assets_ready_imported
        ON local_assets(state, imported_at DESC, id ASC);

      CREATE TABLE IF NOT EXISTS local_asset_tags (
        asset_id TEXT NOT NULL REFERENCES local_assets(id) ON DELETE CASCADE,
        display_value TEXT NOT NULL,
        normalized_value TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        PRIMARY KEY (asset_id, normalized_value),
        UNIQUE (asset_id, ordinal)
      );
      CREATE INDEX IF NOT EXISTS idx_local_asset_tags_asset_ordinal
        ON local_asset_tags(asset_id, ordinal ASC);

      CREATE TABLE IF NOT EXISTS local_import_sessions (
        id TEXT PRIMARY KEY CHECK (
          length(id) = 36 AND id = lower(id)
            AND id GLOB '????????-????-????-????-????????????'
            AND id NOT GLOB '*[^0-9a-f-]*'
        ),
        source_kind TEXT NOT NULL CHECK (source_kind IN ('files', 'directory')),
        state TEXT NOT NULL CHECK (state IN ('active', 'completed', 'cancelled')),
        rights_asserted_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS local_import_items (
        id TEXT PRIMARY KEY CHECK (
          length(id) = 36 AND id = lower(id)
            AND id GLOB '????????-????-????-????-????????????'
            AND id NOT GLOB '*[^0-9a-f-]*'
        ),
        session_id TEXT NOT NULL REFERENCES local_import_sessions(id) ON DELETE CASCADE,
        original_filename TEXT NOT NULL CHECK (
          original_filename NOT LIKE '%/%' AND original_filename NOT LIKE '%\\%'
        ),
        staging_rel_path TEXT,
        display_name TEXT,
        normalized_name TEXT,
        mime_type TEXT,
        width INTEGER,
        height INTEGER,
        size_bytes INTEGER,
        content_sha256 TEXT,
        pixel_sha256 TEXT,
        state TEXT NOT NULL CHECK (
          state IN ('staged', 'processing', 'duplicate', 'committing', 'ready', 'failed', 'cancelled')
        ),
        error_code TEXT,
        duplicate_asset_id TEXT,
        imported_asset_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_local_import_items_session_state
        ON local_import_items(session_id, state, created_at ASC);

      CREATE INDEX IF NOT EXISTS idx_generations_created_at
        ON generations(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_generations_favorite
        ON generations(favorite, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_generations_local_asset
        ON generations(local_asset_id, created_at DESC);
      PRAGMA user_version = ${APPLICATION_SCHEMA_VERSION};
    `)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}
