import type {
  LocalAssetApi,
  LocalAssetDto,
  LocalAssetOperationError,
  LocalAssetResult,
  LocalAssetTagDto,
  LocalImportFinalizeResultDto,
  LocalImportItemDto,
  LocalImportSessionDto
} from '../shared/local-assets'
import {
  LOCAL_ASSET_IPC_CHANNELS,
  type LocalAssetIpcChannel,
  type LocalAssetIpcRequest,
  type LocalAssetIpcResponse
} from '../shared/local-asset-ipc'

export interface LocalAssetIpcInvoker {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
}

function invokeLocalAsset<T extends LocalAssetIpcChannel>(
  invoker: LocalAssetIpcInvoker,
  channel: T,
  ...args: LocalAssetIpcRequest<T>
): Promise<LocalAssetIpcResponse<T>> {
  return invoker.invoke(channel, ...args) as Promise<LocalAssetIpcResponse<T>>
}

function projectTag(tag: LocalAssetTagDto): LocalAssetTagDto {
  return { displayValue: tag.displayValue, normalizedValue: tag.normalizedValue }
}

function projectError(error: LocalAssetOperationError): LocalAssetOperationError {
  return { code: error.code, message: error.message, retryable: error.retryable }
}

function projectResult<T, U>(
  result: LocalAssetResult<T>,
  project: (value: T) => U
): LocalAssetResult<U> {
  return result.ok
    ? { ok: true, value: project(result.value) }
    : { ok: false, error: projectError(result.error) }
}

function projectAsset(asset: LocalAssetDto): LocalAssetDto {
  return {
    id: asset.id,
    displayName: asset.displayName,
    originalFilename: asset.originalFilename,
    mimeType: asset.mimeType,
    width: asset.width,
    height: asset.height,
    sizeBytes: asset.sizeBytes,
    tags: asset.tags.map(projectTag),
    thumbnailUrl: asset.thumbnailUrl,
    rightsAssertedAt: asset.rightsAssertedAt,
    importedAt: asset.importedAt,
    updatedAt: asset.updatedAt
  }
}

function projectItem(item: LocalImportItemDto): LocalImportItemDto {
  return {
    id: item.id,
    originalFilename: item.originalFilename,
    state: item.state,
    ...(item.displayName !== undefined ? { displayName: item.displayName } : {}),
    tags: item.tags.map(projectTag),
    ...(item.mimeType !== undefined ? { mimeType: item.mimeType } : {}),
    ...(item.width !== undefined ? { width: item.width } : {}),
    ...(item.height !== undefined ? { height: item.height } : {}),
    ...(item.sizeBytes !== undefined ? { sizeBytes: item.sizeBytes } : {}),
    ...(item.finalizedAt !== undefined ? { finalizedAt: item.finalizedAt } : {}),
    ...(item.error !== undefined ? { error: projectError(item.error) } : {}),
    ...(item.duplicateAssetId !== undefined
      ? { duplicateAssetId: item.duplicateAssetId }
      : {}),
    ...(item.importedAssetId !== undefined ? { importedAssetId: item.importedAssetId } : {})
  }
}

function projectSession(session: LocalImportSessionDto): LocalImportSessionDto {
  return {
    id: session.id,
    sourceKind: session.sourceKind,
    state: session.state,
    items: session.items.map(projectItem),
    rightsAssertedAt: session.rightsAssertedAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  }
}

function projectFinalizeResult(
  result: LocalImportFinalizeResultDto
): LocalImportFinalizeResultDto {
  return {
    session: projectSession(result.session),
    finalizedItemIds: [...result.finalizedItemIds],
    rejectedItems: result.rejectedItems.map((rejection) => ({
      itemId: rejection.itemId,
      error: projectError(rejection.error)
    }))
  }
}

/** Creates the typed preload surface without exposing Node, Electron, or managed paths. */
export function createLocalAssetApi(invoker: LocalAssetIpcInvoker): LocalAssetApi {
  return {
    list: async () => projectResult(
      await invokeLocalAsset(invoker, LOCAL_ASSET_IPC_CHANNELS.list),
      (assets) => assets.map(projectAsset)
    ),
    beginImport: async (request) => projectResult(
      await invokeLocalAsset(invoker, LOCAL_ASSET_IPC_CHANNELS.beginImport, request),
      projectSession
    ),
    getImportSession: async (request) => projectResult(
      await invokeLocalAsset(invoker, LOCAL_ASSET_IPC_CHANNELS.getImportSession, request),
      projectSession
    ),
    retryImportItems: async (request) => projectResult(
      await invokeLocalAsset(invoker, LOCAL_ASSET_IPC_CHANNELS.retryImportItems, request),
      projectSession
    ),
    cancelImport: async (request) => projectResult(
      await invokeLocalAsset(invoker, LOCAL_ASSET_IPC_CHANNELS.cancelImport, request),
      projectSession
    ),
    updateImportDraft: async (request) => projectResult(
      await invokeLocalAsset(invoker, LOCAL_ASSET_IPC_CHANNELS.updateImportDraft, request),
      projectItem
    ),
    finalizeImport: async (request) => projectResult(
      await invokeLocalAsset(invoker, LOCAL_ASSET_IPC_CHANNELS.finalizeImport, request),
      projectFinalizeResult
    ),
    updateMetadata: async (request) => projectResult(
      await invokeLocalAsset(invoker, LOCAL_ASSET_IPC_CHANNELS.updateMetadata, request),
      projectAsset
    ),
    delete: async (request) => projectResult(
      await invokeLocalAsset(invoker, LOCAL_ASSET_IPC_CHANNELS.delete, request),
      () => undefined
    )
  }
}
