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
} from './local-assets'

export const LOCAL_ASSET_IPC_CHANNELS = {
  list: 'local-assets:list',
  beginImport: 'local-assets:begin-import',
  getImportSession: 'local-assets:get-import-session',
  retryImportItems: 'local-assets:retry-import-items',
  cancelImport: 'local-assets:cancel-import',
  updateMetadata: 'local-assets:update-metadata',
  delete: 'local-assets:delete'
} as const

export interface LocalAssetIpcContract {
  'local-assets:list': {
    request: []
    response: LocalAssetResult<LocalAssetDto[]>
  }
  'local-assets:begin-import': {
    request: [BeginLocalImportRequest]
    response: LocalAssetResult<LocalImportSessionDto>
  }
  'local-assets:get-import-session': {
    request: [GetLocalImportSessionRequest]
    response: LocalAssetResult<LocalImportSessionDto>
  }
  'local-assets:retry-import-items': {
    request: [RetryLocalImportItemsRequest]
    response: LocalAssetResult<LocalImportSessionDto>
  }
  'local-assets:cancel-import': {
    request: [CancelLocalImportRequest]
    response: LocalAssetResult<LocalImportSessionDto>
  }
  'local-assets:update-metadata': {
    request: [UpdateLocalAssetMetadataRequest]
    response: LocalAssetResult<LocalAssetDto>
  }
  'local-assets:delete': {
    request: [DeleteLocalAssetRequest]
    response: LocalAssetResult<void>
  }
}

export type LocalAssetIpcChannel = keyof LocalAssetIpcContract
export type LocalAssetIpcRequest<T extends LocalAssetIpcChannel> =
  LocalAssetIpcContract[T]['request']
export type LocalAssetIpcResponse<T extends LocalAssetIpcChannel> =
  LocalAssetIpcContract[T]['response']
