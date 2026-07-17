import { createHash, randomUUID } from 'node:crypto'
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  statfs,
  unlink
} from 'node:fs/promises'
import { basename, dirname, extname } from 'node:path'
import {
  LOCAL_ASSET_LIMITS,
  type BeginLocalImportRequest,
  type CancelLocalImportRequest,
  type DeleteLocalAssetRequest,
  type FinalizeLocalImportRequest,
  type GetLocalImportSessionRequest,
  type LocalAssetDto,
  type LocalAssetErrorCode,
  type LocalAssetResult,
  type LocalImportFinalizeResultDto,
  type LocalImportItemDto,
  type LocalImportSessionDto,
  type RetryLocalImportItemsRequest,
  type UpdateLocalAssetMetadataRequest,
  type UpdateLocalImportDraftRequest
} from '../shared/local-assets'
import type { LocalAssetIpcService } from './local-asset-ipc'
import { LocalAssetIndex } from './local-asset-index'
import { LocalAssetPathService } from './local-asset-paths'
import type { LocalAssetPicker, LocalAssetSelectedSource } from './local-asset-picker'
import { LocalAssetRepository } from './local-asset-repository'
import {
  LocalAssetWorkerError,
  type LocalAssetWorkerPool
} from './local-asset-worker'

const COPY_BUFFER_BYTES = 64 * 1024

function failure<T>(
  code: LocalAssetErrorCode,
  message: string,
  retryable = false
): LocalAssetResult<T> {
  return { ok: false, error: { code, message, retryable } }
}

function errorCode(error: unknown): LocalAssetErrorCode {
  if (error instanceof LocalAssetWorkerError) return error.code
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String(error.code)
    if (code === 'EACCES' || code === 'EPERM') return 'permission_denied'
    if (code === 'ENOSPC') return 'insufficient_disk_space'
  }
  return 'import_failed'
}

function displayNameForFile(fileName: string): string {
  const stem = basename(fileName, extname(fileName)).normalize('NFKC').trim() || '未命名素材'
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  const graphemes = [...segmenter.segment(stem)]
  return graphemes.slice(0, LOCAL_ASSET_LIMITS.nameGraphemes)
    .map((part) => part.segment).join('')
}

function expectedMimeForExtension(extension: string): LocalAssetDto['mimeType'] | undefined {
  if (extension === '.png') return 'image/png'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.webp') return 'image/webp'
  return undefined
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const handle = await open(filePath, 'r')
    await handle.close()
    return true
  } catch {
    return false
  }
}

export class LocalAssetService implements LocalAssetIpcService {
  private readonly backgroundTasks = new Set<Promise<void>>()

  constructor(
    private readonly repository: LocalAssetRepository,
    private readonly index: LocalAssetIndex,
    private readonly paths: LocalAssetPathService,
    private readonly picker: LocalAssetPicker,
    private readonly workers: LocalAssetWorkerPool,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.paths.directory('staging'), { recursive: true }),
      mkdir(this.paths.directory('originals'), { recursive: true }),
      mkdir(this.paths.directory('thumbnails'), { recursive: true })
    ])
    await this.reconcileCommittingAssets()
    this.index.replace(this.repository.list())
  }

  async list(): Promise<LocalAssetResult<LocalAssetDto[]>> {
    return { ok: true, value: this.repository.list() }
  }

  async beginImport(
    request: BeginLocalImportRequest
  ): Promise<LocalAssetResult<LocalImportSessionDto>> {
    const selection = await this.picker.select(request.sourceKind)
    if (!selection) return failure('cancelled', '已取消选择')
    if (selection.scanLimitReached) {
      return failure('scan_limit_reached', '文件夹超过 5000 项，请拆分后重试')
    }
    if (selection.sources.length === 0) {
      return failure('unsupported_entry', '没有找到可导入的 PNG、JPEG 或 WebP 图片')
    }
    const remainingCapacity = LOCAL_ASSET_LIMITS.maxReadyAssets - this.repository.countReady()
    if (remainingCapacity < 1) {
      return failure('library_capacity_reached', '本地素材库已达到 500 张上限')
    }
    if (selection.sources.length > remainingCapacity) {
      return failure(
        'library_capacity_reached',
        `当前最多还能导入 ${remainingCapacity} 张，请减少选择数量`
      )
    }

    const sessionId = randomUUID()
    const rightsAssertedAt = this.now()
    this.repository.createImportSession(sessionId, request.sourceKind, rightsAssertedAt)
    const jobs: Array<{ itemId: string; source: LocalAssetSelectedSource }> = []
    for (const source of selection.sources) {
      const itemId = source.itemId ?? randomUUID()
      const extension = extname(source.originalFilename).toLowerCase()
      const stagingRelativePath = this.paths.stagingRelativePath(sessionId, itemId, extension)
      this.repository.addImportItem({
        id: itemId,
        sessionId,
        originalFilename: basename(source.originalFilename),
        stagingRelativePath,
        displayName: displayNameForFile(source.originalFilename)
      })
      jobs.push({ itemId, source })
    }
    this.trackBackground(this.processInitialSelection(jobs))
    return this.repository.getSession(sessionId)
  }

  async getImportSession(
    request: GetLocalImportSessionRequest
  ): Promise<LocalAssetResult<LocalImportSessionDto>> {
    return this.repository.getSession(request.sessionId)
  }

  async retryImportItems(
    request: RetryLocalImportItemsRequest
  ): Promise<LocalAssetResult<LocalImportSessionDto>> {
    const retried = this.repository.retryFailed(request)
    if (!retried.ok) return retried
    this.repository.markProcessing(request.itemIds)
    this.trackBackground(this.processExistingItems(request.itemIds))
    return this.repository.getSession(request.sessionId)
  }

  async cancelImport(
    request: CancelLocalImportRequest
  ): Promise<LocalAssetResult<LocalImportSessionDto>> {
    const result = this.repository.cancel(request.sessionId)
    if (!result.ok) return result
    await rm(dirname(this.paths.stagingThumbnailPath(request.sessionId, randomUUID())), {
      recursive: true,
      force: true
    })
    return result
  }

  async updateImportDraft(
    request: UpdateLocalImportDraftRequest
  ): Promise<LocalAssetResult<LocalImportItemDto>> {
    return this.repository.updateDraft(request)
  }

  async finalizeImport(
    request: FinalizeLocalImportRequest
  ): Promise<LocalAssetResult<LocalImportFinalizeResultDto>> {
    const draftResult = this.repository.finalizeDraft(request)
    if (!draftResult.ok) return draftResult
    const finalizedItemIds: string[] = []
    const rejectedItems = [...draftResult.value.rejectedItems]
    for (const itemId of draftResult.value.finalizedItemIds) {
      try {
        const asset = await this.commitItem(request.sessionId, itemId)
        this.index.upsert(asset)
        finalizedItemIds.push(itemId)
      } catch (error) {
        const code = errorCode(error)
        rejectedItems.push({
          itemId,
          error: {
            code,
            message: error instanceof Error ? error.message : '素材入库失败',
            retryable: true
          }
        })
      }
    }
    const session = this.repository.getSession(request.sessionId)
    if (!session.ok) return session
    return { ok: true, value: { session: session.value, finalizedItemIds, rejectedItems } }
  }

  async updateMetadata(
    request: UpdateLocalAssetMetadataRequest
  ): Promise<LocalAssetResult<LocalAssetDto>> {
    const result = this.repository.updateMetadata(request)
    if (result.ok) this.index.upsert(result.value)
    return result
  }

  async delete(request: DeleteLocalAssetRequest): Promise<LocalAssetResult<void>> {
    const asset = this.repository.getStoredAsset(request.assetId)
    if (!asset || asset.state !== 'ready') return failure('asset_not_found', '找不到本地素材')
    try {
      const sourcePath = await this.paths.assertOwnedRegularFile(asset.sourceRelativePath, {
        scope: 'originals', assetId: asset.id
      })
      const thumbnailPath = await this.paths.assertOwnedRegularFile(asset.thumbnailRelativePath, {
        scope: 'thumbnails', assetId: asset.id
      })
      const [sourceBackup, thumbnailBackup] = await Promise.all([
        readFile(sourcePath),
        readFile(thumbnailPath)
      ])
      const sourceTrash = this.paths.deletionStagingPath(asset.id, 'source')
      const thumbnailTrash = this.paths.deletionStagingPath(asset.id, 'thumbnail')
      await mkdir(dirname(sourceTrash), { recursive: true })
      await rename(sourcePath, sourceTrash)
      try {
        await rename(thumbnailPath, thumbnailTrash)
      } catch (error) {
        await rename(sourceTrash, sourcePath)
        throw error
      }
      if (!this.repository.deleteAssetRecord(asset.id)) {
        await Promise.all([rename(sourceTrash, sourcePath), rename(thumbnailTrash, thumbnailPath)])
        return failure('delete_failed', '素材记录删除失败', true)
      }
      try {
        await Promise.all([unlink(sourceTrash), unlink(thumbnailTrash)])
      } catch {
        await Promise.all([
          this.restoreFile(sourcePath, sourceBackup),
          this.restoreFile(thumbnailPath, thumbnailBackup)
        ])
        this.repository.restoreAsset(asset)
        this.index.upsert(asset)
        return failure('delete_failed', '素材文件删除失败，已恢复素材', true)
      }
      this.index.remove(asset.id)
      return { ok: true, value: undefined }
    } catch (error) {
      return failure(
        'delete_failed',
        error instanceof Error ? error.message : '素材删除失败',
        true
      )
    }
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([...this.backgroundTasks])
  }

  async dispose(): Promise<void> {
    await this.waitForIdle()
    await this.workers.dispose()
    this.repository.close()
  }

  private trackBackground(task: Promise<void>): void {
    this.backgroundTasks.add(task)
    void task.finally(() => this.backgroundTasks.delete(task))
  }

  private async processInitialSelection(
    jobs: Array<{ itemId: string; source: LocalAssetSelectedSource }>
  ): Promise<void> {
    await this.runBounded(jobs, async ({ itemId, source }) => {
      await this.processItem(itemId, source.sourcePath)
    })
  }

  private async processExistingItems(itemIds: readonly string[]): Promise<void> {
    await this.runBounded([...itemIds], async (itemId) => this.processItem(itemId))
  }

  private async runBounded<T>(items: T[], operation: (item: T) => Promise<void>): Promise<void> {
    let nextIndex = 0
    const run = async (): Promise<void> => {
      while (nextIndex < items.length) {
        const item = items[nextIndex]
        nextIndex += 1
        await operation(item)
      }
    }
    await Promise.all([run(), run()])
  }

  private async processItem(itemId: string, sourcePath?: string): Promise<void> {
    const item = this.repository.getImportItem(itemId)
    if (!item || item.state !== 'processing' || !item.staging_rel_path) return
    const stagingPath = this.paths.resolveStagingItem(item.session_id, item.id, item.staging_rel_path)
    try {
      let contentSha256: string
      let sizeBytes: number
      if (sourcePath) {
        const copied = await this.copySourceToStaging(sourcePath, stagingPath)
        contentSha256 = copied.contentSha256
        sizeBytes = copied.sizeBytes
      } else {
        const staged = await this.hashExistingStaging(stagingPath)
        contentSha256 = staged.contentSha256
        sizeBytes = staged.sizeBytes
      }

      this.repository.setProcessingContentHash(item.id, contentSha256)
      const contentDuplicate = this.repository.findReadyDuplicate(contentSha256) ??
        (this.repository.hasImportDuplicate(item.id, contentSha256)
          ? { code: 'duplicate_content' as const, assetId: undefined }
          : undefined)
      if (contentDuplicate) {
        await rm(stagingPath, { force: true })
        this.repository.markItemDuplicate(
          item.id,
          contentDuplicate.code,
          contentDuplicate.assetId,
          { contentSha256 }
        )
        return
      }

      const processed = await this.workers.process(stagingPath)
      const expectedMime = expectedMimeForExtension(extname(item.original_filename).toLowerCase())
      if (!expectedMime || processed.mimeType !== expectedMime) {
        throw new LocalAssetWorkerError('unsupported_type', '图片内容与文件扩展名不一致')
      }
      this.repository.setProcessingPixelHash(item.id, processed.pixelSha256)
      const pixelDuplicate = this.repository.findReadyDuplicate(
        contentSha256,
        processed.pixelSha256
      ) ?? (this.repository.hasImportDuplicate(item.id, contentSha256, processed.pixelSha256)
        ? { code: 'duplicate_pixels' as const, assetId: undefined }
        : undefined)
      if (pixelDuplicate) {
        await rm(stagingPath, { force: true })
        this.repository.markItemDuplicate(
          item.id,
          pixelDuplicate.code,
          pixelDuplicate.assetId,
          { contentSha256, pixelSha256: processed.pixelSha256 }
        )
        return
      }
      await this.writeThumbnail(
        this.paths.stagingThumbnailPath(item.session_id, item.id),
        processed.thumbnail
      )
      this.repository.markItemStaged({
        itemId: item.id,
        mimeType: processed.mimeType,
        width: processed.width,
        height: processed.height,
        sizeBytes,
        contentSha256,
        pixelSha256: processed.pixelSha256
      })
    } catch (error) {
      this.repository.markItemFailed(item.id, errorCode(error))
    }
  }

  private async copySourceToStaging(
    sourcePath: string,
    stagingPath: string
  ): Promise<{ contentSha256: string; sizeBytes: number }> {
    const sourceHandle = await open(sourcePath, 'r')
    let destinationHandle: Awaited<ReturnType<typeof open>> | undefined
    try {
      const sourceStat = await sourceHandle.stat()
      if (!sourceStat.isFile()) throw new LocalAssetWorkerError('unsupported_entry', '仅支持普通文件')
      if (sourceStat.size < 1) throw new LocalAssetWorkerError('invalid_image', '图片文件为空')
      if (sourceStat.size > LOCAL_ASSET_LIMITS.maxFileBytes) {
        throw new LocalAssetWorkerError('file_too_large', '图片超过 20 MiB')
      }
      await this.assertDiskSpace(sourceStat.size)
      await mkdir(dirname(stagingPath), { recursive: true })
      await rm(stagingPath, { force: true })
      destinationHandle = await open(stagingPath, 'wx')
      const hash = createHash('sha256')
      const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES)
      let offset = 0
      while (offset < sourceStat.size) {
        const { bytesRead } = await sourceHandle.read(
          buffer,
          0,
          Math.min(buffer.length, sourceStat.size - offset),
          offset
        )
        if (bytesRead === 0) break
        offset += bytesRead
        if (offset > LOCAL_ASSET_LIMITS.maxFileBytes) {
          throw new LocalAssetWorkerError('file_too_large', '图片超过 20 MiB')
        }
        hash.update(buffer.subarray(0, bytesRead))
        await destinationHandle.write(buffer, 0, bytesRead)
      }
      if (offset !== sourceStat.size) throw new Error('读取图片时文件发生变化')
      await destinationHandle.sync()
      return { contentSha256: hash.digest('hex'), sizeBytes: offset }
    } finally {
      await destinationHandle?.close()
      await sourceHandle.close()
    }
  }

  private async hashExistingStaging(
    stagingPath: string
  ): Promise<{ contentSha256: string; sizeBytes: number }> {
    const handle = await open(stagingPath, 'r')
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size < 1 || stat.size > LOCAL_ASSET_LIMITS.maxFileBytes) {
        throw new LocalAssetWorkerError('staging_unavailable', '导入暂存文件不可用')
      }
      const hash = createHash('sha256')
      const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES)
      let offset = 0
      while (offset < stat.size) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
        if (bytesRead === 0) break
        offset += bytesRead
        hash.update(buffer.subarray(0, bytesRead))
      }
      return { contentSha256: hash.digest('hex'), sizeBytes: offset }
    } finally {
      await handle.close()
    }
  }

  private async assertDiskSpace(fileBytes: number): Promise<void> {
    const stats = await statfs(this.paths.rootDirectory)
    const availableBytes = stats.bavail * stats.bsize
    const requiredBytes = fileBytes * 2 + LOCAL_ASSET_LIMITS.reservedDiskBytes
    if (availableBytes < requiredBytes) {
      throw new LocalAssetWorkerError('insufficient_disk_space', '磁盘剩余空间不足')
    }
  }

  private async writeThumbnail(filePath: string, thumbnail: Buffer): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true })
    const handle = await open(filePath, 'w')
    try {
      await handle.writeFile(thumbnail)
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  private async commitItem(sessionId: string, itemId: string): Promise<LocalAssetDto> {
    const item = this.repository.getImportItem(itemId)
    if (!item || item.session_id !== sessionId || item.state !== 'committing' ||
      !item.staging_rel_path) {
      throw new Error('导入条目不可提交')
    }
    const assetId = randomUUID()
    const extension = extname(item.staging_rel_path).slice(1)
    const sourceRelativePath = this.paths.originalRelativePath(assetId, extension)
    const thumbnailRelativePath = this.paths.thumbnailRelativePath(assetId)
    const stagingSource = this.paths.resolveStagingItem(sessionId, itemId, item.staging_rel_path)
    const stagingThumbnail = this.paths.stagingThumbnailPath(sessionId, itemId)
    const finalSource = this.paths.resolveAssetSource(assetId, sourceRelativePath)
    const finalThumbnail = this.paths.resolveAssetThumbnail(assetId, thumbnailRelativePath)
    this.repository.prepareAssetCommit({
      itemId,
      assetId,
      sourceRelativePath,
      thumbnailRelativePath
    })
    let sourceMoved = false
    let thumbnailMoved = false
    try {
      await rename(stagingSource, finalSource)
      sourceMoved = true
      await rename(stagingThumbnail, finalThumbnail)
      thumbnailMoved = true
      return this.repository.finishAssetCommit(assetId, itemId)
    } catch (error) {
      if (thumbnailMoved) await rename(finalThumbnail, stagingThumbnail).catch(() => undefined)
      if (sourceMoved) await rename(finalSource, stagingSource).catch(() => undefined)
      const code = errorCode(error) === 'import_failed' ? 'write_failed' : errorCode(error)
      this.repository.rollbackAssetCommit(assetId, itemId, code)
      throw error
    }
  }

  private async reconcileCommittingAssets(): Promise<void> {
    for (const asset of this.repository.listStored('committing')) {
      const finalSource = this.paths.resolveAssetSource(asset.id, asset.sourceRelativePath)
      const finalThumbnail = this.paths.resolveAssetThumbnail(asset.id, asset.thumbnailRelativePath)
      const item = this.repository.findImportItemByAssetId(asset.id)
      const sourceExists = await fileExists(finalSource)
      const thumbnailExists = await fileExists(finalThumbnail)
      if (sourceExists && thumbnailExists && item) {
        this.repository.finishAssetCommit(asset.id, item.id)
        continue
      }
      if (item?.staging_rel_path) {
        const stagingSource = this.paths.resolveStagingItem(
          item.session_id,
          item.id,
          item.staging_rel_path
        )
        const stagingThumbnail = this.paths.stagingThumbnailPath(item.session_id, item.id)
        if (sourceExists && !(await fileExists(stagingSource))) {
          await mkdir(dirname(stagingSource), { recursive: true })
          await rename(finalSource, stagingSource)
        }
        if (thumbnailExists && !(await fileExists(stagingThumbnail))) {
          await mkdir(dirname(stagingThumbnail), { recursive: true })
          await rename(finalThumbnail, stagingThumbnail)
        }
      } else {
        await Promise.all([rm(finalSource, { force: true }), rm(finalThumbnail, { force: true })])
      }
      this.repository.rollbackAssetCommit(asset.id, item?.id ?? asset.id, 'recovery_failed')
    }
  }

  private async restoreFile(filePath: string, data: Buffer): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true })
    const handle = await open(filePath, 'w')
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
}
