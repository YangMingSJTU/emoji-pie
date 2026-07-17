import { describe, expect, it } from 'vitest'
import { LocalAssetIndex } from '../src/main/local-asset-index'
import type { LocalAssetDto } from '../src/shared/local-assets'

function asset(
  idSuffix: string,
  displayName: string,
  tags: string[],
  importedAt: string
): LocalAssetDto {
  return {
    id: `123e4567-e89b-42d3-a456-4266141740${idSuffix}`,
    displayName,
    originalFilename: `${displayName}.png`,
    mimeType: 'image/png',
    width: 320,
    height: 320,
    sizeBytes: 1024,
    tags: tags.map((tag) => ({ displayValue: tag, normalizedValue: tag })),
    thumbnailUrl: `emoji-pie-local-asset://thumbnail/${idSuffix}`,
    rightsAssertedAt: importedAt,
    importedAt,
    updatedAt: importedAt
  }
}

describe('LocalAssetIndex', () => {
  it('uses the frozen tag-first score, deterministic order, and exclusion set', () => {
    const index = new LocalAssetIndex()
    const byName = asset('01', '加班表情', ['工作'], '2026-07-17T01:00:00.000Z')
    const byTag = asset('02', '猫猫震惊', ['加班', '崩溃'], '2026-07-17T00:00:00.000Z')
    const newerTag = asset('03', '狗狗叹气', ['加班'], '2026-07-17T02:00:00.000Z')
    index.replace([byName, byTag, newerTag])

    expect(index.match('今天又要加班').map((match) => match.asset.id)).toEqual([
      newerTag.id,
      byTag.id,
      byName.id
    ])
    expect(index.match('今天又要加班')[0]).toMatchObject({
      matchedFields: ['tag'],
      matchedTags: ['加班']
    })
    expect(index.match('今天又要加班', { excludedIds: new Set([newerTag.id]) })
      .map((match) => match.asset.id)).toEqual([byTag.id, byName.id])
  })

  it('returns no fallback asset when neither a name nor tag matches', () => {
    const index = new LocalAssetIndex()
    index.upsert(asset('04', '猫猫震惊', ['震惊'], '2026-07-17T00:00:00.000Z'))
    expect(index.match('周末出去露营')).toEqual([])
  })
})
