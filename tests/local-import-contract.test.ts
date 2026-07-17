import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { migrateApplicationDatabase } from '../src/main/database-schema'
import { LocalImportContractStore } from '../src/main/local-import-contract'

const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000'
const ITEM_A = '123e4567-e89b-42d3-a456-426614174001'
const ITEM_B = '123e4567-e89b-42d3-a456-426614174002'
const ITEM_C = '123e4567-e89b-42d3-a456-426614174003'
const NOW = '2026-07-17T03:00:00.000Z'

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:')
  migrateApplicationDatabase(database)
  database.prepare(`
    INSERT INTO local_import_sessions (
      id, source_kind, state, rights_asserted_at, created_at, updated_at
    ) VALUES (?, 'files', 'active', ?, ?, ?)
  `).run(SESSION_ID, NOW, NOW, NOW)
  return database
}

function insertItem(
  database: DatabaseSync,
  id: string,
  state: 'staged' | 'failed' = 'staged',
  withStagingPath = true
): void {
  database.prepare(`
    INSERT INTO local_import_items (
      id, session_id, original_filename, staging_rel_path, state, error_code,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    SESSION_ID,
    `${id}.png`,
    withStagingPath ? `staging/${SESSION_ID}/${id}.png` : null,
    state,
    state === 'failed' ? 'read_failed' : null,
    NOW,
    NOW
  )
}

describe('LocalImportContractStore', () => {
  it('persists draft metadata and finalizes only selected valid items', () => {
    const database = createDatabase()
    insertItem(database, ITEM_A)
    insertItem(database, ITEM_B)
    const store = new LocalImportContractStore(database, () => NOW)

    expect(store.updateDraft({
      sessionId: SESSION_ID,
      itemId: ITEM_A,
      displayName: '  素材 A  ',
      tags: [' 工作 ', 'ＴＡＧ']
    })).toMatchObject({
      ok: true,
      value: {
        id: ITEM_A,
        displayName: '素材 A',
        tags: [
          { displayValue: '工作', normalizedValue: '工作' },
          { displayValue: 'TAG', normalizedValue: 'tag' }
        ]
      }
    })

    const result = store.finalize({
      sessionId: SESSION_ID,
      itemIds: [ITEM_A, ITEM_B]
    })
    expect(result).toMatchObject({
      ok: true,
      value: {
        finalizedItemIds: [ITEM_A],
        rejectedItems: [{
          itemId: ITEM_B,
          error: { code: 'invalid_name' }
        }]
      }
    })
    expect(database.prepare(`
      SELECT id, state, finalized_at FROM local_import_items ORDER BY id
    `).all()).toEqual([
      { id: ITEM_A, state: 'committing', finalized_at: NOW },
      { id: ITEM_B, state: 'staged', finalized_at: null }
    ])
    database.close()
  })

  it('rejects invalid or untagged drafts before the commit boundary', () => {
    const database = createDatabase()
    insertItem(database, ITEM_A)
    const store = new LocalImportContractStore(database, () => NOW)

    expect(store.updateDraft({
      sessionId: SESSION_ID,
      itemId: ITEM_A,
      displayName: '素材',
      tags: []
    })).toMatchObject({ ok: false, error: { code: 'tag_count_out_of_range' } })
    expect(store.finalize({ sessionId: SESSION_ID, itemIds: [ITEM_A] })).toMatchObject({
      ok: true,
      value: {
        finalizedItemIds: [],
        rejectedItems: [{ itemId: ITEM_A, error: { code: 'invalid_name' } }]
      }
    })
    database.close()
  })

  it('retries only failed items that still own a staging path', () => {
    const database = createDatabase()
    insertItem(database, ITEM_A, 'failed')
    insertItem(database, ITEM_B, 'failed', false)
    const store = new LocalImportContractStore(database, () => NOW)

    expect(store.retryFailed({ sessionId: SESSION_ID, itemIds: [ITEM_A] }))
      .toMatchObject({ ok: true })
    expect(database.prepare(`SELECT state, error_code FROM local_import_items WHERE id = ?`)
      .get(ITEM_A)).toEqual({ state: 'staged', error_code: null })
    expect(store.retryFailed({ sessionId: SESSION_ID, itemIds: [ITEM_B] }))
      .toMatchObject({ ok: false, error: { code: 'staging_unavailable' } })
    database.close()
  })

  it('cancels a pre-commit session without creating ready assets', () => {
    const database = createDatabase()
    insertItem(database, ITEM_A)
    insertItem(database, ITEM_C, 'failed')
    const store = new LocalImportContractStore(database, () => NOW)

    expect(store.cancel(SESSION_ID)).toMatchObject({
      ok: true,
      value: {
        state: 'cancelled',
        items: [{ state: 'cancelled' }, { state: 'cancelled' }]
      }
    })
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM local_assets WHERE state = 'ready'
    `).get()).toEqual({ count: 0 })
    database.close()
  })
})
