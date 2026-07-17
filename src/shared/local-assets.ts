export const LOCAL_ASSET_LIMITS = {
  nameGraphemes: 60,
  minTags: 1,
  maxTags: 12,
  tagGraphemes: 20,
  maxReadyAssets: 500,
  maxScanItems: 5_000,
  maxFileBytes: 20 * 1024 * 1024,
  maxEdgePixels: 8_192,
  maxDecodedPixels: 40_000_000,
  reservedDiskBytes: 512 * 1024 * 1024
} as const

export const LOCAL_ASSET_ERROR_CODES = [
  'invalid_request',
  'feature_unavailable',
  'invalid_name',
  'tag_count_out_of_range',
  'invalid_tag',
  'duplicate_tag',
  'permission_denied',
  'unsupported_entry',
  'unsupported_type',
  'invalid_image',
  'file_too_large',
  'dimensions_too_large',
  'decoded_pixels_too_large',
  'animated_image_rejected',
  'read_failed',
  'write_failed',
  'thumbnail_failed',
  'processing_timeout',
  'processing_crashed',
  'scan_limit_reached',
  'library_capacity_reached',
  'insufficient_disk_space',
  'duplicate_content',
  'duplicate_pixels',
  'invalid_managed_path',
  'source_unavailable',
  'staging_unavailable',
  'import_session_not_found',
  'import_item_not_found',
  'invalid_import_state',
  'asset_not_found',
  'asset_not_ready',
  'import_failed',
  'recovery_failed',
  'delete_failed',
  'generation_busy',
  'generation_failed',
  'cancelled'
] as const

export type LocalAssetErrorCode = (typeof LOCAL_ASSET_ERROR_CODES)[number]
export type LocalAssetMimeType = 'image/png' | 'image/jpeg' | 'image/webp'
export type LocalAssetMatchMode = 'automatic' | 'manual'
export type LocalImportSourceKind = 'files' | 'directory'
export type LocalImportSessionState = 'active' | 'completed' | 'cancelled'
export type LocalImportItemState =
  | 'staged'
  | 'processing'
  | 'duplicate'
  | 'committing'
  | 'ready'
  | 'failed'
  | 'cancelled'

export interface LocalAssetOperationError {
  code: LocalAssetErrorCode
  message: string
  retryable: boolean
}

export type LocalAssetResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: LocalAssetOperationError }

export interface LocalAssetTagDto {
  displayValue: string
  normalizedValue: string
}

/** Renderer-safe asset metadata. Managed file-system paths and hashes are intentionally absent. */
export interface LocalAssetDto {
  id: string
  displayName: string
  originalFilename: string
  mimeType: LocalAssetMimeType
  width: number
  height: number
  sizeBytes: number
  tags: LocalAssetTagDto[]
  thumbnailUrl: string
  rightsAssertedAt: string
  importedAt: string
  updatedAt: string
}

export interface LocalImportItemDto {
  id: string
  originalFilename: string
  state: LocalImportItemState
  displayName?: string
  tags: LocalAssetTagDto[]
  mimeType?: LocalAssetMimeType
  width?: number
  height?: number
  sizeBytes?: number
  finalizedAt?: string
  error?: LocalAssetOperationError
  duplicateAssetId?: string
  importedAssetId?: string
}

export interface LocalImportSessionDto {
  id: string
  sourceKind: LocalImportSourceKind
  state: LocalImportSessionState
  items: LocalImportItemDto[]
  rightsAssertedAt: string
  createdAt: string
  updatedAt: string
}

export interface BeginLocalImportRequest {
  sourceKind: LocalImportSourceKind
  rightsConfirmed: true
}

export interface GetLocalImportSessionRequest {
  sessionId: string
}

export interface RetryLocalImportItemsRequest {
  sessionId: string
  itemIds: string[]
}

export interface CancelLocalImportRequest {
  sessionId: string
}

export interface UpdateLocalImportDraftRequest {
  sessionId: string
  itemId: string
  displayName: string
  tags: string[]
}

export interface FinalizeLocalImportRequest {
  sessionId: string
  itemIds: string[]
}

export interface LocalImportFinalizeRejectionDto {
  itemId: string
  error: LocalAssetOperationError
}

export interface LocalImportFinalizeResultDto {
  session: LocalImportSessionDto
  finalizedItemIds: string[]
  rejectedItems: LocalImportFinalizeRejectionDto[]
}

export interface UpdateLocalAssetMetadataRequest {
  assetId: string
  displayName: string
  tags: string[]
}

export interface DeleteLocalAssetRequest {
  assetId: string
}

export interface GenerateLocalPostersRequest {
  prompt: string
  caption: string
  embedCaption: boolean
  matchMode: LocalAssetMatchMode
  selectedAssetIds: string[]
  excludedAssetIds: string[]
}

export type LocalPosterShortageReason = 'library' | 'matching' | 'no_more'

export interface LocalPosterCandidateDto {
  assetId: string
  assetNameSnapshot: string
  matchedTags: string[]
  dataUrl: string
}

export interface LocalPosterBatchDto {
  candidates: LocalPosterCandidateDto[]
  totalReadyAssets: number
  shortageReason?: LocalPosterShortageReason
}

export interface LocalAssetApi {
  list: () => Promise<LocalAssetResult<LocalAssetDto[]>>
  beginImport: (
    request: BeginLocalImportRequest
  ) => Promise<LocalAssetResult<LocalImportSessionDto>>
  getImportSession: (
    request: GetLocalImportSessionRequest
  ) => Promise<LocalAssetResult<LocalImportSessionDto>>
  retryImportItems: (
    request: RetryLocalImportItemsRequest
  ) => Promise<LocalAssetResult<LocalImportSessionDto>>
  cancelImport: (
    request: CancelLocalImportRequest
  ) => Promise<LocalAssetResult<LocalImportSessionDto>>
  updateImportDraft: (
    request: UpdateLocalImportDraftRequest
  ) => Promise<LocalAssetResult<LocalImportItemDto>>
  finalizeImport: (
    request: FinalizeLocalImportRequest
  ) => Promise<LocalAssetResult<LocalImportFinalizeResultDto>>
  updateMetadata: (
    request: UpdateLocalAssetMetadataRequest
  ) => Promise<LocalAssetResult<LocalAssetDto>>
  generatePosters: (
    request: GenerateLocalPostersRequest
  ) => Promise<LocalAssetResult<LocalPosterBatchDto>>
  delete: (request: DeleteLocalAssetRequest) => Promise<LocalAssetResult<void>>
}

export interface LocalAssetMetadataValidationIssue {
  code: Extract<
    LocalAssetErrorCode,
    'invalid_name' | 'tag_count_out_of_range' | 'invalid_tag' | 'duplicate_tag'
  >
  field: 'displayName' | 'tags'
  tagIndex?: number
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export function normalizeLocalAssetId(value: string): string | undefined {
  const normalized = value.toLowerCase()
  return UUID_PATTERN.test(normalized) ? normalized : undefined
}

export function normalizeLocalAssetText(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .replace(/\p{Script=Latin}+/gu, (segment) => segment.toLowerCase())
}

export function countGraphemes(value: string): number {
  return [...graphemeSegmenter.segment(value)].length
}

export function validateLocalAssetMetadata(
  displayName: string,
  tags: readonly string[]
): LocalAssetMetadataValidationIssue[] {
  const issues: LocalAssetMetadataValidationIssue[] = []
  const normalizedName = displayName.normalize('NFKC').trim()
  const nameLength = countGraphemes(normalizedName)
  if (nameLength < 1 || nameLength > LOCAL_ASSET_LIMITS.nameGraphemes) {
    issues.push({ code: 'invalid_name', field: 'displayName' })
  }

  if (tags.length < LOCAL_ASSET_LIMITS.minTags || tags.length > LOCAL_ASSET_LIMITS.maxTags) {
    issues.push({ code: 'tag_count_out_of_range', field: 'tags' })
  }

  const normalizedTags = new Map<string, number>()
  tags.forEach((tag, tagIndex) => {
    const normalizedTag = normalizeLocalAssetText(tag)
    const length = countGraphemes(tag.normalize('NFKC').trim())
    if (length < 1 || length > LOCAL_ASSET_LIMITS.tagGraphemes) {
      issues.push({ code: 'invalid_tag', field: 'tags', tagIndex })
    }
    const duplicateIndex = normalizedTags.get(normalizedTag)
    if (normalizedTag && duplicateIndex !== undefined) {
      issues.push({ code: 'duplicate_tag', field: 'tags', tagIndex })
    } else if (normalizedTag) {
      normalizedTags.set(normalizedTag, tagIndex)
    }
  })

  return issues
}
