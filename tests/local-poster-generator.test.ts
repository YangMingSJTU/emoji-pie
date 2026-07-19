import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalAssetIndex } from '../src/main/local-asset-index'
import { LocalAssetPathService } from '../src/main/local-asset-paths'
import { localAssetThumbnailUrl } from '../src/main/local-asset-protocol'
import { LocalAssetRepository, type StoredLocalAsset } from '../src/main/local-asset-repository'
import { LocalPosterGenerator } from '../src/main/local-poster-generator'
import type {
  LocalAssetWorkerPool,
  LocalPosterWorkerRequest
} from '../src/main/local-asset-worker'
import { LocalAssetWorkerError } from '../src/main/local-asset-worker'

const temporaryDirectories: string[] = []
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'emoji-pie-poster-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
})

function assetId(index: number): string {
  return `123e4567-e89b-42d3-a456-${index.toString(16).padStart(12, '0')}`
}

async function createFixture(count: number): Promise<{
  repository: LocalAssetRepository
  index: LocalAssetIndex
  paths: LocalAssetPathService
  assets: StoredLocalAsset[]
}> {
  const directory = await temporaryDirectory()
  const userData = join(directory, 'user-data')
  const paths = new LocalAssetPathService(userData)
  await Promise.all([
    mkdir(paths.directory('originals'), { recursive: true }),
    mkdir(paths.directory('thumbnails'), { recursive: true })
  ])
  const repository = new LocalAssetRepository(
    join(userData, 'emoji-pie.sqlite'),
    localAssetThumbnailUrl,
    () => '2026-07-17T06:00:00.000Z'
  )
  const assets: StoredLocalAsset[] = []
  for (let index = 1; index <= count; index += 1) {
    const id = assetId(index)
    const sourceRelativePath = paths.originalRelativePath(id, 'png')
    const thumbnailRelativePath = paths.thumbnailRelativePath(id)
    await Promise.all([
      writeFile(paths.resolve(sourceRelativePath), Buffer.from(`source-${index}`)),
      writeFile(paths.resolve(thumbnailRelativePath), Buffer.from(`thumbnail-${index}`))
    ])
    const asset: StoredLocalAsset = {
      id,
      source: 'user',
      contentState: 'ready',
      canEdit: true,
      canDelete: true,
      displayName: `加班素材 ${index}`,
      originalFilename: `${index}.png`,
      mimeType: 'image/png',
      width: 80,
      height: 60,
      sizeBytes: 64,
      tags: [{ displayValue: '加班', normalizedValue: '加班' }],
      thumbnailUrl: localAssetThumbnailUrl(id),
      rightsAssertedAt: '2026-07-17T06:00:00.000Z',
      importedAt: `2026-07-17T06:${index.toString().padStart(2, '0')}:00.000Z`,
      updatedAt: '2026-07-17T06:00:00.000Z',
      contentSha256: index.toString(16).padStart(64, '0'),
      pixelSha256: (index + 100).toString(16).padStart(64, '0'),
      sourceRelativePath,
      thumbnailRelativePath,
      state: 'ready'
    }
    repository.restoreAsset(asset)
    assets.push(asset)
  }
  const localIndex = new LocalAssetIndex()
  localIndex.replace(repository.list())
  return { repository, index: localIndex, paths, assets }
}

function workers(
  render = vi.fn(async (request: LocalPosterWorkerRequest) => { void request; return { png: PNG } })
): LocalAssetWorkerPool {
  return {
    async process() { throw new Error('inspect is unused') },
    renderPoster: render,
    async dispose() {}
  }
}

describe('LocalPosterGenerator', () => {
  it('creates deterministic automatic batches and excludes every previously shown asset', async () => {
    const fixture = await createFixture(10)
    const render = vi.fn(async (request: LocalPosterWorkerRequest) => { void request; return { png: PNG } })
    const generator = new LocalPosterGenerator(
      fixture.repository,
      fixture.index,
      fixture.paths,
      workers(render)
    )
    try {
      const first = await generator.generate({
        prompt: '今天又要加班',
        caption: '又加班',
        embedCaption: true,
        matchMode: 'automatic',
        selectedAssetIds: [],
        excludedAssetIds: []
      })
      expect(first).toMatchObject({ ok: true, value: { totalReadyAssets: 10 } })
      if (!first.ok) throw new Error('first batch failed')
      expect(first.value.candidates).toHaveLength(9)
      expect(new Set(first.value.candidates.map(({ assetId }) => assetId)).size).toBe(9)
      expect(first.value.candidates.every(({ dataUrl }) =>
        dataUrl.startsWith('data:image/png;base64,')
      )).toBe(true)

      const shown = first.value.candidates.map(({ assetId }) => assetId)
      const second = await generator.generate({
        prompt: '今天又要加班',
        caption: '又加班',
        embedCaption: true,
        matchMode: 'automatic',
        selectedAssetIds: [],
        excludedAssetIds: shown
      })
      expect(second).toMatchObject({
        ok: true,
        value: { candidates: [{ matchedTags: ['加班'] }], shortageReason: 'matching' }
      })
      if (!second.ok) throw new Error('second batch failed')
      expect(shown).not.toContain(second.value.candidates[0].assetId)

      const exhausted = await generator.generate({
        prompt: '今天又要加班',
        caption: '又加班',
        embedCaption: true,
        matchMode: 'automatic',
        selectedAssetIds: [],
        excludedAssetIds: [...shown, second.value.candidates[0].assetId]
      })
      expect(exhausted).toEqual({
        ok: true,
        value: { candidates: [], totalReadyAssets: 10, shortageReason: 'no_more' }
      })
      expect(render).toHaveBeenCalledTimes(10)
    } finally {
      fixture.repository.close()
    }
  })

  it('preserves manual order and fails closed when a selected asset was deleted', async () => {
    const fixture = await createFixture(3)
    const render = vi.fn(async (request: LocalPosterWorkerRequest) => { void request; return { png: PNG } })
    const generator = new LocalPosterGenerator(
      fixture.repository,
      fixture.index,
      fixture.paths,
      workers(render)
    )
    try {
      const selectedAssetIds = [fixture.assets[2].id, fixture.assets[0].id]
      const generated = await generator.generate({
        prompt: '加班',
        caption: '不加字',
        embedCaption: false,
        matchMode: 'manual',
        selectedAssetIds,
        excludedAssetIds: []
      })
      expect(generated).toMatchObject({
        ok: true,
        value: {
          candidates: [
            { assetId: selectedAssetIds[0], assetNameSnapshot: '加班素材 3' },
            { assetId: selectedAssetIds[1], assetNameSnapshot: '加班素材 1' }
          ]
        }
      })
      expect(render.mock.calls.map(([request]) => request.embedCaption)).toEqual([false, false])

      fixture.repository.deleteAssetRecord(selectedAssetIds[0])
      expect(await generator.generate({
        prompt: '加班',
        caption: '加班',
        embedCaption: true,
        matchMode: 'manual',
        selectedAssetIds,
        excludedAssetIds: []
      })).toMatchObject({ ok: false, error: { code: 'asset_not_ready' } })
    } finally {
      fixture.repository.close()
    }
  })

  it('allows only one active batch', async () => {
    const fixture = await createFixture(1)
    let release: (() => void) | undefined
    const waiting = new Promise<void>((resolve) => { release = resolve })
    const generator = new LocalPosterGenerator(
      fixture.repository,
      fixture.index,
      fixture.paths,
      workers(vi.fn(async () => {
        await waiting
        return { png: PNG }
      }))
    )
    const request = {
      prompt: '加班', caption: '加班', embedCaption: true,
      matchMode: 'manual' as const,
      selectedAssetIds: [fixture.assets[0].id], excludedAssetIds: []
    }
    try {
      const first = generator.generate(request)
      await vi.waitFor(() => expect((generator as unknown as { active: boolean }).active).toBe(true))
      expect(await generator.generate(request)).toMatchObject({
        ok: false, error: { code: 'generation_busy', retryable: true }
      })
      release?.()
      expect(await first).toMatchObject({ ok: true })
    } finally {
      release?.()
      fixture.repository.close()
    }
  })

  it('keeps the global gate until a failed batch drains and then accepts the next batch', async () => {
    const fixture = await createFixture(3)
    let releasePending: (() => void) | undefined
    let reportAllStarted: (() => void) | undefined
    const pending = new Promise<void>((resolve) => { releasePending = resolve })
    const allStarted = new Promise<void>((resolve) => { reportAllStarted = resolve })
    let invocation = 0
    const render = vi.fn(async () => {
      const current = invocation
      invocation += 1
      if (invocation === 3) reportAllStarted?.()
      if (current === 0) {
        throw new LocalAssetWorkerError('generation_failed', 'first poster failed')
      }
      if (current < 3) await pending
      return { png: PNG }
    })
    const generator = new LocalPosterGenerator(
      fixture.repository,
      fixture.index,
      fixture.paths,
      workers(render)
    )
    const request = {
      prompt: 'busy', caption: 'busy', embedCaption: true,
      matchMode: 'manual' as const,
      selectedAssetIds: fixture.assets.map(({ id }) => id), excludedAssetIds: []
    }
    try {
      const failedBatch = generator.generate(request)
      await allStarted
      expect(await generator.generate(request)).toMatchObject({
        ok: false, error: { code: 'generation_busy', retryable: true }
      })
      releasePending?.()
      expect(await failedBatch).toMatchObject({
        ok: false, error: { code: 'generation_failed', retryable: true }
      })
      expect(await generator.generate(request)).toMatchObject({
        ok: true, value: { candidates: [{}, {}, {}] }
      })
      expect(render).toHaveBeenCalledTimes(6)
    } finally {
      releasePending?.()
      fixture.repository.close()
    }
  })
})
