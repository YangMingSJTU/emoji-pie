import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LocalAssetPathService,
  parseManagedLocalAssetRelativePath
} from '../src/main/local-asset-paths'

const ASSET_ID = '123e4567-e89b-42d3-a456-426614174000'
const OTHER_ASSET_ID = '123e4567-e89b-42d3-a456-426614174001'
const SESSION_ID = '123e4567-e89b-42d3-a456-426614174002'
const ITEM_ID = '123e4567-e89b-42d3-a456-426614174003'
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
})

describe('managed local asset path ownership', () => {
  it('accepts only the frozen canonical grammar', () => {
    expect(parseManagedLocalAssetRelativePath(`originals/${ASSET_ID}.jpeg`)).toEqual({
      scope: 'originals', assetId: ASSET_ID, extension: 'jpeg'
    })
    expect(parseManagedLocalAssetRelativePath(`thumbnails/${ASSET_ID}.webp`)).toEqual({
      scope: 'thumbnails', assetId: ASSET_ID, extension: 'webp'
    })
    expect(parseManagedLocalAssetRelativePath(
      `staging/${SESSION_ID}/${ITEM_ID}.png`
    )).toEqual({
      scope: 'staging', sessionId: SESSION_ID, itemId: ITEM_ID, extension: 'png'
    })
    for (const invalidPath of [
      `originals/${ASSET_ID}.gif`,
      `originals/${ASSET_ID.toUpperCase()}.png`,
      `thumbnails/${ASSET_ID}.png`,
      `staging/${SESSION_ID}/${ITEM_ID}.exe`,
      `staging/${SESSION_ID}/nested/${ITEM_ID}.png`
    ]) {
      expect(parseManagedLocalAssetRelativePath(invalidPath)).toBeUndefined()
    }
  })

  it('rejects another asset, session, or item before resolving a database path', () => {
    const paths = new LocalAssetPathService(join(tmpdir(), 'emoji-pie-owner-test'))
    expect(() => paths.resolveAssetSource(
      ASSET_ID,
      `originals/${OTHER_ASSET_ID}.png`
    )).toThrow(/does not belong/u)
    expect(() => paths.resolveAssetThumbnail(
      ASSET_ID,
      `thumbnails/${OTHER_ASSET_ID}.webp`
    )).toThrow(/does not belong/u)
    expect(() => paths.resolveStagingItem(
      SESSION_ID,
      ITEM_ID,
      `staging/${OTHER_ASSET_ID}/${ITEM_ID}.png`
    )).toThrow(/does not belong/u)
  })

  it('rejects a junction/reparse escape after lstat and realpath', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'emoji-pie-path-'))
    temporaryDirectories.push(temporaryDirectory)
    const userData = join(temporaryDirectory, 'user-data')
    const root = join(userData, 'local-assets')
    const external = join(temporaryDirectory, 'external')
    await mkdir(root, { recursive: true })
    await mkdir(external, { recursive: true })
    await writeFile(join(external, `${ASSET_ID}.png`), 'not-an-image')
    await symlink(external, join(root, 'originals'), 'junction')

    const paths = new LocalAssetPathService(userData)
    await expect(paths.assertOwnedRegularFile(
      `originals/${ASSET_ID}.png`,
      { scope: 'originals', assetId: ASSET_ID }
    )).rejects.toThrow(/escapes its root/u)
  })
})
