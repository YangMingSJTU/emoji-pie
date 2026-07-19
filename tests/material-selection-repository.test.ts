import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { MaterialSelectionRepository } from '../src/main/material-selection-repository'
import { migrateApplicationDatabase } from '../src/main/database-schema'
import { MATERIAL_SELECTION_PREFERENCE_KEY } from '../src/shared/starter-packs'

const NOW = '2026-07-19T14:40:00.000Z'
const USER_ID = '123e4567-e89b-42d3-a456-426614174001'
const STARTER_ID = '123e4567-e89b-42d3-a456-426614174002'

describe('MaterialSelectionRepository', () => {
  it('keeps ordered snapshots, normalizes UUID case, and deduplicates first occurrence', () => {
    const database = new DatabaseSync(':memory:')
    const repository = new MaterialSelectionRepository(database, () => NOW)
    const state = repository.save({
      mode: 'manual',
      autoScope: 'all',
      manualDraft: [
        { assetId: USER_ID.toUpperCase(), nameSnapshot: ' 我的素材 ', source: 'user' },
        { assetId: USER_ID, nameSnapshot: '重复项', source: 'user' },
        {
          assetId: STARTER_ID,
          nameSnapshot: '欢呼彩带',
          source: 'starter_pack',
          packId: 'starter-pack-v1',
          packVersion: '1.0.0',
          packAssetKey: 'SPV1-001'
        }
      ]
    })

    expect(state).toEqual({
      version: 1,
      mode: 'manual',
      autoScope: 'all',
      manualDraft: [
        { assetId: USER_ID, nameSnapshot: '我的素材', source: 'user' },
        {
          assetId: STARTER_ID,
          nameSnapshot: '欢呼彩带',
          source: 'starter_pack',
          packId: 'starter-pack-v1',
          packVersion: '1.0.0',
          packAssetKey: 'SPV1-001'
        }
      ],
      updatedAt: NOW
    })
    expect(repository.load()).toEqual(state)
    database.close()
  })

  it('hard-rejects a tenth draft item before writing', () => {
    const database = new DatabaseSync(':memory:')
    const repository = new MaterialSelectionRepository(database, () => NOW)
    expect(() => repository.save({
      mode: 'manual',
      autoScope: 'user_only',
      manualDraft: Array.from({ length: 10 }, (_, index) => ({
        assetId: `123e4567-e89b-42d3-a456-4266141740${String(index).padStart(2, '0')}`,
        nameSnapshot: `素材 ${index}`,
        source: 'user' as const
      }))
    })).toThrow(/最多保存 9 项/u)
    database.close()
  })

  it('isolates an invalid selection preference without changing unrelated preferences', () => {
    const database = new DatabaseSync(':memory:')
    migrateApplicationDatabase(database)
    database.prepare(
      'INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)'
    ).run('unrelated', '{"keep":true}', NOW)
    database.prepare(
      'INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)'
    ).run(MATERIAL_SELECTION_PREFERENCE_KEY, '{"version":1,"manualDraft":"bad"}', NOW)

    const repository = new MaterialSelectionRepository(database, () => NOW)
    expect(repository.load()).toEqual({
      version: 1,
      mode: 'automatic',
      autoScope: 'starter_only',
      manualDraft: [],
      updatedAt: NOW
    })
    expect(database.prepare(
      'SELECT value FROM preferences WHERE key = ?'
    ).get('unrelated')).toEqual({ value: '{"keep":true}' })
    expect(database.prepare(
      'SELECT value FROM preferences WHERE key = ?'
    ).get(MATERIAL_SELECTION_PREFERENCE_KEY)).toBeUndefined()
    database.close()
  })
})
