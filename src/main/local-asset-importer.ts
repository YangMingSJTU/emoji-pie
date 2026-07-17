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
  LOCAL_ASSET_ERROR_CODES,
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
import {
  LocalAssetPathService,
  type LocalAssetPathOwner
} from './local-asset-paths'
import type { LocalAssetPicker, LocalAssetSelectedSource } from './local-asset-picker'
import {
  LocalAssetRepository,
  LocalAssetRepositoryError,
  type StoredLocalImportItem
} from './local-asset-repository'
import {
  LocalAssetWorkerError,
  type LocalAssetWorkerPool
} from './local-asset-worker'

const COPY_BUFFER_BYTES = 64 * 1024
const LOCAL_ASSET_ERROR_CODE_SET = new Set<string>(LOCAL_ASSET_ERROR_CODES)

export interface LocalAssetDeletionFileOperations {
  readFile: (filePath: string) => Promise<Buffer>
  rename: (from: string, to: string) => Promise<void>
  unlink: (filePath: string) => Promise<void>
  rm: (filePath: string) => Promise<void>
  restore: (filePath: string, data: Buffer) => Promise<void>
}

function failure<T>(
  code: LocalAssetErrorCode,
  message: string,
  retryable = false
): LocalAssetResult<T> {
  return { ok: false, error: { code, message, retryable } }
}

function errorCode(error: unknown): LocalAssetErrorCode {
  if (error instanceof LocalAssetWorkerError || error instanceof LocalAssetRepositoryError) {
    return error.code
  }
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String(error.code)
    if (LOCAL_ASSET_ERROR_CODE_SET.has(code)) return code as LocalAssetErrorCode
    if (code === 'EACCES' || code === 'EPERM') return 'permission_denied'
    if (code === 'ENOSPC') return 'insufficient_disk_space'
  }
  return 'import_failed'
}

export function deriveLocalAssetDisplayName(fileName: string): string {
  return basename(fileName, extname(fileName)).normalize('NFKC').trim() || '未命名素材'
}

function expectedMimeForExtension(extension: string): LocalAssetDto['mimeType'] | undefined {
  if (extension === '.png') return 'image/png'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.webp') return 'image/webp'
  return undefined
}

async function durableRestoreFile(filePath: string, data: Buffer): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const handle = await open(filePath, 'w')
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const DEFAULT_DELETION_FILE_OPERATIONS: LocalAssetDeletionFileOperations = {
  readFile,
  rename,
  unlink,
  async rm(filePath) { await rm(filePath, { force: true }) },
  restore: durableRestoreFile
}

export class LocalAssetService implements LocalAssetIpcService {
  private readonly backgroundTasks = new Set<Promise<void>>()
  private readonly sessionTasks = new Map<string, Set<Promise<void>>>()
  private readonly abortedSessions = new Set<string>()

  constructor(
    private readonly repository: LocalAssetRepository,
    private readonly index: LocalAssetIndex,
    private readonly paths: LocalAssetPathService,
    private readonly picker: LocalAssetPicker,
    private readonly workers: LocalAssetWorkerPool,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly deletionFiles = DEFAULT_DELETION_FILE_OPERATIONS
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
    let selection: Awaited<ReturnType<LocalAssetPicker['select']>>
    try {
      selection = await this.picker.select(request.sourceKind)
    } catch (error) {
      const code = errorCode(error)
      return failure(
        code,
        code === 'permission_denied'
          ? '没有权限读取所选文件或文件夹'
          : error instanceof Error ? error.message : '无法读取所选图片',
        code === 'permission_denied' || code === 'read_failed'
      )
    }
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
        displayName: deriveLocalAssetDisplayName(source.originalFilename)
      })
      jobs.push({ itemId, source })
    }
    this.trackBackground(sessionId, this.processInitialSelection(jobs))
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
    this.abortedSessions.delete(request.sessionId)
    this.trackBackground(request.sessionId, this.processExistingItems(request.itemIds))
    return this.repository.getSession(request.sessionId)
  }

  async cancelImport(
    request: CancelLocalImportRequest
  ): Promise<LocalAssetResult<LocalImportSessionDto>> {
    this.abortedSessions.add(request.sessionId)
    const result = this.repository.cancel(request.sessionId)
    if (!result.ok) {
      this.abortedSessions.delete(request.sessionId)
      return result
    }
    await this.waitForSession(request.sessionId)
    await rm(dirname(this.paths.stagingThumbnailPath(request.sessionId, randomUUID())), {
      recursive: true,
      force: true
    })
    const cancelledSession = this.repository.getSession(request.sessionId)
    this.abortedSessions.delete(request.sessionId)
    return cancelledSession
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
        this.repository.markItemFailed(itemId, code)
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
    let sourcePath: string | undefined
    let thumbnailPath: string | undefined
    let sourceTrash: string | undefined
    let thumbnailTrash: string | undefined
    let sourceBackup: Buffer | undefined
    let thumbnailBackup: Buffer | undefined
    try {
      sourcePath = await this.paths.assertOwnedRegularFile(asset.sourceRelativePath, {
        scope: 'originals', assetId: asset.id
      })
      thumbnailPath = await this.paths.assertOwnedRegularFile(asset.thumbnailRelativePath, {
        scope: 'thumbnails', assetId: asset.id
      })
      ;[sourceBackup, thumbnailBackup] = await Promise.all([
        this.deletionFiles.readFile(sourcePath),
        this.deletionFiles.readFile(thumbnailPath)
      ])
      const operationId = randomUUID()
      sourceTrash = this.paths.deletionStagingPath(asset.id, operationId, 'source')
      thumbnailTrash = this.paths.deletionStagingPath(asset.id, operationId, 'thumbnail')
      await mkdir(dirname(sourceTrash), { recursive: true })
      await this.deletionFiles.rename(sourcePath, sourceTrash)
      await this.deletionFiles.rename(thumbnailPath, thumbnailTrash)
      await this.deletionFiles.unlink(sourceTrash)
      await this.deletionFiles.unlink(thumbnailTrash)
      if (!this.repository.deleteAssetRecord(asset.id)) {
        throw new LocalAssetRepositoryError('delete_failed', '素材记录删除失败')
      }
      this.index.remove(asset.id)
      return { ok: true, value: undefined }
    } catch (error) {
      if (sourcePath && thumbnailPath && sourceBackup && thumbnailBackup) {
        try {
          await this.recoverDeletion(
            sourcePath,
            thumbnailPath,
            sourceBackup,
            thumbnailBackup,
            sourceTrash,
            thumbnailTrash
          )
          this.index.upsert(asset)
        } catch (recoveryError) {
          return failure(
            'delete_failed',
            `素材删除失败且恢复失败：${recoveryError instanceof Error ? recoveryError.message : '未知错误'}`,
            true
          )
        }
      }
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

  private trackBackground(sessionId: string, task: Promise<void>): void {
    this.backgroundTasks.add(task)
    const tasks = this.sessionTasks.get(sessionId) ?? new Set<Promise<void>>()
    tasks.add(task)
    this.sessionTasks.set(sessionId, tasks)
    void task.finally(() => {
      this.backgroundTasks.delete(task)
      tasks.delete(task)
      if (tasks.size === 0) this.sessionTasks.delete(sessionId)
    })
  }

  private async waitForSession(sessionId: string): Promise<void> {
    await Promise.all([...(this.sessionTasks.get(sessionId) ?? [])])
  }

  private assertSessionActive(sessionId: string): void {
    if (this.abortedSessions.has(sessionId)) {
      throw new LocalAssetWorkerError('cancelled', '导入已取消')
    }
  }

  private isSessionAborted(sessionId: string): boolean {
    return this.abortedSessions.has(sessionId)
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
    const stagingThumbnail = this.paths.stagingThumbnailPath(item.session_id, item.id)
    try {
      this.assertSessionActive(item.session_id)
      let contentSha256: string
      let sizeBytes: number
      if (sourcePath) {
        const copied = await this.copySourceToStaging(item.session_id, sourcePath, stagingPath)
        contentSha256 = copied.contentSha256
        sizeBytes = copied.sizeBytes
      } else {
        const staged = await this.hashExistingStaging(item)
        contentSha256 = staged.contentSha256
        sizeBytes = staged.sizeBytes
      }

      this.assertSessionActive(item.session_id)
      this.repository.setProcessingContentHash(item.id, contentSha256)
      const contentDuplicate = this.repository.findReadyDuplicate(contentSha256) ??
        (this.repository.hasImportDuplicate(item.id, contentSha256)
          ? { code: 'duplicate_content' as const, assetId: undefined }
          : undefined)
      if (contentDuplicate) {
        await rm(stagingPath, { force: true })
        this.assertSessionActive(item.session_id)
        this.repository.markItemDuplicate(
          item.id,
          contentDuplicate.code,
          contentDuplicate.assetId,
          { contentSha256 }
        )
        return
      }

      const processed = await this.workers.process(stagingPath)
      this.assertSessionActive(item.session_id)
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
        this.assertSessionActive(item.session_id)
        this.repository.markItemDuplicate(
          item.id,
          pixelDuplicate.code,
          pixelDuplicate.assetId,
          { contentSha256, pixelSha256: processed.pixelSha256 }
        )
        return
      }
      this.assertSessionActive(item.session_id)
      await this.writeThumbnail(stagingThumbnail, processed.thumbnail)
      this.assertSessionActive(item.session_id)
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
      if (!this.isSessionAborted(item.session_id)) {
        this.repository.markItemFailed(item.id, errorCode(error))
      }
    } finally {
      if (this.isSessionAborted(item.session_id)) {
        await Promise.all([rm(stagingPath, { force: true }), rm(stagingThumbnail, { force: true })])
      }
    }
  }

  private async copySourceToStaging(
    sessionId: string,
    sourcePath: string,
    stagingPath: string
  ): Promise<{ contentSha256: string; sizeBytes: number }> {
    const sourceHandle = await open(sourcePath, 'r')
    let destinationHandle: Awaited<ReturnType<typeof open>> | undefined
    try {
      this.assertSessionActive(sessionId)
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
        this.assertSessionActive(sessionId)
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
      this.assertSessionActive(sessionId)
      return { contentSha256: hash.digest('hex'), sizeBytes: offset }
    } finally {
      await destinationHandle?.close()
      await sourceHandle.close()
    }
  }

  private async hashExistingStaging(
    item: StoredLocalImportItem
  ): Promise<{ contentSha256: string; sizeBytes: number }> {
    const canonicalStaging = await this.paths.assertOwnedRegularFile(item.staging_rel_path!, {
      scope: 'staging', sessionId: item.session_id, itemId: item.id
    })
    const handle = await open(canonicalStaging, 'r')
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size < 1 || stat.size > LOCAL_ASSET_LIMITS.maxFileBytes) {
        throw new LocalAssetWorkerError('staging_unavailable', '导入暂存文件不可用')
      }
      const hash = createHash('sha256')
      const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES)
      let offset = 0
      while (offset < stat.size) {
        this.assertSessionActive(item.session_id)
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
    const stagingThumbnail = this.paths.stagingThumbnailPath(sessionId, itemId)
    const finalSource = this.paths.resolveAssetSource(assetId, sourceRelativePath)
    const finalThumbnail = this.paths.resolveAssetThumbnail(assetId, thumbnailRelativePath)
    const canonicalStagingSource = await this.paths.assertOwnedRegularFile(
      item.staging_rel_path,
      { scope: 'staging', sessionId, itemId }
    )
    const canonicalStagingThumbnail = await this.paths.assertInternalRegularFile(stagingThumbnail)
    await this.paths.assertCanonicalParent(finalSource)
    await this.paths.assertCanonicalParent(finalThumbnail)
    this.repository.prepareAssetCommit({
      itemId,
      assetId,
      sourceRelativePath,
      thumbnailRelativePath
    })
    let sourceMoved = false
    let thumbnailMoved = false
    try {
      await rename(canonicalStagingSource, finalSource)
      sourceMoved = true
      await rename(canonicalStagingThumbnail, finalThumbnail)
      thumbnailMoved = true
      return this.repository.finishAssetCommit(assetId, itemId)
    } catch (error) {
      if (thumbnailMoved) await rename(finalThumbnail, canonicalStagingThumbnail).catch(() => undefined)
      if (sourceMoved) await rename(finalSource, canonicalStagingSource).catch(() => undefined)
      const code = errorCode(error) === 'import_failed' ? 'write_failed' : errorCode(error)
      this.repository.rollbackAssetCommit(assetId, itemId, code)
      throw error
    }
  }

  private async reconcileCommittingAssets(): Promise<void> {
    for (const asset of this.repository.listStored('committing')) {
      const item = this.repository.findImportItemByAssetId(asset.id)
      const finalSource = await this.inspectOwnedFile(asset.sourceRelativePath, {
        scope: 'originals', assetId: asset.id
      })
      const finalThumbnail = await this.inspectOwnedFile(asset.thumbnailRelativePath, {
        scope: 'thumbnails', assetId: asset.id
      })
      if (finalSource.kind === 'unsafe' || finalThumbnail.kind === 'unsafe') {
        this.repository.rollbackAssetCommit(asset.id, item?.id ?? asset.id, 'recovery_failed')
        continue
      }
      if (finalSource.kind === 'regular' && finalThumbnail.kind === 'regular' && item) {
        this.repository.finishAssetCommit(asset.id, item.id)
        continue
      }
      if (item?.staging_rel_path) {
        const stagingSource = await this.inspectOwnedFile(item.staging_rel_path, {
          scope: 'staging', sessionId: item.session_id, itemId: item.id
        })
        const stagingThumbnail = this.paths.stagingThumbnailPath(item.session_id, item.id)
        const stagedThumbnail = await this.inspectInternalFile(stagingThumbnail)
        if (stagingSource.kind === 'unsafe' || stagedThumbnail.kind === 'unsafe') {
          this.repository.rollbackAssetCommit(asset.id, item.id, 'recovery_failed')
          continue
        }
        if (finalSource.kind === 'regular' && stagingSource.kind === 'missing') {
          const target = this.paths.resolveStagingItem(
            item.session_id,
            item.id,
            item.staging_rel_path
          )
          await mkdir(dirname(target), { recursive: true })
          await this.paths.assertCanonicalParent(target)
          await rename(finalSource.path, target)
        }
        if (finalThumbnail.kind === 'regular' && stagedThumbnail.kind === 'missing') {
          await mkdir(dirname(stagingThumbnail), { recursive: true })
          await this.paths.assertCanonicalParent(stagingThumbnail)
          await rename(finalThumbnail.path, stagingThumbnail)
        }
      } else {
        await Promise.all([
          finalSource.kind === 'regular' ? rm(finalSource.path, { force: true }) : Promise.resolve(),
          finalThumbnail.kind === 'regular'
            ? rm(finalThumbnail.path, { force: true })
            : Promise.resolve()
        ])
      }
      this.repository.rollbackAssetCommit(asset.id, item?.id ?? asset.id, 'recovery_failed')
    }
  }

  private async inspectOwnedFile(
    relativePath: string,
    owner: LocalAssetPathOwner
  ): Promise<{ kind: 'regular'; path: string } | { kind: 'missing' | 'unsafe' }> {
    try {
      return { kind: 'regular', path: await this.paths.assertOwnedRegularFile(relativePath, owner) }
    } catch (error) {
      return this.pathInspectionFailure(error)
    }
  }

  private async inspectInternalFile(
    absolutePath: string
  ): Promise<{ kind: 'regular'; path: string } | { kind: 'missing' | 'unsafe' }> {
    try {
      return { kind: 'regular', path: await this.paths.assertInternalRegularFile(absolutePath) }
    } catch (error) {
      return this.pathInspectionFailure(error)
    }
  }

  private pathInspectionFailure(
    error: unknown
  ): { kind: 'missing' | 'unsafe' } {
    return error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'unsafe' }
  }

  private async recoverDeletion(
    sourcePath: string,
    thumbnailPath: string,
    sourceBackup: Buffer,
    thumbnailBackup: Buffer,
    sourceTrash?: string,
    thumbnailTrash?: string
  ): Promise<void> {
    await this.restoreDeletionFile(sourcePath, sourceBackup)
    await this.restoreDeletionFile(thumbnailPath, thumbnailBackup)
    await Promise.all([
      sourceTrash ? this.deletionFiles.rm(sourceTrash) : Promise.resolve(),
      thumbnailTrash ? this.deletionFiles.rm(thumbnailTrash) : Promise.resolve()
    ])
  }

  private async restoreDeletionFile(filePath: string, data: Buffer): Promise<void> {
    try {
      await this.deletionFiles.restore(filePath, data)
    } catch {
      await this.deletionFiles.rm(filePath)
      await this.deletionFiles.restore(filePath, data)
    }
  }
}
