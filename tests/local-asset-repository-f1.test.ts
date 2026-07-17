import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { LocalAssetRepository } from '../src/main/local-asset-repository'

const SESSION_ID = '123e4567-e89b-42d3-a456-426614174100'
const ITEM_A = '123e4567-e89b-42d3-a456-426614174101'
const ITEM_B = '123e4567-e89b-42d3-a456-426614174102'

describe('LocalAssetRepository F1 reservations', () => {
  it('makes a processing content hash visible before another concurrent item proceeds', () => {
    const database = new DatabaseSync(':memory:')
    const repository = new LocalAssetRepository(database, (id) => `local://${id}`)
    repository.createImportSession(SESSION_ID, 'files', '2026-07-17T04:00:00.000Z')
    repository.addImportItem({
      id: ITEM_A,
      sessionId: SESSION_ID,
      originalFilename: 'a.png',
      stagingRelativePath: `staging/${SESSION_ID}/${ITEM_A}.png`,
      displayName: 'A'
    })
    repository.addImportItem({
      id: ITEM_B,
      sessionId: SESSION_ID,
      originalFilename: 'b.png',
      stagingRelativePath: `staging/${SESSION_ID}/${ITEM_B}.png`,
      displayName: 'B'
    })

    repository.setProcessingContentHash(ITEM_A, 'a'.repeat(64))
    expect(repository.hasImportDuplicate(ITEM_A, 'a'.repeat(64))).toBeUndefined()
    repository.setProcessingContentHash(ITEM_B, 'a'.repeat(64))
    expect(repository.hasImportDuplicate(ITEM_B, 'a'.repeat(64))).toBe('duplicate_content')

    repository.close()
    database.close()
  })
})
