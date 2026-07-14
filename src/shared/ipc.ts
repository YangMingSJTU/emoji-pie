export const IPC_CHANNELS = {
  libraryList: 'library:list',
  librarySave: 'library:save',
  libraryFavorite: 'library:favorite',
  libraryDelete: 'library:delete',
  libraryClearHistory: 'library:clear-history',
  clipboardWriteImage: 'clipboard:write-image',
  dialogSaveImage: 'dialog:save-image',
  appGetInfo: 'app:get-info',
  runtimeGetSettings: 'runtime:get-settings',
  runtimeSaveSettings: 'runtime:save-settings',
  runtimeDiscover: 'runtime:discover',
  runtimeStart: 'runtime:start',
  runtimeGenerate: 'runtime:generate'
} as const
