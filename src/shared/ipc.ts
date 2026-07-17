export const IPC_CHANNELS = {
  libraryList: 'library:list',
  librarySave: 'library:save',
  libraryFavorite: 'library:favorite',
  libraryDelete: 'library:delete',
  libraryClearHistory: 'library:clear-history',
  clipboardWriteImage: 'clipboard:write-image',
  clipboardWriteText: 'clipboard:write-text',
  dialogSaveImage: 'dialog:save-image',
  appGetInfo: 'app:get-info',
  renderSettingsGet: 'render-settings:get',
  renderSettingsSave: 'render-settings:save',
  runtimeGetSettings: 'runtime:get-settings',
  runtimeSaveSettings: 'runtime:save-settings',
  runtimeDiscover: 'runtime:discover',
  runtimeStart: 'runtime:start',
  runtimeGenerate: 'runtime:generate'
} as const

export { LOCAL_ASSET_IPC_CHANNELS } from './local-asset-ipc'
