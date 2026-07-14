import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc'
import type { DesktopApi } from '../shared/types'

const api: DesktopApi = {
  library: {
    list: (filter = 'all') => ipcRenderer.invoke(IPC_CHANNELS.libraryList, filter),
    save: (records) => ipcRenderer.invoke(IPC_CHANNELS.librarySave, records),
    toggleFavorite: (id, favorite) =>
      ipcRenderer.invoke(IPC_CHANNELS.libraryFavorite, id, favorite),
    delete: (id) => ipcRenderer.invoke(IPC_CHANNELS.libraryDelete, id),
    clearHistory: () => ipcRenderer.invoke(IPC_CHANNELS.libraryClearHistory)
  },
  clipboard: {
    writeImage: (dataUrl) => ipcRenderer.invoke(IPC_CHANNELS.clipboardWriteImage, dataUrl)
  },
  dialog: {
    saveImage: (dataUrl, suggestedName) =>
      ipcRenderer.invoke(IPC_CHANNELS.dialogSaveImage, dataUrl, suggestedName)
  },
  app: {
    getInfo: () => ipcRenderer.invoke(IPC_CHANNELS.appGetInfo)
  },
  renderSettings: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.renderSettingsGet),
    save: (settings) => ipcRenderer.invoke(IPC_CHANNELS.renderSettingsSave, settings)
  },
  runtime: {
    getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.runtimeGetSettings),
    saveSettings: (settings) =>
      ipcRenderer.invoke(IPC_CHANNELS.runtimeSaveSettings, settings),
    discover: (settings) => ipcRenderer.invoke(IPC_CHANNELS.runtimeDiscover, settings),
    start: (settings) => ipcRenderer.invoke(IPC_CHANNELS.runtimeStart, settings),
    generate: (request) => ipcRenderer.invoke(IPC_CHANNELS.runtimeGenerate, request)
  }
}

contextBridge.exposeInMainWorld('emojiPie', api)
