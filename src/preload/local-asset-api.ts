import type { LocalAssetApi } from '../shared/local-assets'
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

/** Creates the typed preload surface without exposing Node, Electron, or managed paths. */
export function createLocalAssetApi(invoker: LocalAssetIpcInvoker): LocalAssetApi {
  return {
    list: () => invokeLocalAsset(invoker, LOCAL_ASSET_IPC_CHANNELS.list),
    beginImport: (request) =>
      invokeLocalAsset(invoker, LOCAL_ASSET_IPC_CHANNELS.beginImport, request),
    getImportSession: (request) =>
      invokeLocalAsset(invoker, LOCAL_ASSET_IPC_CHANNELS.getImportSession, request),
    retryImportItems: (request) =>
      invokeLocalAsset(invoker, LOCAL_ASSET_IPC_CHANNELS.retryImportItems, request),
    cancelImport: (request) =>
      invokeLocalAsset(invoker, LOCAL_ASSET_IPC_CHANNELS.cancelImport, request),
    updateMetadata: (request) =>
      invokeLocalAsset(invoker, LOCAL_ASSET_IPC_CHANNELS.updateMetadata, request),
    delete: (request) => invokeLocalAsset(invoker, LOCAL_ASSET_IPC_CHANNELS.delete, request)
  }
}
