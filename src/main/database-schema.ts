import type { DatabaseSync } from 'node:sqlite'

export const APPLICATION_SCHEMA_VERSION = 2

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
        source_rel_path TEXT NOT NULL CHECK (
          source_rel_path IN ('originals/' || id || '.png', 'originals/' || id || '.jpg',
            'originals/' || id || '.jpeg', 'originals/' || id || '.webp')
        ),
        thumbnail_rel_path TEXT NOT NULL CHECK (
          thumbnail_rel_path = 'thumbnails/' || id || '.webp'
        ),
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
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal < 12),
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
        staging_rel_path TEXT CHECK (
          staging_rel_path IS NULL OR staging_rel_path IN (
            'staging/' || session_id || '/' || id || '.png',
            'staging/' || session_id || '/' || id || '.jpg',
            'staging/' || session_id || '/' || id || '.jpeg',
            'staging/' || session_id || '/' || id || '.webp'
          )
        ),
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
        finalized_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_local_import_items_session_state
        ON local_import_items(session_id, state, created_at ASC);

      CREATE TABLE IF NOT EXISTS local_import_item_tags (
        item_id TEXT NOT NULL REFERENCES local_import_items(id) ON DELETE CASCADE,
        display_value TEXT NOT NULL CHECK (length(trim(display_value)) > 0),
        normalized_value TEXT NOT NULL CHECK (length(normalized_value) > 0),
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal < 12),
        PRIMARY KEY (item_id, normalized_value),
        UNIQUE (item_id, ordinal)
      );
      CREATE INDEX IF NOT EXISTS idx_local_import_item_tags_item_ordinal
        ON local_import_item_tags(item_id, ordinal ASC);

      CREATE INDEX IF NOT EXISTS idx_generations_created_at
        ON generations(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_generations_favorite
        ON generations(favorite, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_generations_local_asset
        ON generations(local_asset_id, created_at DESC);
    `)

    const importItemColumns = getColumnNames(database, 'local_import_items')
    addColumnIfMissing(
      database,
      'local_import_items',
      importItemColumns,
      'finalized_at',
      'TEXT'
    )

    database.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_local_assets_paths_insert
      BEFORE INSERT ON local_assets
      WHEN NEW.source_rel_path NOT IN (
          'originals/' || NEW.id || '.png', 'originals/' || NEW.id || '.jpg',
          'originals/' || NEW.id || '.jpeg', 'originals/' || NEW.id || '.webp'
        ) OR NEW.thumbnail_rel_path != ('thumbnails/' || NEW.id || '.webp')
      BEGIN
        SELECT RAISE(ABORT, 'local asset path owner mismatch');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_local_assets_paths_update
      BEFORE UPDATE OF id, source_rel_path, thumbnail_rel_path ON local_assets
      WHEN NEW.source_rel_path NOT IN (
          'originals/' || NEW.id || '.png', 'originals/' || NEW.id || '.jpg',
          'originals/' || NEW.id || '.jpeg', 'originals/' || NEW.id || '.webp'
        ) OR NEW.thumbnail_rel_path != ('thumbnails/' || NEW.id || '.webp')
      BEGIN
        SELECT RAISE(ABORT, 'local asset path owner mismatch');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_local_import_staging_path_insert
      BEFORE INSERT ON local_import_items
      WHEN NEW.staging_rel_path IS NOT NULL AND NEW.staging_rel_path NOT IN (
        'staging/' || NEW.session_id || '/' || NEW.id || '.png',
        'staging/' || NEW.session_id || '/' || NEW.id || '.jpg',
        'staging/' || NEW.session_id || '/' || NEW.id || '.jpeg',
        'staging/' || NEW.session_id || '/' || NEW.id || '.webp'
      )
      BEGIN
        SELECT RAISE(ABORT, 'local import staging path owner mismatch');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_local_import_staging_path_update
      BEFORE UPDATE OF id, session_id, staging_rel_path ON local_import_items
      WHEN NEW.staging_rel_path IS NOT NULL AND NEW.staging_rel_path NOT IN (
        'staging/' || NEW.session_id || '/' || NEW.id || '.png',
        'staging/' || NEW.session_id || '/' || NEW.id || '.jpg',
        'staging/' || NEW.session_id || '/' || NEW.id || '.jpeg',
        'staging/' || NEW.session_id || '/' || NEW.id || '.webp'
      )
      BEGIN
        SELECT RAISE(ABORT, 'local import staging path owner mismatch');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_local_import_finalize_insert
      BEFORE INSERT ON local_import_items
      WHEN NEW.state IN ('committing', 'ready')
      BEGIN
        SELECT RAISE(ABORT, 'local import item must be finalized before commit');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_local_import_finalize_update
      BEFORE UPDATE OF state, finalized_at ON local_import_items
      WHEN NEW.state IN ('committing', 'ready') AND (
        NEW.finalized_at IS NULL OR
        (SELECT COUNT(*) FROM local_import_item_tags WHERE item_id = NEW.id) NOT BETWEEN 1 AND 12
      )
      BEGIN
        SELECT RAISE(ABORT, 'local import item requires finalized metadata and tags');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_local_assets_ready_insert
      BEFORE INSERT ON local_assets
      WHEN NEW.state = 'ready'
      BEGIN
        SELECT RAISE(ABORT, 'local asset must enter through committing state');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_local_assets_ready_update
      BEFORE UPDATE OF state ON local_assets
      WHEN NEW.state = 'ready' AND (
        SELECT COUNT(*) FROM local_asset_tags WHERE asset_id = NEW.id
      ) NOT BETWEEN 1 AND 12
      BEGIN
        SELECT RAISE(ABORT, 'ready local asset requires 1-12 tags');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_local_assets_capacity_insert
      BEFORE INSERT ON local_assets
      WHEN (SELECT COUNT(*) FROM local_assets) >= 500
      BEGIN
        SELECT RAISE(ABORT, 'local asset capacity reached');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_local_asset_tags_max_insert
      BEFORE INSERT ON local_asset_tags
      WHEN (SELECT COUNT(*) FROM local_asset_tags WHERE asset_id = NEW.asset_id) >= 12
      BEGIN
        SELECT RAISE(ABORT, 'local asset supports at most 12 tags');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_local_asset_tags_owner_update
      BEFORE UPDATE OF asset_id ON local_asset_tags
      WHEN NEW.asset_id != OLD.asset_id
      BEGIN
        SELECT RAISE(ABORT, 'local asset tag owner is immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_local_asset_tags_ready_delete
      BEFORE DELETE ON local_asset_tags
      WHEN (SELECT state FROM local_assets WHERE id = OLD.asset_id) = 'ready' AND
        (SELECT COUNT(*) FROM local_asset_tags WHERE asset_id = OLD.asset_id) <= 1
      BEGIN
        SELECT RAISE(ABORT, 'ready local asset requires at least one tag');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_local_import_tags_finalized_insert
      BEFORE INSERT ON local_import_item_tags
      WHEN (SELECT state FROM local_import_items WHERE id = NEW.item_id) IN ('committing', 'ready')
      BEGIN
        SELECT RAISE(ABORT, 'finalized import tags are immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_local_import_tags_finalized_update
      BEFORE UPDATE ON local_import_item_tags
      WHEN (SELECT state FROM local_import_items WHERE id = OLD.item_id) IN ('committing', 'ready')
        OR (SELECT state FROM local_import_items WHERE id = NEW.item_id) IN ('committing', 'ready')
      BEGIN
        SELECT RAISE(ABORT, 'finalized import tags are immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_local_import_tags_finalized_delete
      BEFORE DELETE ON local_import_item_tags
      WHEN (SELECT state FROM local_import_items WHERE id = OLD.item_id) IN ('committing', 'ready')
      BEGIN
        SELECT RAISE(ABORT, 'finalized import tags are immutable');
      END;
    `)

    const invalidAssetPath = database.prepare(`
      SELECT 1 FROM local_assets
      WHERE source_rel_path NOT IN (
        'originals/' || id || '.png', 'originals/' || id || '.jpg',
        'originals/' || id || '.jpeg', 'originals/' || id || '.webp'
      ) OR thumbnail_rel_path != ('thumbnails/' || id || '.webp')
      LIMIT 1
    `).get()
    const invalidStagingPath = database.prepare(`
      SELECT 1 FROM local_import_items
      WHERE staging_rel_path IS NOT NULL AND staging_rel_path NOT IN (
        'staging/' || session_id || '/' || id || '.png',
        'staging/' || session_id || '/' || id || '.jpg',
        'staging/' || session_id || '/' || id || '.jpeg',
        'staging/' || session_id || '/' || id || '.webp'
      ) LIMIT 1
    `).get()
    const invalidReadyAsset = database.prepare(`
      SELECT 1 FROM local_assets
      WHERE state = 'ready' AND (
        SELECT COUNT(*) FROM local_asset_tags WHERE asset_id = local_assets.id
      ) NOT BETWEEN 1 AND 12
      LIMIT 1
    `).get()
    const invalidAssetTag = database.prepare(`
      SELECT 1 FROM local_asset_tags
      WHERE ordinal NOT BETWEEN 0 AND 11
      GROUP BY asset_id
      HAVING COUNT(*) > 12 OR MIN(ordinal) < 0 OR MAX(ordinal) > 11
      LIMIT 1
    `).get()
    if (invalidAssetPath || invalidStagingPath || invalidReadyAsset || invalidAssetTag) {
      throw new Error('Existing local asset data violates schema v2 ownership or tag constraints')
    }

    database.exec(`PRAGMA user_version = ${APPLICATION_SCHEMA_VERSION}`)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}
