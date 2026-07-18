import { IPC_CHANNELS } from '../shared/ipc'
import type { DesktopApi } from '../shared/types'
import { createLocalAssetApi, type LocalAssetIpcInvoker } from './local-asset-api'

/** Composes the complete renderer-safe Electron surface from a single IPC-only dependency. */
export function createDesktopApi(invoker: LocalAssetIpcInvoker): DesktopApi {
  return {
    library: {
      list: (filter = 'all') => invoker.invoke(IPC_CHANNELS.libraryList, filter) as ReturnType<DesktopApi['library']['list']>,
      save: (records) => invoker.invoke(IPC_CHANNELS.librarySave, records) as ReturnType<DesktopApi['library']['save']>,
      toggleFavorite: (id, favorite) =>
        invoker.invoke(IPC_CHANNELS.libraryFavorite, id, favorite) as ReturnType<DesktopApi['library']['toggleFavorite']>,
      delete: (id) => invoker.invoke(IPC_CHANNELS.libraryDelete, id) as ReturnType<DesktopApi['library']['delete']>,
      clearHistory: () => invoker.invoke(IPC_CHANNELS.libraryClearHistory) as ReturnType<DesktopApi['library']['clearHistory']>
    },
    clipboard: {
      writeImage: (dataUrl) => invoker.invoke(IPC_CHANNELS.clipboardWriteImage, dataUrl) as ReturnType<DesktopApi['clipboard']['writeImage']>,
      writeText: (value) => invoker.invoke(IPC_CHANNELS.clipboardWriteText, value) as ReturnType<DesktopApi['clipboard']['writeText']>
    },
    dialog: {
      saveImage: (dataUrl, suggestedName) =>
        invoker.invoke(IPC_CHANNELS.dialogSaveImage, dataUrl, suggestedName) as ReturnType<DesktopApi['dialog']['saveImage']>
    },
    app: {
      getInfo: () => invoker.invoke(IPC_CHANNELS.appGetInfo) as ReturnType<DesktopApi['app']['getInfo']>
    },
    renderSettings: {
      get: () => invoker.invoke(IPC_CHANNELS.renderSettingsGet) as ReturnType<DesktopApi['renderSettings']['get']>,
      save: (settings) => invoker.invoke(IPC_CHANNELS.renderSettingsSave, settings) as ReturnType<DesktopApi['renderSettings']['save']>
    },
    runtime: {
      getSettings: () => invoker.invoke(IPC_CHANNELS.runtimeGetSettings) as ReturnType<DesktopApi['runtime']['getSettings']>,
      saveSettings: (settings) =>
        invoker.invoke(IPC_CHANNELS.runtimeSaveSettings, settings) as ReturnType<DesktopApi['runtime']['saveSettings']>,
      discover: (settings) => invoker.invoke(IPC_CHANNELS.runtimeDiscover, settings) as ReturnType<DesktopApi['runtime']['discover']>,
      start: (settings) => invoker.invoke(IPC_CHANNELS.runtimeStart, settings) as ReturnType<DesktopApi['runtime']['start']>,
      generate: (request) => invoker.invoke(IPC_CHANNELS.runtimeGenerate, request) as ReturnType<DesktopApi['runtime']['generate']>
    },
    localAssets: createLocalAssetApi(invoker)
  }
}
