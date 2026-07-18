import { access, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalAssetService } from '../src/main/local-asset-importer'
import { LocalAssetIndex } from '../src/main/local-asset-index'
import { LocalAssetPathService } from '../src/main/local-asset-paths'
import type {
  LocalAssetPicker,
  LocalAssetSelection
} from '../src/main/local-asset-picker'
import { localAssetThumbnailUrl } from '../src/main/local-asset-protocol'
import { LocalAssetRepository } from '../src/main/local-asset-repository'
import {
  SharpLocalAssetWorkerPool,
  type LocalAssetWorkerPool
} from '../src/main/local-asset-worker'

const temporaryDirectories: string[] = []

class QueuePicker implements LocalAssetPicker {
  constructor(private readonly selections: LocalAssetSelection[]) {}

  async select(): Promise<LocalAssetSelection | undefined> {

    return this.selections.shift()
  }
}

const unusedWorkers: LocalAssetWorkerPool = {
  async process() {
    throw new Error('worker must not run during recovery')
  },
  async renderPoster() {
    throw new Error('poster worker must not run during recovery')
  },
  async dispose() {}
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'emoji-pie-assets-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
})

describe('LocalAssetService', () => {
  it('imports, deduplicates, edits, matches and deletes without modifying the source', async () => {
    const directory = await temporaryDirectory()
    const sourcePath = join(directory, '猫猫加班.png')
    const disguisedPath = join(directory, '伪装.jpg')
    await sharp({
      create: { width: 64, height: 48, channels: 4, background: '#ffc857' }
    }).png().toFile(sourcePath)
    await sharp({
      create: { width: 32, height: 32, channels: 4, background: '#58a6ff' }
    }).png().toFile(disguisedPath)
    const userData = join(directory, 'user-data')
    await mkdir(userData, { recursive: true })
    const paths = new LocalAssetPathService(userData)
    const repository = new LocalAssetRepository(
      join(userData, 'emoji-pie.sqlite'),
      localAssetThumbnailUrl,
      () => '2026-07-17T04:00:00.000Z'
    )
    const index = new LocalAssetIndex()
    const picker = new QueuePicker([
      { sources: [{ sourcePath, originalFilename: '猫猫加班.png' }], scanLimitReached: false },
      { sources: [{ sourcePath, originalFilename: '猫猫加班.png' }], scanLimitReached: false },
      { sources: [{ sourcePath: disguisedPath, originalFilename: '伪装.jpg' }], scanLimitReached: false }
    ])
    const service = new LocalAssetService(
      repository,
      index,
      paths,
      picker,
      new SharpLocalAssetWorkerPool()
    )
    await service.initialize()
    try {
      const begun = await service.beginImport({ sourceKind: 'files', rightsConfirmed: true })
      expect(begun).toMatchObject({ ok: true, value: { items: [{ state: 'processing' }] } })
      if (!begun.ok) throw new Error('begin failed')
      await service.waitForIdle()
      const scanned = await service.getImportSession({ sessionId: begun.value.id })
      expect(scanned).toMatchObject({
        ok: true,
        value: { items: [{ state: 'staged', mimeType: 'image/png', width: 64, height: 48 }] }
      })
      if (!scanned.ok) throw new Error('scan failed')
      const itemId = scanned.value.items[0].id
      expect(await service.updateImportDraft({
        sessionId: begun.value.id,
        itemId,
        displayName: '猫猫加班',
        tags: ['加班', '猫']
      })).toMatchObject({ ok: true })
      const finalized = await service.finalizeImport({ sessionId: begun.value.id, itemIds: [itemId] })
      expect(finalized).toMatchObject({ ok: true, value: { finalizedItemIds: [itemId] } })

      const listed = await service.list()
      expect(listed).toMatchObject({
        ok: true,
        value: [{ displayName: '猫猫加班', tags: [{ displayValue: '加班' }, { displayValue: '猫' }] }]
      })
      if (!listed.ok) throw new Error('list failed')
      const asset = listed.value[0]
      expect(index.match('今天又要加班')[0]?.asset.id).toBe(asset.id)
      await expect(access(sourcePath)).resolves.toBeUndefined()

      const duplicate = await service.beginImport({ sourceKind: 'files', rightsConfirmed: true })
      if (!duplicate.ok) throw new Error('duplicate begin failed')
      await service.waitForIdle()
      expect(await service.getImportSession({ sessionId: duplicate.value.id })).toMatchObject({
        ok: true,
        value: { items: [{ state: 'duplicate', error: { code: 'duplicate_content' } }] }
      })

      const disguised = await service.beginImport({ sourceKind: 'files', rightsConfirmed: true })
      if (!disguised.ok) throw new Error('disguised begin failed')
      await service.waitForIdle()
      expect(await service.getImportSession({ sessionId: disguised.value.id })).toMatchObject({
        ok: true,
        value: { items: [{ state: 'failed', error: { code: 'unsupported_type' } }] }
      })

      expect(await service.updateMetadata({
        assetId: asset.id,
        displayName: '猫猫下班',
        tags: ['下班']
      })).toMatchObject({ ok: true, value: { displayName: '猫猫下班' } })
      expect(index.match('加班')).toEqual([])

      expect(index.match('终于下班')[0]?.asset.id).toBe(asset.id)
      expect(await service.delete({ assetId: asset.id })).toEqual({ ok: true, value: undefined })
      expect(await service.list()).toEqual({ ok: true, value: [] })
      expect(index.match('下班')).toEqual([])
      await expect(access(sourcePath)).resolves.toBeUndefined()
    } finally {
      await service.dispose()
    }
  }, 20_000)
  it('finishes a committing asset after a crash moved both managed files', async () => {
    const directory = await temporaryDirectory()
    const userData = join(directory, 'user-data')
    await mkdir(userData, { recursive: true })
    const paths = new LocalAssetPathService(userData)
    await Promise.all([
      mkdir(paths.directory('staging'), { recursive: true }),
      mkdir(paths.directory('originals'), { recursive: true }),
      mkdir(paths.directory('thumbnails'), { recursive: true })
    ])
    const repository = new LocalAssetRepository(
      join(userData, 'emoji-pie.sqlite'),
      localAssetThumbnailUrl,
      () => '2026-07-17T04:30:00.000Z'
    )
    const sessionId = '123e4567-e89b-42d3-a456-426614174200'
    const itemId = '123e4567-e89b-42d3-a456-426614174201'
    const assetId = '123e4567-e89b-42d3-a456-426614174202'
    const stagingRelativePath = paths.stagingRelativePath(sessionId, itemId, 'png')
    const stagingSource = paths.resolveStagingItem(sessionId, itemId, stagingRelativePath)
    const stagingThumbnail = paths.stagingThumbnailPath(sessionId, itemId)
    await mkdir(join(paths.directory('staging'), sessionId), { recursive: true })
    await writeFile(stagingSource, Buffer.from('source'))
    await writeFile(stagingThumbnail, Buffer.from('thumbnail'))

    repository.createImportSession(sessionId, 'files', '2026-07-17T04:30:00.000Z')
    repository.addImportItem({
      id: itemId,
      sessionId,
      originalFilename: 'recovery.png',
      stagingRelativePath,
      displayName: '恢复素材'
    })
    repository.markItemStaged({
      itemId,
      mimeType: 'image/png',
      width: 32,
      height: 32,
      sizeBytes: 6,
      contentSha256: 'a'.repeat(64),
      pixelSha256: 'b'.repeat(64)
    })
    expect(repository.updateDraft({
      sessionId,
      itemId,
      displayName: '恢复素材',
      tags: ['恢复']
    })).toMatchObject({ ok: true })
    expect(repository.finalizeDraft({ sessionId, itemIds: [itemId] })).toMatchObject({
      ok: true,
      value: { finalizedItemIds: [itemId] }
    })
    const sourceRelativePath = paths.originalRelativePath(assetId, 'png')
    const thumbnailRelativePath = paths.thumbnailRelativePath(assetId)
    repository.prepareAssetCommit({
      itemId,
      assetId,
      sourceRelativePath,
      thumbnailRelativePath
    })
    await rename(stagingSource, paths.resolveAssetSource(assetId, sourceRelativePath))
    await rename(stagingThumbnail, paths.resolveAssetThumbnail(assetId, thumbnailRelativePath))

    const service = new LocalAssetService(
      repository,
      new LocalAssetIndex(),
      paths,
      new QueuePicker([]),
      unusedWorkers
    )
    await service.initialize()
    try {
      expect(await service.list()).toMatchObject({
        ok: true,
        value: [{ id: assetId, displayName: '恢复素材' }]
      })
      expect(repository.getImportItem(itemId)).toMatchObject({
        state: 'ready',
        imported_asset_id: assetId
      })
    } finally {
      await service.dispose()
    }
  }, 20_000)
})
