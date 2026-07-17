import type {
  BeginLocalImportRequest,
  CancelLocalImportRequest,
  DeleteLocalAssetRequest,
  GetLocalImportSessionRequest,
  LocalAssetDto,
  LocalAssetResult,
  LocalImportSessionDto,
  RetryLocalImportItemsRequest,
  UpdateLocalAssetMetadataRequest
} from '../shared/local-assets'
import { normalizeLocalAssetId } from '../shared/local-assets'
import { LOCAL_ASSET_IPC_CHANNELS } from '../shared/local-asset-ipc'

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown

export interface LocalAssetIpcRegistrar {
  handle: (channel: string, handler: IpcHandler) => void
}

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
  updateMetadata: (
    request: UpdateLocalAssetMetadataRequest
  ) => Promise<LocalAssetResult<LocalAssetDto>>
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

function isBeginImportRequest(value: unknown): value is BeginLocalImportRequest {
  return isObject(value) &&
    (value.sourceKind === 'files' || value.sourceKind === 'directory') &&
    value.rightsConfirmed === true
}

function normalizeRetryRequest(value: unknown): RetryLocalImportItemsRequest | undefined {
  const sessionId = readUuid(value, 'sessionId')
  if (!sessionId || !isObject(value) || !Array.isArray(value.itemIds)) return undefined
  const normalizedIds = value.itemIds.map((id) =>
    typeof id === 'string' ? normalizeLocalAssetId(id) : undefined
  )
  if (
    normalizedIds.length < 1 ||
    normalizedIds.length > 500 ||
    normalizedIds.some((id) => id === undefined) ||
    new Set(normalizedIds).size !== normalizedIds.length
  ) return undefined
  return { sessionId, itemIds: normalizedIds as string[] }
}

function normalizeUpdateRequest(value: unknown): UpdateLocalAssetMetadataRequest | undefined {
  const assetId = readUuid(value, 'assetId')
  if (!assetId || !isObject(value) || typeof value.displayName !== 'string' ||
    !Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === 'string')) {
    return undefined
  }
  return { assetId, displayName: value.displayName, tags: value.tags }
}

export function registerLocalAssetIpcHandlers(
  registrar: LocalAssetIpcRegistrar,
  service: LocalAssetIpcService
): void {
  registrar.handle(LOCAL_ASSET_IPC_CHANNELS.list, () => service.list())
  registrar.handle(LOCAL_ASSET_IPC_CHANNELS.beginImport, (_event, value) =>
    isBeginImportRequest(value) ? service.beginImport(value) : invalidRequest()
  )
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
  registrar.handle(LOCAL_ASSET_IPC_CHANNELS.updateMetadata, (_event, value) => {
    const request = normalizeUpdateRequest(value)
    return request ? service.updateMetadata(request) : invalidRequest()
  })
  registrar.handle(LOCAL_ASSET_IPC_CHANNELS.delete, (_event, value) => {
    const assetId = readUuid(value, 'assetId')
    return assetId ? service.delete({ assetId }) : invalidRequest()
  })
}
