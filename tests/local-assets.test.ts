import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LocalAssetPathService,
  isManagedLocalAssetRelativePath
} from '../src/main/local-asset-paths'
import {
  countGraphemes,
  normalizeLocalAssetId,
  normalizeLocalAssetText,
  validateLocalAssetMetadata
} from '../src/shared/local-assets'

const ASSET_ID = '123E4567-E89B-42D3-A456-426614174000'

describe('LocalAssetPathService', () => {
  it('creates canonical relative paths and resolves only inside userData/local-assets', () => {
    const userData = resolve('fixtures', 'user-data')
    const paths = new LocalAssetPathService(userData)
    const lowerId = ASSET_ID.toLowerCase()

    expect(paths.originalRelativePath(ASSET_ID, '.PNG')).toBe(`originals/${lowerId}.png`)
    expect(paths.thumbnailRelativePath(ASSET_ID)).toBe(`thumbnails/${lowerId}.webp`)
    expect(paths.stagingRelativePath(ASSET_ID, ASSET_ID, 'jpeg')).toBe(
      `staging/${lowerId}/${lowerId}.jpeg`
    )
    expect(paths.resolve(`originals/${lowerId}.png`)).toBe(
      join(userData, 'local-assets', 'originals', `${lowerId}.png`)
    )
    expect(paths.toRelative(join(
      userData,
      'local-assets',
      'thumbnails',
      `${lowerId}.webp`
    ))).toBe(`thumbnails/${lowerId}.webp`)
  })

  it('rejects traversal, absolute input, backslashes, relative host paths, and unsupported types', () => {
    const paths = new LocalAssetPathService(resolve('fixtures', 'user-data'))
    expect(isManagedLocalAssetRelativePath('../originals/a.png')).toBe(false)
    expect(isManagedLocalAssetRelativePath('originals/../a.png')).toBe(false)
    expect(isManagedLocalAssetRelativePath('originals\\a.png')).toBe(false)
    expect(() => paths.resolve('../outside.png')).toThrow(/canonical and relative/u)
    expect(() => paths.toRelative('originals/a.png')).toThrow(/must be absolute/u)
    expect(() => paths.toRelative(resolve('fixtures', 'outside.png'))).toThrow(/outside/u)
    expect(() => paths.originalRelativePath(ASSET_ID, 'gif')).toThrow(/Unsupported/u)
    expect(() => paths.thumbnailRelativePath('not-a-uuid')).toThrow(/UUID/u)
  })
})

describe('local asset shared validation', () => {
  it('normalizes compatibility forms, whitespace, case, and UUIDs deterministically', () => {
    expect(normalizeLocalAssetText('  ＴＡＧ\tName  ')).toBe('tag name')
    expect(normalizeLocalAssetId(ASSET_ID)).toBe(ASSET_ID.toLowerCase())
    expect(normalizeLocalAssetId('not-a-uuid')).toBeUndefined()
    expect(countGraphemes('e\u0301👨‍👩‍👧‍👦')).toBe(2)
  })

  it('accepts the frozen name and tag boundaries', () => {
    expect(validateLocalAssetMetadata('😀'.repeat(60), ['字'.repeat(20)])).toEqual([])
    expect(validateLocalAssetMetadata('素材', Array.from(
      { length: 12 },
      (_, index) => `标签${index}`
    ))).toEqual([])
  })

  it('reports explicit codes for out-of-range and normalized duplicate values', () => {
    expect(validateLocalAssetMetadata('', [])).toEqual(expect.arrayContaining([
      { code: 'invalid_name', field: 'displayName' },
      { code: 'tag_count_out_of_range', field: 'tags' }
    ]))
    expect(validateLocalAssetMetadata('😀'.repeat(61), ['a'.repeat(21)])).toEqual([
      { code: 'invalid_name', field: 'displayName' },
      { code: 'invalid_tag', field: 'tags', tagIndex: 0 }
    ])
    expect(validateLocalAssetMetadata('素材', ['ＴＡＧ', ' tag  '])).toContainEqual({
      code: 'duplicate_tag',
      field: 'tags',
      tagIndex: 1
    })
    expect(validateLocalAssetMetadata('素材', Array.from(
      { length: 13 },
      (_, index) => `标签${index}`
    ))).toContainEqual({ code: 'tag_count_out_of_range', field: 'tags' })
  })
})
