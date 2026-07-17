import type { LocalAssetErrorCode, LocalAssetMimeType } from '../shared/local-assets'

export const LOCAL_ASSET_TEST_FIXTURE_VERSION = 1 as const

export type LocalAssetTestFixtureExpectedOutcome =
  | {
      kind: 'ready'
      contentSha256: string
      pixelSha256: string
    }
  | {
      kind: 'duplicate'
      errorCode: 'duplicate_content' | 'duplicate_pixels'
      duplicateAssetId: string
    }
  | {
      kind: 'failed'
      errorCode: LocalAssetErrorCode
    }

/**
 * Deterministic F1/F2 test input. Absolute paths remain main-process-only and
 * must point inside the test's disposable fixture directory.
 */
export interface LocalAssetTestFixtureItem {
  id: string
  sourcePath: string
  originalFilename: string
  displayName: string
  tags: string[]
  mimeType: LocalAssetMimeType
  expectedOutcome: LocalAssetTestFixtureExpectedOutcome
}

export interface LocalAssetTestFixtureManifest {
  version: typeof LOCAL_ASSET_TEST_FIXTURE_VERSION
  rightsAssertedAt: string
  items: LocalAssetTestFixtureItem[]
}

/** Allows tests to bypass native dialogs without adding a renderer IPC escape hatch. */
export interface LocalAssetTestFixtureSource {
  selectFiles: () => Promise<LocalAssetTestFixtureManifest | undefined>
  selectDirectory: () => Promise<LocalAssetTestFixtureManifest | undefined>
}
