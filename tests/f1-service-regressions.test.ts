import { randomUUID } from 'node:crypto'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LocalAssetService,
  type LocalAssetDeletionFileOperations
} from '../src/main/local-asset-importer'
import { LocalAssetIndex } from '../src/main/local-asset-index'
import { LocalAssetPathService } from '../src/main/local-asset-paths'
import type {
  LocalAssetPicker,
  LocalAssetSelection
} from '../src/main/local-asset-picker'
import { localAssetThumbnailUrl } from '../src/main/local-asset-protocol'
import { LocalAssetRepository } from '../src/main/local-asset-repository'
import type { LocalAssetWorkerPool, LocalAssetWorkerResult } from '../src/main/local-asset-worker'

const NOW = '2026-07-17T09:00:00.000Z'
const temporaryDirectories: string[] = []

class QueuePicker implements LocalAssetPicker {
  constructor(private readonly selections: Array<LocalAssetSelection | Error>) {}

  async select(): Promise<LocalAssetSelection | undefined> {
    const selection = this.selections.shift()
    if (selection instanceof Error) throw selection
    return selection
  }
}

const workerResult: LocalAssetWorkerResult = {
  mimeType: 'image/png',
  width: 2,
  height: 2,
  pixelSha256: 'b'.repeat(64),
  thumbnail: Buffer.from('thumbnail')
}

const immediateWorker: LocalAssetWorkerPool = {
  async process() { return workerResult },
  async renderPoster() { throw new Error('poster worker is unused') },
  async dispose() {}
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'emoji-pie-f1-service-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
})

async function createReadyAsset(
  root: string,
  deletionFiles?: LocalAssetDeletionFileOperations
): Promise<{
  service: LocalAssetService
  sourcePath: string
  assetId: string
}> {
  const sourcePath = join(root, 'source.png')
  const userData = join(root, 'user-data')
  await Promise.all([writeFile(sourcePath, 'source bytes'), mkdir(userData, { recursive: true })])
  const repository = new LocalAssetRepository(
    join(userData, 'emoji-pie.sqlite'),
    localAssetThumbnailUrl,
    () => NOW
  )
  const service = new LocalAssetService(
    repository,
    new LocalAssetIndex(),
    new LocalAssetPathService(userData),
    new QueuePicker([{
      sources: [{ sourcePath, originalFilename: 'source.png' }],
      scanLimitReached: false
    }]),
    immediateWorker,
    undefined,
    deletionFiles
  )
  await service.initialize()
  const begun = await service.beginImport({ sourceKind: 'files', rightsConfirmed: true })
  if (!begun.ok) throw new Error('begin failed')
  await service.waitForIdle()
  const staged = await service.getImportSession({ sessionId: begun.value.id })
  if (!staged.ok) throw new Error('scan failed')
  const itemId = staged.value.items[0].id
  expect(await service.updateImportDraft({
    sessionId: begun.value.id,
    itemId,
    displayName: '素材',
    tags: ['标签']
  })).toMatchObject({ ok: true })
  const finalized = await service.finalizeImport({
    sessionId: begun.value.id,
    itemIds: [itemId]
  })
  if (!finalized.ok) throw new Error('finalize failed')
  const listed = await service.list()
  if (!listed.ok) throw new Error('list failed')
  return { service, sourcePath, assetId: listed.value[0].id }
}

function faultingDeletionFiles(fault: {
  renameAt?: number
  unlinkAt?: number
  restoreAt?: number
}): LocalAssetDeletionFileOperations {
  let renameCount = 0
  let unlinkCount = 0
  let restoreCount = 0
  return {
    readFile,
    async rename(from, to) {
      renameCount += 1
      if (renameCount === fault.renameAt) throw new Error('injected rename failure')
      await rename(from, to)
    },
    async unlink(filePath) {
      unlinkCount += 1
      if (unlinkCount === fault.unlinkAt) throw new Error('injected unlink failure')
      await unlink(filePath)
    },
    async rm(filePath) { await rm(filePath, { force: true }) },
    async restore(filePath, data) {
      restoreCount += 1
      if (restoreCount === fault.restoreAt) throw new Error('injected restore failure')
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, data)
    }
  }
}

describe('F1 service review regressions', () => {
  it('maps picker permission failures into retryable typed results', async () => {
    const root = await temporaryDirectory()
    const userData = join(root, 'user-data')
    await mkdir(userData, { recursive: true })
    const permissionError = Object.assign(new Error('denied'), { code: 'EACCES' })
    const service = new LocalAssetService(
      new LocalAssetRepository(join(userData, 'emoji-pie.sqlite'), localAssetThumbnailUrl),
      new LocalAssetIndex(),
      new LocalAssetPathService(userData),
      new QueuePicker([permissionError]),
      immediateWorker
    )
    await service.initialize()
    try {
      expect(await service.beginImport({ sourceKind: 'directory', rightsConfirmed: true }))
        .toEqual({
          ok: false,
          error: {
            code: 'permission_denied',
            message: '没有权限读取所选文件或文件夹',
            retryable: true
          }
        })
    } finally {
      await service.dispose()
    }
  })

  it('joins an in-flight worker on cancel and leaves no staging or ready asset after restart', async () => {
    const root = await temporaryDirectory()
    const sourcePath = join(root, 'cancel.png')
    const userData = join(root, 'user-data')
    await Promise.all([writeFile(sourcePath, 'cancel bytes'), mkdir(userData, { recursive: true })])
    let releaseWorker: (() => void) | undefined
    let reportStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => { reportStarted = resolve })
    const release = new Promise<void>((resolve) => { releaseWorker = resolve })
    const worker: LocalAssetWorkerPool = {
      async process() {
        reportStarted?.()
        await release
        return workerResult
      },
      async renderPoster() { throw new Error('poster worker is unused') },
      async dispose() {}
    }
    const databasePath = join(userData, 'emoji-pie.sqlite')
    const paths = new LocalAssetPathService(userData)
    const service = new LocalAssetService(
      new LocalAssetRepository(databasePath, localAssetThumbnailUrl),
      new LocalAssetIndex(),
      paths,
      new QueuePicker([{
        sources: [{ sourcePath, originalFilename: 'cancel.png' }],
        scanLimitReached: false
      }]),
      worker
    )
    await service.initialize()
    const begun = await service.beginImport({ sourceKind: 'files', rightsConfirmed: true })
    if (!begun.ok) throw new Error('begin failed')
    await started
    const cancelledPromise = service.cancelImport({ sessionId: begun.value.id })
    releaseWorker?.()
    const cancelled = await cancelledPromise
    expect(cancelled).toMatchObject({
      ok: true,
      value: { state: 'cancelled', items: [{ state: 'cancelled' }] }
    })
    expect(await service.list()).toEqual({ ok: true, value: [] })
    await expect(access(join(paths.directory('staging'), begun.value.id))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await service.dispose()

    const restarted = new LocalAssetService(
      new LocalAssetRepository(databasePath, localAssetThumbnailUrl),
      new LocalAssetIndex(),
      paths,
      new QueuePicker([]),
      immediateWorker
    )
    await restarted.initialize()
    try {
      expect(await restarted.list()).toEqual({ ok: true, value: [] })
      await expect(access(join(paths.directory('staging'), begun.value.id))).rejects.toMatchObject({
        code: 'ENOENT'
      })
    } finally {
      await restarted.dispose()
    }
  })

  it.each([
    ['first rename', { renameAt: 1 }],
    ['second rename', { renameAt: 2 }],
    ['first unlink', { unlinkAt: 1 }],
    ['second unlink', { unlinkAt: 2 }],
    ['first restore after unlink', { unlinkAt: 1, restoreAt: 1 }]
  ] as const)('compensates a %s fault and lets a clean retry delete the asset', async (_name, fault) => {
    const root = await temporaryDirectory()
    const { service, sourcePath, assetId } = await createReadyAsset(
      root,
      faultingDeletionFiles(fault)
    )
    try {
      expect(await service.delete({ assetId })).toMatchObject({
        ok: false,
        error: { code: 'delete_failed', retryable: true }
      })
      expect(await service.list()).toMatchObject({ ok: true, value: [{ id: assetId }] })
      expect(await readFile(sourcePath, 'utf8')).toBe('source bytes')
      expect(await service.delete({ assetId })).toEqual({ ok: true, value: undefined })
      expect(await service.list()).toEqual({ ok: true, value: [] })
      expect(await readFile(sourcePath, 'utf8')).toBe('source bytes')
    } finally {
      await service.dispose()
    }
  })

  it('fails closed on junction-backed originals and thumbnails during recovery', async () => {
    for (const unsafeScope of ['originals', 'thumbnails'] as const) {
      const root = await temporaryDirectory()
      const userData = join(root, `user-data-${unsafeScope}`)
      const outside = join(root, `outside-${unsafeScope}`)
      const paths = new LocalAssetPathService(userData)
      await Promise.all([
        mkdir(paths.directory('staging'), { recursive: true }),
        mkdir(paths.directory('originals'), { recursive: true }),
        mkdir(paths.directory('thumbnails'), { recursive: true }),
        mkdir(outside, { recursive: true })
      ])
      await rm(paths.directory(unsafeScope), { recursive: true })
      await symlink(outside, paths.directory(unsafeScope), 'junction')
      const repository = new LocalAssetRepository(
        join(userData, 'emoji-pie.sqlite'),
        localAssetThumbnailUrl,
        () => NOW
      )
      const sessionId = randomUUID()
      const itemId = randomUUID()
      const assetId = randomUUID()
      const stagingRelativePath = paths.stagingRelativePath(sessionId, itemId, 'png')
      await mkdir(join(paths.directory('staging'), sessionId), { recursive: true })
      await writeFile(paths.resolveStagingItem(sessionId, itemId, stagingRelativePath), 'source')
      await writeFile(paths.stagingThumbnailPath(sessionId, itemId), 'thumbnail')
      repository.createImportSession(sessionId, 'files', NOW)
      repository.addImportItem({
        id: itemId,
        sessionId,
        originalFilename: 'unsafe.png',
        stagingRelativePath,
        displayName: '不安全素材'
      })
      repository.markItemStaged({
        itemId,
        mimeType: 'image/png',
        width: 1,
        height: 1,
        sizeBytes: 1,
        contentSha256: 'c'.repeat(64),
        pixelSha256: 'd'.repeat(64)
      })
      expect(repository.updateDraft({
        sessionId,
        itemId,
        displayName: '不安全素材',
        tags: ['恢复']
      })).toMatchObject({ ok: true })
      expect(repository.finalizeDraft({ sessionId, itemIds: [itemId] }))
        .toMatchObject({ ok: true, value: { finalizedItemIds: [itemId] } })
      const sourceRelativePath = paths.originalRelativePath(assetId, 'png')
      const thumbnailRelativePath = paths.thumbnailRelativePath(assetId)
      repository.prepareAssetCommit({
        itemId,
        assetId,
        sourceRelativePath,
        thumbnailRelativePath
      })
      const finalSource = paths.resolveAssetSource(assetId, sourceRelativePath)
      const finalThumbnail = paths.resolveAssetThumbnail(assetId, thumbnailRelativePath)
      await writeFile(finalSource, 'outside source')
      await writeFile(finalThumbnail, 'outside thumbnail')
      const outsideFile = unsafeScope === 'originals' ? finalSource : finalThumbnail

      const service = new LocalAssetService(
        repository,
        new LocalAssetIndex(),
        paths,
        new QueuePicker([]),
        immediateWorker
      )
      await service.initialize()
      try {
        expect(await service.list()).toEqual({ ok: true, value: [] })
        expect(await readFile(outsideFile, 'utf8')).toContain('outside')
        expect(repository.getImportItem(itemId)).toMatchObject({
          state: 'failed',
          error_code: 'recovery_failed'
        })
      } finally {
        await service.dispose()
      }
    }
  })
})
