import type {
  BeginLocalImportRequest,
  CancelLocalImportRequest,
  DeleteLocalAssetRequest,
  FinalizeLocalImportRequest,
  GenerateLocalPostersRequest,
  GetLocalImportSessionRequest,
  LocalAssetDto,
  LocalAssetResult,
  LocalImportFinalizeResultDto,
  LocalImportItemDto,
  LocalImportSessionDto,
  LocalPosterBatchDto,
  RetryLocalImportItemsRequest,
  UpdateLocalAssetMetadataRequest,
  UpdateLocalImportDraftRequest
} from '../shared/local-assets'
import { normalizeLocalAssetId } from '../shared/local-assets'
import { LOCAL_ASSET_IPC_CHANNELS } from '../shared/local-asset-ipc'

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown

export interface LocalAssetIpcRegistrar {
  handle: (channel: string, handler: IpcHandler) => void
}

export const LOCAL_ASSET_IPC_PAYLOAD_LIMITS = {
  maxItemIds: 500,
  maxSelectedAssetIds: 9,
  maxPromptCodeUnits: 512,
  maxNameCodeUnits: 256,
  maxTagCount: 24,
  maxTagCodeUnits: 128
} as const

/** The F1 repository/importer implements this port; F0 keeps Electron outside its domain API. */
export interface LocalAssetIpcService {
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

function invalidRequest<T>(): LocalAssetResult<T> {
  return {
    ok: false,
    error: {
      code: 'invalid_request',
      message: '本地素材请求格式无效',
      retryable: false
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readUuid(value: unknown, property: string): string | undefined {
  if (!isObject(value) || typeof value[property] !== 'string') return undefined
  return normalizeLocalAssetId(value[property])
}

function isBoundedString(value: unknown, maxCodeUnits: number): value is string {
  return typeof value === 'string' && value.length <= maxCodeUnits
}

function isBoundedTags(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= LOCAL_ASSET_IPC_PAYLOAD_LIMITS.maxTagCount &&
    value.every((tag) => isBoundedString(tag, LOCAL_ASSET_IPC_PAYLOAD_LIMITS.maxTagCodeUnits))
}

function normalizeBeginImportRequest(value: unknown): BeginLocalImportRequest | undefined {
  if (!isObject(value) ||
    (value.sourceKind !== 'files' && value.sourceKind !== 'directory') ||
    value.rightsConfirmed !== true) return undefined
  return { sourceKind: value.sourceKind, rightsConfirmed: true }
}

function normalizeRetryRequest(value: unknown): RetryLocalImportItemsRequest | undefined {
  const sessionId = readUuid(value, 'sessionId')
  if (!sessionId || !isObject(value) || !Array.isArray(value.itemIds)) return undefined
  const normalizedIds = value.itemIds.map((id) =>
    typeof id === 'string' ? normalizeLocalAssetId(id) : undefined
  )
  if (
    normalizedIds.length < 1 ||
    normalizedIds.length > LOCAL_ASSET_IPC_PAYLOAD_LIMITS.maxItemIds ||
    normalizedIds.some((id) => id === undefined) ||
    new Set(normalizedIds).size !== normalizedIds.length
  ) return undefined
  return { sessionId, itemIds: normalizedIds as string[] }
}

function normalizeUpdateRequest(value: unknown): UpdateLocalAssetMetadataRequest | undefined {
  const assetId = readUuid(value, 'assetId')
  if (!assetId || !isObject(value) ||
    !isBoundedString(value.displayName, LOCAL_ASSET_IPC_PAYLOAD_LIMITS.maxNameCodeUnits) ||
    !isBoundedTags(value.tags)) {
    return undefined
  }
  return { assetId, displayName: value.displayName, tags: value.tags }
}

function normalizeDraftRequest(value: unknown): UpdateLocalImportDraftRequest | undefined {
  const sessionId = readUuid(value, 'sessionId')
  const itemId = readUuid(value, 'itemId')
  if (!sessionId || !itemId || !isObject(value) ||
    !isBoundedString(value.displayName, LOCAL_ASSET_IPC_PAYLOAD_LIMITS.maxNameCodeUnits) ||
    !isBoundedTags(value.tags)) return undefined
  return { sessionId, itemId, displayName: value.displayName, tags: value.tags }
}

function normalizeAssetIds(value: unknown, maximum: number): string[] | undefined {
  if (!Array.isArray(value) || value.length > maximum) return undefined
  const assetIds = value.map((assetId) =>
    typeof assetId === 'string' ? normalizeLocalAssetId(assetId) : undefined
  )
  if (assetIds.some((assetId) => assetId === undefined) ||
    new Set(assetIds).size !== assetIds.length) return undefined
  return assetIds as string[]
}

function normalizeGenerateRequest(value: unknown): GenerateLocalPostersRequest | undefined {
  if (!isObject(value) ||
    !isBoundedString(value.prompt, LOCAL_ASSET_IPC_PAYLOAD_LIMITS.maxPromptCodeUnits) ||
    !isBoundedString(value.caption, LOCAL_ASSET_IPC_PAYLOAD_LIMITS.maxPromptCodeUnits) ||
    typeof value.embedCaption !== 'boolean' ||
    (value.matchMode !== 'automatic' && value.matchMode !== 'manual')) return undefined
  const selectedAssetIds = normalizeAssetIds(
    value.selectedAssetIds,
    LOCAL_ASSET_IPC_PAYLOAD_LIMITS.maxSelectedAssetIds
  )
  const excludedAssetIds = normalizeAssetIds(
    value.excludedAssetIds,
    LOCAL_ASSET_IPC_PAYLOAD_LIMITS.maxItemIds
  )
  if (!selectedAssetIds || !excludedAssetIds || !value.prompt.trim() ||
    (value.embedCaption && !value.caption.trim()) ||
    (value.matchMode === 'automatic' && selectedAssetIds.length !== 0) ||
    (value.matchMode === 'manual' &&
      (selectedAssetIds.length < 1 || excludedAssetIds.length !== 0))) return undefined
  return {
    prompt: value.prompt.trim(),
    caption: value.caption,
    embedCaption: value.embedCaption,
    matchMode: value.matchMode,
    selectedAssetIds,
    excludedAssetIds
  }
}

function normalizeFinalizeRequest(value: unknown): FinalizeLocalImportRequest | undefined {
  const sessionId = readUuid(value, 'sessionId')
  if (!sessionId || !isObject(value) || !Array.isArray(value.itemIds)) return undefined
  const itemIds = value.itemIds.map((itemId) =>
    typeof itemId === 'string' ? normalizeLocalAssetId(itemId) : undefined
  )
  if (itemIds.length < 1 || itemIds.length > LOCAL_ASSET_IPC_PAYLOAD_LIMITS.maxItemIds ||
    itemIds.some((itemId) => itemId === undefined) || new Set(itemIds).size !== itemIds.length) {
    return undefined
  }
  return { sessionId, itemIds: itemIds as string[] }
}

export function registerLocalAssetIpcHandlers(
  registrar: LocalAssetIpcRegistrar,
  service: LocalAssetIpcService
): void {
  registrar.handle(LOCAL_ASSET_IPC_CHANNELS.list, () => service.list())
  registrar.handle(LOCAL_ASSET_IPC_CHANNELS.beginImport, (_event, value) => {
    const request = normalizeBeginImportRequest(value)
    return request ? service.beginImport(request) : invalidRequest()
  })
  registrar.handle(LOCAL_ASSET_IPC_CHANNELS.getImportSession, (_event, value) => {
    const sessionId = readUuid(value, 'sessionId')
    return sessionId ? service.getImportSession({ sessionId }) : invalidRequest()
  })
  registrar.handle(LOCAL_ASSET_IPC_CHANNELS.retryImportItems, (_event, value) => {
    const request = normalizeRetryRequest(value)
    return request ? service.retryImportItems(request) : invalidRequest()
  })
  registrar.handle(LOCAL_ASSET_IPC_CHANNELS.cancelImport, (_event, value) => {
    const sessionId = readUuid(value, 'sessionId')
    return sessionId ? service.cancelImport({ sessionId }) : invalidRequest()
  })
  registrar.handle(LOCAL_ASSET_IPC_CHANNELS.updateImportDraft, (_event, value) => {
    const request = normalizeDraftRequest(value)
    return request ? service.updateImportDraft(request) : invalidRequest()
  })
  registrar.handle(LOCAL_ASSET_IPC_CHANNELS.finalizeImport, (_event, value) => {
    const request = normalizeFinalizeRequest(value)
    return request ? service.finalizeImport(request) : invalidRequest()
  })
  registrar.handle(LOCAL_ASSET_IPC_CHANNELS.updateMetadata, (_event, value) => {
    const request = normalizeUpdateRequest(value)
    return request ? service.updateMetadata(request) : invalidRequest()
  })
  registrar.handle(LOCAL_ASSET_IPC_CHANNELS.generatePosters, (_event, value) => {
    const request = normalizeGenerateRequest(value)
    return request ? service.generatePosters(request) : invalidRequest()
  })
  registrar.handle(LOCAL_ASSET_IPC_CHANNELS.delete, (_event, value) => {
    const assetId = readUuid(value, 'assetId')
    return assetId ? service.delete({ assetId }) : invalidRequest()
  })
}

export function createUnavailableLocalAssetIpcService(): LocalAssetIpcService {
  const unavailable = async <T>(): Promise<LocalAssetResult<T>> => ({
    ok: false,
    error: {
      code: 'feature_unavailable',
      message: '本地素材功能尚未启用',
      retryable: false
    }
  })
  return {
    list: unavailable,
    beginImport: unavailable,
    getImportSession: unavailable,
    retryImportItems: unavailable,
    cancelImport: unavailable,
    updateImportDraft: unavailable,
    finalizeImport: unavailable,
    updateMetadata: unavailable,
    generatePosters: unavailable,
    delete: unavailable
  }
}
