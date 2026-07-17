import {
  normalizeLocalAssetId,
  type GenerateLocalPostersRequest,
  type LocalAssetErrorCode,
  type LocalAssetResult,
  type LocalPosterBatchDto,
  type LocalPosterCandidateDto
} from '../shared/local-assets'
import { LocalAssetIndex } from './local-asset-index'
import { LocalAssetPathService } from './local-asset-paths'
import { LocalAssetRepository, type StoredLocalAsset } from './local-asset-repository'
import { LocalAssetWorkerError, type LocalAssetWorkerPool } from './local-asset-worker'

const PNG_DATA_URL_PREFIX = 'data:image/png;base64,'
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const MAX_RENDERED_PNG_BYTES = 10 * 1024 * 1024

interface SelectedLocalAsset {
  asset: StoredLocalAsset
  matchedTags: string[]
}

function failure<T>(
  code: LocalAssetErrorCode,
  message: string,
  retryable = false
): LocalAssetResult<T> {
  return { ok: false, error: { code, message, retryable } }
}

function isPng(value: Buffer): boolean {
  return value.length >= PNG_SIGNATURE.length &&
    value.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
}

/**
 * Owns the local-only poster batch boundary. Asset selection and canonical path
 * checks stay in the main process; Sharp runs only through the isolated pool.
 */
export class LocalPosterGenerator {
  private active = false

  constructor(
    private readonly repository: LocalAssetRepository,
    private readonly index: LocalAssetIndex,
    private readonly paths: LocalAssetPathService,
    private readonly workers: LocalAssetWorkerPool
  ) {}

  async generate(
    request: GenerateLocalPostersRequest
  ): Promise<LocalAssetResult<LocalPosterBatchDto>> {
    if (this.active) {
      return failure('generation_busy', '已有本地素材批次正在生成，请稍候', true)
    }
    const selected = this.selectAssets(request)
    if (!selected.ok) return selected

    this.active = true
    try {
      const renderedCandidates = await Promise.allSettled(selected.value.map(async (
        selection,
        variant
      ) => {
        const sourcePath = await this.paths.assertOwnedRegularFile(
          selection.asset.sourceRelativePath,
          { scope: 'originals', assetId: selection.asset.id }
        )
        const rendered = await this.workers.renderPoster({
          filePath: sourcePath,
          caption: request.caption,
          embedCaption: request.embedCaption,
          variant
        })
        if (
          rendered.png.length === 0 ||
          rendered.png.length > MAX_RENDERED_PNG_BYTES ||
          !isPng(rendered.png)
        ) {
          throw new LocalAssetWorkerError('generation_failed', '本地海报输出不是有效 PNG')
        }
        return {
          assetId: selection.asset.id,
          assetNameSnapshot: selection.asset.displayName,
          matchedTags: [...selection.matchedTags],
          dataUrl: `${PNG_DATA_URL_PREFIX}${rendered.png.toString('base64')}`
        } satisfies LocalPosterCandidateDto
      }))
      const failedCandidate = renderedCandidates.find(({ status }) => status === 'rejected')
      if (failedCandidate?.status === 'rejected') throw failedCandidate.reason
      const candidates = renderedCandidates.map((result) => {
        if (result.status === 'rejected') throw result.reason
        return result.value
      })
      const totalReadyAssets = this.repository.countReady()
      return {
        ok: true,
        value: {
          candidates,
          totalReadyAssets,
          ...(request.matchMode === 'automatic' && candidates.length < 9
            ? {
                shortageReason: candidates.length === 0 && request.excludedAssetIds.length > 0
                  ? 'no_more' as const
                  : totalReadyAssets < 9 ? 'library' as const : 'matching' as const
              }
            : {})
        }
      }
    } catch (error) {
      const code = error instanceof LocalAssetWorkerError
        ? error.code
        : 'generation_failed'
      return failure(
        code,
        error instanceof Error ? error.message : '本地海报生成失败',
        code === 'processing_timeout' || code === 'processing_crashed' || code === 'generation_failed'
      )
    } finally {
      this.active = false
    }
  }

  private selectAssets(
    request: GenerateLocalPostersRequest
  ): LocalAssetResult<SelectedLocalAsset[]> {
    if (request.matchMode === 'automatic') {
      if (request.selectedAssetIds.length > 0) {
        return failure('invalid_request', '自动匹配不能携带手动素材')
      }
      const excludedIds = new Set(request.excludedAssetIds)
      const matches = this.index.match(request.prompt, { limit: 9, excludedIds })
      const assets: SelectedLocalAsset[] = []
      for (const match of matches) {
        const asset = this.repository.getStoredAsset(match.asset.id)
        if (!asset || asset.state !== 'ready') {
          return failure('asset_not_ready', '匹配素材已被删除或不可用')
        }
        assets.push({ asset, matchedTags: match.matchedTags })
      }
      return { ok: true, value: assets }
    }

    if (
      request.selectedAssetIds.length < 1 ||
      request.selectedAssetIds.length > 9 ||
      request.excludedAssetIds.length > 0 ||
      new Set(request.selectedAssetIds).size !== request.selectedAssetIds.length
    ) {
      return failure('invalid_request', '手动选图必须包含 1–9 张互不重复的素材')
    }
    const assets: SelectedLocalAsset[] = []
    for (const candidateId of request.selectedAssetIds) {
      const assetId = normalizeLocalAssetId(candidateId)
      const asset = assetId ? this.repository.getStoredAsset(assetId) : undefined
      if (!asset || asset.state !== 'ready') {
        return failure('asset_not_ready', '所选素材已被删除或不可用，请重新选择')
      }
      assets.push({ asset, matchedTags: [] })
    }
    return { ok: true, value: assets }
  }
}
